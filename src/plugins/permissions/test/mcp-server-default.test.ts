import { describe, expect, it } from 'vitest';
import type { Execution, Thread, ToolCall } from '../../../core/types.js';
import { permissionPlugin } from '../../permissions.js';
import { assistantPayload, FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

describe('MCP server permission defaults', () => {
  it('uses the persisted server identity and keeps per-thread rules authoritative', async () => {
    const env = await setupRuntime(new FakeModel(() => response()), { plugins: [permissionPlugin] });
    const thread = env.createThread('runtime');
    try {
      const server = await env.runtime.createMcpServer({
        name: 'Test',
        transport: 'stdio',
        command: 'node',
        autoStart: false,
      });
      const route = async (method: string, path: string, body?: unknown) =>
        env.runtime
          .pluginHttpRoute('pico.permissions', method, path)!
          .handler({ body, query: new URLSearchParams(), origin: null });
      await expect(route('PUT', '/mcp-servers', { serverId: 'missing', enabled: true })).rejects.toThrow(
        'MCP server not found',
      );
      await route('PUT', '/mcp-servers', { serverId: server.id, enabled: true });
      const runtime = env.runtime as unknown as {
        executeToolCall(thread: Thread, call: ToolCall): Promise<Execution>;
        applyThreadToolOverrides(threadId: string, updates: Record<string, boolean>): void;
      };
      const prepare = (suffix: string) => {
        const modelId = `mcp-model-${suffix}`;
        const call = { id: `call-${suffix}`, name: 'echo', arguments: {} };
        const executionId = `${thread.id}:${modelId}:${call.id}`;
        env.store.createModelExecution(modelId, thread.id, 0);
        env.store.transitionExecution(modelId, 'running');
        env.store.commitModelStep({
          assistantRecordId: `${modelId}:assistant`,
          modelExecutionId: modelId,
          threadId: thread.id,
          payload: assistantPayload({ toolCalls: [call], batchId: `${modelId}:batch` }),
          toolCalls: [{ call, executionId, source: 'mcp', mcpTarget: { serverId: server.id, toolKey: 'echo' } }],
        });
        return { call, executionId };
      };
      runtime.applyThreadToolOverrides(thread.id, { echo: true });
      const first = prepare('allowed');
      const allowed = await runtime.executeToolCall(thread, first.call);
      expect(allowed.error).toMatch(/MCP server.*no longer connected/);
      expect(
        env.store.getPluginState<Record<string, unknown>>('pico.permissions', 'approvals', {})[first.executionId],
      ).toBeUndefined();

      await route('PUT', '/rules', { threadId: thread.id, toolName: 'echo', policy: 'deny' });
      const second = prepare('denied');
      const denied = await runtime.executeToolCall(thread, second.call);
      expect(denied.error).toMatch(/Denied by the current permission policy/);

      await route('PUT', '/rules', { threadId: thread.id, toolName: 'echo', policy: 'ask' });
      const third = prepare('ask');
      const pending = runtime.executeToolCall(thread, third.call);
      for (let i = 0; i < 50; i += 1) {
        if (
          env.store.getPluginState<Record<string, { status: string }>>('pico.permissions', 'approvals', {})[
            third.executionId
          ]
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(
        env.store.getPluginState<Record<string, { status: string }>>('pico.permissions', 'approvals', {})[
          third.executionId
        ]?.status,
      ).toBe('pending');
      await route('POST', '/approvals', { executionId: third.executionId, allow: false });
      expect((await pending).error).toMatch(/Denied by the user/);
      await route('PUT', '/mcp-servers', { serverId: server.id, enabled: false });
      expect(await route('GET', '/mcp-servers')).toEqual({ allowedMcpServers: {} });
    } finally {
      await env.cleanup();
    }
  });
});
