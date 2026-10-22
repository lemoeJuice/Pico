import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AssistantPayload, CanonicalRecord, Execution } from '../src/core/types.js';
import { PicoStore } from '../src/core/store.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import { permissionPlugin } from '../src/plugins/permissions.js';
import type { ModelAdapter, ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import type { ModelStageInput, ProjectionInput, StepInput, ToolBatchInput } from '../src/runtime/stages.js';
import { threadCanBeInterrupted } from '../src/web/thread-controls.js';
import { assistantPayload, deferred, FakeModel, response, setupRuntime } from './helpers.js';

interface PermissionApprovalForTest {
  executionId: string;
  threadId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  createdAt: string;
}

interface PermissionViewForTest {
  tools: Array<{ name: string; description: string; policy: 'allow' | 'ask' | 'deny' }>;
  approvals: PermissionApprovalForTest[];
}

async function permissionRequest<T>(
  runtime: PicoRuntime,
  method: string,
  path: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const route = runtime.pluginHttpRoute('pico.permissions', method, path);
  if (!route) throw new Error(`Permission plugin route ${method} ${path} is not registered.`);
  return (await route.handler({ body, query: query ?? new URLSearchParams(), origin: null })) as T;
}

function permissionView(runtime: PicoRuntime, threadId: string): Promise<PermissionViewForTest> {
  return permissionRequest(runtime, 'GET', '/threads', undefined, new URLSearchParams({ threadId }));
}

async function setPermission(
  runtime: PicoRuntime,
  threadId: string,
  toolName: string,
  policy: 'allow' | 'ask' | 'deny',
) {
  return permissionRequest(runtime, 'PUT', '/rules', { threadId, toolName, policy });
}

async function decidePermission(runtime: PicoRuntime, executionId: string, allow: boolean, rememberForThread = false) {
  return permissionRequest(runtime, 'POST', '/approvals', { executionId, allow, rememberForThread });
}

describe('durable Thread runtime invariants', () => {
  it('keeps framework compaction available without Rolling Context and rebuilds its projection after restart', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      response(
        callNumber === 1
          ? 'Earlier turns summary: objective alpha; verified result beta.'
          : 'Continued with the recent context.',
      ),
    );
    const env = await setupRuntime(model, { disabledBuiltinPlugins: ['pico.rolling-context'] });
    let runtime = env.runtime;
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      expect(runtime.commands.list()).toContainEqual(expect.objectContaining({ name: 'compact' }));
      for (let turn = 1; turn <= 4; turn += 1) {
        const user = env.store.appendCanonical(thread.id, `compact-user-${turn}`, 'message', {
          role: 'user',
          source: 'user',
          content: `request turn ${turn}`,
        });
        env.store.appendCanonical(thread.id, `compact-assistant-${turn}`, 'assistant', {
          content: `response turn ${turn}`,
          toolCalls: [],
          batchId: null,
          projectionThrough: user.record.seq,
          usage: null,
          model: 'test-model',
        });
      }

      const compact = await runtime.submit(thread.id, 'compact-without-plugin', '/compact');
      expect(compact.command?.text).toContain('Compacted 2 completed turn(s)');
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(4);
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
      ).toHaveLength(1);

      await runtime.shutdown();
      runtime = new PicoRuntime(env.store, {
        model,
        disabledBuiltinPlugins: ['pico.rolling-context'],
        pluginDirectory: join(env.directory, 'empty-plugins'),
      });
      await runtime.initialize();
      expect(runtime.commands.list()).toContainEqual(expect.objectContaining({ name: 'compact' }));
      await runtime.submit(thread.id, 'continue-after-compact-restart', 'Continue from the recent work.');
      await runtime.drain();

      const continuationPrompt = model.prompts.at(-1)!;
      const promptTurns = JSON.stringify(continuationPrompt.turns);
      expect(promptTurns).toContain('Earlier turns summary: objective alpha; verified result beta.');
      expect(promptTurns).toContain('request turn 3');
      expect(promptTurns).toContain('request turn 4');
      expect(promptTurns).not.toContain('request turn 1');
      expect(promptTurns).not.toContain('response turn 2');
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(5);
    } finally {
      await runtime.shutdown();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });

  it('automatically compacts eligible history before the next model request when the configured threshold is reached', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      response(callNumber === 1 ? 'Earlier turns summary: objective alpha; verified result beta.' : 'Continued safely.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      env.runtime.updateContextManagementSettings({ contextWindowTokens: 2_000, compactionThresholdTokens: 1_000 });
      for (let turn = 1; turn <= 4; turn += 1) {
        const user = env.store.appendCanonical(thread.id, `auto-compact-user-${turn}`, 'message', {
          role: 'user',
          source: 'user',
          content: `request turn ${turn}`,
        });
        env.store.appendCanonical(
          thread.id,
          `auto-compact-assistant-${turn}`,
          'assistant',
          assistantPayload({
            content: `response turn ${turn}`,
            projectionThrough: user.record.seq,
            usage: { inputTokens: 1_500, outputTokens: 10, totalTokens: 1_510 },
          }),
        );
      }

      await env.runtime.submit(thread.id, 'auto-compact-threshold', 'Continue from the recent work.');
      await env.runtime.drain();

      const records = env.store.listRecords(thread.id);
      expect(
        records.filter((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
      ).toHaveLength(1);
      expect(model.prompts).toHaveLength(2);
      const continuation = JSON.stringify(model.prompts.at(-1)?.turns);
      expect(continuation).toContain('Earlier turns summary: objective alpha; verified result beta.');
      expect(continuation).toContain('request turn 3');
      expect(continuation).not.toContain('request turn 1');
      expect(env.runtime.getThread(thread.id)?.state).not.toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('pauses an over-window request when recent-turn retention leaves no history eligible for compaction', async () => {
    const model = new FakeModel(() => response('This request must not be sent.'));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      env.runtime.updateContextManagementSettings({ contextWindowTokens: 1_000, compactionThresholdTokens: 500 });
      const user = env.store.appendCanonical(thread.id, 'over-window-user', 'message', {
        role: 'user',
        source: 'user',
        content: 'Keep this recent turn intact.',
      });
      env.store.appendCanonical(
        thread.id,
        'over-window-assistant',
        'assistant',
        assistantPayload({
          content: 'There is no older completed turn to summarize.',
          projectionThrough: user.record.seq,
          usage: { inputTokens: 1_500, outputTokens: 20, totalTokens: 1_520 },
        }),
      );

      await env.runtime.submit(thread.id, 'over-window-next-request', 'Continue.');
      await env.runtime.drain();

      expect(model.prompts).toHaveLength(0);
      expect(env.runtime.getThread(thread.id)).toMatchObject({
        state: 'paused',
        pauseReason: expect.stringContaining('no eligible history to compact'),
      });
    } finally {
      await env.cleanup();
    }
  });

  it('rejects stored semantic model options when their owner is disabled but permits empty options', async () => {
    const model = new FakeModel(() => response('completed without optional parameters'));
    const env = await setupRuntime(model);
    try {
      const configured = env.createThread();
      const selection = env.runtime.threadModelSelection(configured.id);
      env.store.setThreadModelSelection(configured.id, {
        ...selection,
        parameters: { ...selection.parameters, options: { legacySetting: 'keep' } },
      });
      await env.runtime.plugins.setEnabled('pico.model-parameters', false);
      await env.runtime.submit(configured.id, 'semantic-options-after-disable', 'Run with saved settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(0);
      expect(env.store.listExecutions(configured.id)).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.stringContaining('Model parameters are not supported'),
        }),
      );

      const plain = env.createThread();
      await env.runtime.submit(plain.id, 'empty-options-after-disable', 'Run with default settings.');
      await env.runtime.drain();
      expect(model.calls).toBe(1);
      expect(env.store.getThread(plain.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });

  it('publishes provider previews and persists the returned reasoning summary', async () => {
    let adapterCalled = false;
    const model: ModelAdapter = {
      async complete(_prompt, _settings, _signal, _onText, _requestTrace, onEvent) {
        adapterCalled = true;
        onEvent?.({ type: 'reasoning_summary.delta', delta: 'Checking the request.' });
        onEvent?.({
          type: 'tool_call.preview',
          index: 0,
          id: 'call-preview',
          name: 'read_file',
          argumentsText: '{"path":"notes.txt"}',
        });
        return {
          content: 'Done.',
          reasoningSummary: 'Checked the request and found the answer.',
          toolCalls: [],
          usage: null,
          model: 'test-model',
          finishReason: 'stop',
        };
      },
    };
    const env = await setupRuntime(model);
    env.runtime.updateModelSettings({ model: 'test-model' });
    const thread = env.createThread();
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = env.runtime.subscribe((event) => events.push(event));
    try {
      await env.runtime.submit(thread.id, 'preview-and-summary', 'Read a note.');
      await env.runtime.drain();

      expect(
        adapterCalled,
        JSON.stringify(env.store.listExecutions(thread.id).map((execution) => execution.error)),
      ).toBe(true);
      const previews = events.filter((event) => event.executionId && String(event.type).startsWith('model.'));
      expect(previews).toContainEqual({
        type: 'model.reasoning_summary.delta',
        threadId: thread.id,
        executionId: expect.any(String),
        delta: 'Checking the request.',
      });
      expect(previews).toContainEqual({
        type: 'model.tool_call.preview',
        threadId: thread.id,
        executionId: expect.any(String),
        index: 0,
        id: 'call-preview',
        name: 'read_file',
        argumentsText: '{"path":"notes.txt"}',
      });
      expect(env.store.modelOutputForThread(thread.id)?.payload).toMatchObject({
        reasoningSummary: 'Checked the request and found the answer.',
      });
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('persists opaque reasoning replay for the next prompt but omits it from public history', async () => {
    const reasoningReplay = [{ type: 'reasoning', id: 'rs_private', encrypted_content: 'opaque-payload' }];
    const prompts: ModelPrompt[] = [];
    const model: ModelAdapter = {
      async complete(prompt) {
        prompts.push(prompt);
        return {
          content: prompts.length === 1 ? 'First answer.' : 'Second answer.',
          ...(prompts.length === 1 ? { reasoningReplay } : {}),
          toolCalls: [],
          usage: null,
          model: 'test-model',
          finishReason: 'stop',
        };
      },
    };
    const env = await setupRuntime(model);
    env.runtime.updateModelSettings({ model: 'test-model' });
    const thread = env.createThread();
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = env.runtime.subscribe((event) => events.push(event));
    try {
      await env.runtime.submit(thread.id, 'reasoning-first', 'First question.');
      await env.runtime.drain();

      expect(env.store.modelOutputForThread(thread.id)?.payload).toMatchObject({ reasoningReplay });
      const firstSnapshot = env.runtime.getSnapshot(thread.id)!;
      expect(firstSnapshot.records.find((record) => record.kind === 'assistant')?.payload).not.toHaveProperty(
        'reasoningReplay',
      );
      const publicRecordEvent = events.find((event) => {
        const record = event.record as { kind?: string } | undefined;
        return event.type === 'record' && record?.kind === 'assistant';
      });
      expect(publicRecordEvent?.record).not.toHaveProperty('payload.reasoningReplay');

      await env.runtime.submit(thread.id, 'reasoning-second', 'Follow-up question.');
      await env.runtime.drain();
      expect(prompts[1]?.turns).toContainEqual(
        expect.objectContaining({ kind: 'message', role: 'assistant', reasoningReplay }),
      );
      const secondAssistant = env.store.modelOutputForThread(thread.id)!;
      const secondExecutionId = secondAssistant.id.replace(/:assistant$/, '');
      const diagnosticPrompt = env.runtime.getModelInputAttempts(thread.id, secondExecutionId)?.[0]?.promptSummary;
      expect(diagnosticPrompt?.turns.some((turn) => turn.kind === 'message' && turn.role === 'assistant')).toBe(true);
      const recordedPrompt = env.runtime.getModelInputAttempts(thread.id, secondExecutionId)?.[0]?.prompt;
      expect(recordedPrompt?.turns).toContainEqual(
        expect.objectContaining({ kind: 'message', role: 'assistant', content: 'First answer.' }),
      );
      expect(JSON.stringify(recordedPrompt)).not.toContain('opaque-payload');
      const diagnosticLog = env.store.listExecutionLog(secondExecutionId, 'model-input-requested');
      expect(JSON.stringify(diagnosticLog)).not.toContain('opaque-payload');
      expect(diagnosticLog[0]?.detail).not.toHaveProperty('prompt');
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('keeps model selections separate across provider switches, including existing saved settings', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      pluginDirectory: resolve(process.cwd(), 'plugins'),
    });
    try {
      // Simulate a pre-existing connection before provider model history was introduced.
      const legacy = { ...env.runtime.getModelSettings(), model: 'custom-api-model', apiKey: 'saved-api-key' };
      env.store.setSetting('model', legacy);
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('');
      env.runtime.updateModelSettings({ model: 'account-model' });
      expect(env.runtime.updateModelSettings({ provider: 'openai-compatible' }).model).toBe('custom-api-model');
      expect(env.runtime.getModelSettings().apiKey).toBe('saved-api-key');
      env.runtime.updateModelSettings({ model: 'other-api-model' });
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('account-model');
      expect(env.runtime.publicModelSettings().modelsByProvider).toEqual({
        'openai-compatible': 'other-api-model',
        'chatgpt-plan': 'account-model',
      });
      expect(() => env.runtime.updateModelSettings({ provider: 'unknown' })).toThrow('not registered');
      expect(env.runtime.publicModelSettings().model).toBe('account-model');
      expect(
        env.runtime.updateModelSettings({ provider: 'openai-compatible', model: 'explicit-api-model' }).model,
      ).toBe('explicit-api-model');
      expect(env.runtime.updateModelSettings({ provider: 'chatgpt-plan' }).model).toBe('account-model');
      expect(env.runtime.updateModelSettings({ provider: 'openai-compatible' }).model).toBe('explicit-api-model');
    } finally {
      await env.cleanup();
    }
  });

  it('can disable built-in workflow plugins through RuntimeOptions and the environment', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      disabledBuiltinPlugins: ['pico.collaboration'],
    });
    const disabledByOption = env.runtime.pluginInfo().plugins.map((plugin) => plugin.id);
    expect(disabledByOption).not.toContain('pico.collaboration');
    expect(env.runtime.tools.list().map((tool) => tool.name)).not.toContain('spawn_thread');
    await env.cleanup();

    const previous = process.env.PICO_DISABLED_PLUGINS;
    process.env.PICO_DISABLED_PLUGINS = ' pico.collaboration , pico.permissions ';
    const envDisabled = await setupRuntime(new FakeModel(() => response('unused')));
    try {
      const pluginIds = envDisabled.runtime.pluginInfo().plugins.map((plugin) => plugin.id);
      expect(pluginIds).not.toContain('pico.collaboration');
      expect(pluginIds).not.toContain('pico.permissions');
      expect(envDisabled.runtime.tools.list().map((tool) => tool.name)).not.toContain('spawn_thread');
    } finally {
      await envDisabled.cleanup();
      if (previous === undefined) delete process.env.PICO_DISABLED_PLUGINS;
      else process.env.PICO_DISABLED_PLUGINS = previous;
    }
  });

  it('loads the ChatGPT provider as a first-party plugin and keeps OAuth secrets private', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      pluginDirectory: resolve(process.cwd(), 'plugins'),
    });
    try {
      const info = env.runtime.pluginInfo();
      expect(info.plugins.some((plugin) => plugin.id === 'pico.chatgpt-plan')).toBe(true);
      expect(
        info.pipelines.some((pipeline) => pipeline.stage === 'model' && pipeline.pluginId === 'pico.chatgpt-plan'),
      ).toBe(false);
      expect(info.pages).toContainEqual(
        expect.objectContaining({ id: 'account', pluginId: 'pico.chatgpt-plan', entry: 'webui' }),
      );
      expect(info.providers).toContainEqual(expect.objectContaining({ id: 'chatgpt-plan' }));
      expect(env.runtime.availableCommands()).toContainEqual(expect.objectContaining({ name: 'chatgpt-provider' }));

      env.store.setPluginState('pico.chatgpt-plan', 'oauth', {
        hostId: 'urn:uuid:pico-test',
        clientId: 'oaiapp_pico_test',
        subject: 'chatgpt-user-1',
        email: 'pico-user@example.test',
        idToken: 'id-token-secret',
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      });
      const publicSettings = env.runtime.publicModelSettings();
      expect(JSON.stringify(publicSettings)).not.toContain('token-secret');
      expect(publicSettings.provider).toBe('openai-compatible');
    } finally {
      await env.cleanup();
    }
  });

  it('deduplicates Messages by ID and starts an idle Thread once', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      const first = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      const retry = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      await env.runtime.drain();

      expect(first.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });

  it('runs Chat Threads on Runtime coordination tools without attaching a workspace Executor', async () => {
    const model = new FakeModel(() => response('Ready for a conversation.'));
    const env = await setupRuntime(model);
    const thread = env.runtime.createThread(env.project.id, 'runtime', 'Chat');
    try {
      const status = await env.runtime.executorStatus(thread.id);
      await env.runtime.submit(thread.id, 'chat-mode-message', 'Hello');
      await env.runtime.drain();

      expect(thread.workspacePath).toBe('');
      expect(status).toMatchObject({ connected: true, kind: 'runtime', label: 'Chat' });
      expect(model.prompts[0]?.tools.map((tool) => tool.name)).toEqual([
        'workspace_info',
        'project_memory_record',
        'project_memory_search',
        'spawn_thread',
        'send_thread_message',
        'list_child_threads',
        'read_thread_history',
      ]);
      expect((await permissionView(env.runtime, thread.id)).tools.map((tool) => tool.name)).toEqual([
        'workspace_info',
        'project_memory_record',
        'project_memory_search',
        'spawn_thread',
        'send_thread_message',
        'list_child_threads',
        'read_thread_history',
      ]);
      expect(env.runtime.getSnapshot(thread.id)?.executions.map((execution) => execution.status)).toEqual([
        'completed',
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('lists native Thread tools without preparing a Container and filters disabled tools from model input', async () => {
    let invocations = 0;
    const nativeTool: PicoPlugin = {
      id: 'test.native-tool-toggle',
      name: 'Native Tool Toggle',
      version: '1',
      activate({ tools }) {
        tools.register(
          { name: 'optional_runtime_tool', description: 'An optional Runtime tool.', parameters: { type: 'object' } },
          async () => {
            invocations += 1;
            return 'done';
          },
        );
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'disabled-tool-call', name: 'optional_runtime_tool', arguments: {} }])
        : response('Ready.'),
    );
    const env = await setupRuntime(model, { plugins: [nativeTool] });
    const hostThread = env.createThread('host');
    const containerThread = env.runtime.createThread(env.project.id, 'container', 'Container thread');
    const containerExecutor = (env.runtime as unknown as { containerExecutor: { listTools: () => Promise<unknown> } })
      .containerExecutor;
    const listContainerTools = vi.spyOn(containerExecutor, 'listTools');
    try {
      const containerTools = await env.runtime.listThreadTools(containerThread.id);
      expect(listContainerTools).not.toHaveBeenCalled();
      expect(containerTools.map((tool) => tool.name)).toContain('optional_runtime_tool');
      expect(containerTools.find((tool) => tool.name === 'read_file')).toMatchObject({
        source: 'executor',
        enabled: true,
      });
      expect(
        env.runtime
          .pluginInfo()
          .ui.filter((item) => item.pluginId === 'pico.permissions')
          .map((item) => item.slot),
      ).toEqual(['thread.toolbar', 'tool.result']);

      expect(
        (await env.runtime.listThreadTools(hostThread.id)).find((tool) => tool.name === 'optional_runtime_tool')
          ?.enabled,
      ).toBe(true);
      const disabled = await env.runtime.setThreadToolEnabled(hostThread.id, 'optional_runtime_tool', false);
      expect(disabled.find((tool) => tool.name === 'optional_runtime_tool')?.enabled).toBe(false);

      await env.runtime.submit(hostThread.id, 'tool-toggle-message', 'Continue without the optional tool.');
      await env.runtime.drain();
      expect(model.prompts[0]?.tools.some((tool) => tool.name === 'optional_runtime_tool')).toBe(false);
      expect(invocations).toBe(0);
      expect(env.store.listExecutions(hostThread.id).find((execution) => execution.kind === 'tool')).toMatchObject({
        status: 'failed',
        error: 'Tool “optional_runtime_tool” is disabled in this Thread.',
      });
      expect(
        (await env.runtime.listThreadTools(hostThread.id)).find((tool) => tool.name === 'optional_runtime_tool')
          ?.enabled,
      ).toBe(false);
      expect(
        (await env.runtime.listThreadTools(containerThread.id)).find((tool) => tool.name === 'optional_runtime_tool')
          ?.enabled,
      ).toBe(true);
      const enabled = await env.runtime.setThreadToolEnabled(hostThread.id, 'optional_runtime_tool', true);
      expect(enabled.find((tool) => tool.name === 'optional_runtime_tool')?.enabled).toBe(true);
      await env.runtime.submit(hostThread.id, 'tool-toggle-message-enabled', 'Continue with the optional tool.');
      await env.runtime.drain();
      expect(model.prompts[2]?.tools.some((tool) => tool.name === 'optional_runtime_tool')).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('uses Runtime tools for ordinary Thread-to-Thread Messages in Chat mode', async () => {
    let recipientId = '';
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [
            {
              id: 'chat-send-message',
              name: 'send_thread_message',
              arguments: { thread_id: recipientId, message: 'A note from the Chat Thread.' },
            },
          ])
        : response('Received.'),
    );
    const env = await setupRuntime(model);
    const sender = env.runtime.createThread(env.project.id, 'runtime', 'Chat sender');
    const recipient = env.runtime.createThread(env.project.id, 'runtime', 'Chat recipient');
    recipientId = recipient.id;
    try {
      await env.runtime.submit(sender.id, 'chat-tool-message', 'Send a message to the other Thread.');
      await env.runtime.drain();

      expect(
        env.store
          .listRecords(recipient.id)
          .some(
            (record) =>
              record.kind === 'message' &&
              record.payload.content === 'A note from the Chat Thread.' &&
              record.payload.senderThreadId === sender.id,
          ),
      ).toBe(true);
      expect(
        env.store
          .listExecutions(sender.id)
          .some((execution) => execution.toolName === 'send_thread_message' && execution.status === 'completed'),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps an active Tool Batch visible when its parent is older than the latest history page', async () => {
    const model = new FakeModel(() =>
      response('', [{ id: 'paged-pending-read', name: 'read_file', arguments: { path: 'facts.txt' } }]),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    try {
      await env.runtime.submit(thread.id, 'paged-parent-message', 'Read facts.txt.');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      for (let index = 0; index < 110; index += 1) {
        await env.runtime.submit(thread.id, `paused-follow-up-${index}`, `Follow-up ${index}`);
      }

      const snapshot = env.runtime.getSnapshot(thread.id)!;
      expect(snapshot.records[0]?.kind).toBe('assistant');
      expect(snapshot.records[0]?.id).toMatch(/:assistant$/);
      expect(snapshot.records).toHaveLength(112);
      expect(snapshot.records.filter((record) => record.kind === 'message')).toHaveLength(110);
      expect(snapshot.executions.find((execution) => execution.toolName === 'read_file')?.status).toBe('pending');
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      ).toBe(true);
      expect(snapshot.hasEarlierRecords).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('closes with a pending approval intact and restores it after Runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-approval-restart-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'input.txt'), 'durable approval', 'utf8');
    const databasePath = join(directory, 'runtime.sqlite');
    let modelCalls = 0;
    const createModel = (): FakeModel =>
      new FakeModel(() => {
        modelCalls += 1;
        return modelCalls === 1
          ? response('', [{ id: 'approval-read', name: 'read_file', arguments: { path: 'input.txt' } }])
          : response('The file was read after restart.');
      });
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: createModel(),
      pluginDirectory: join(directory, 'empty-plugins'),
      plugins: [permissionPlugin],
    });
    await runtime.initialize();
    const project = await runtime.createProject('Approval recovery', workspace);
    runtime.updateModelSettings({ model: 'test-model' });
    const thread = runtime.createThread(project.id, 'host');
    try {
      await runtime.submit(thread.id, 'approval-restart-message', 'Read the input file.');
      await untilAsync(async () =>
        (await permissionView(runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(runtime, thread.id)).approvals[0]!;
      const executionBeforeShutdown = store.getExecution(approval.executionId);

      await runtime.shutdown();
      expect(executionBeforeShutdown?.status).toBe('pending');
      expect(store.getExecution(approval.executionId)?.status).toBe('pending');
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: createModel(),
        pluginDirectory: join(directory, 'empty-plugins'),
        plugins: [permissionPlugin],
      });
      await runtime.initialize();
      await untilAsync(async () => (await permissionView(runtime, thread.id)).approvals[0]?.status === 'pending');
      await decidePermission(runtime, approval.executionId, true);
      await runtime.drain();

      expect(store.getExecution(approval.executionId)?.status).toBe('completed');
      expect(
        (await permissionView(runtime, thread.id)).approvals.find((item) => item.executionId === approval.executionId)
          ?.status,
      ).toBe('allowed');
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(2);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discards an in-flight Model draft on shutdown and resumes from the last durable boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-model-shutdown-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let notifyModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      notifyModelStarted = resolve;
    });
    const interruptedModel = new FakeModel((_prompt, _callNumber, signal, onText) => {
      onText('This partial answer must not become history.');
      notifyModelStarted();
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('Runtime is shutting down.', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: interruptedModel,
      pluginDirectory: join(directory, 'empty-plugins'),
    });
    await runtime.initialize();
    const project = await runtime.createProject('Model recovery', workspace);
    runtime.updateModelSettings({ model: 'test-model' });
    const thread = runtime.createThread(project.id, 'host');
    try {
      await runtime.submit(thread.id, 'model-shutdown-message', 'Please finish this response.');
      await modelStarted;
      await runtime.shutdown();

      const unfinished = store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(interruptedModel.signals[0]?.aborted).toBe(true);
      expect(unfinished?.status).toBe('interrupted');
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(runtime.getThread(thread.id)?.pauseRequested).toBe(false);
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: new FakeModel(() => response('Recovered from the durable Message.')),
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      await runtime.drain();

      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toMatchObject([
        { payload: { content: 'Recovered from the durable Message.' } },
      ]);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not rerun a slash command when its request is retried after Runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-command-retry-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let invocations = 0;
    const commandStarted = deferred<void>();
    const releaseCommand = deferred<{ text: string }>();
    const plugin: PicoPlugin = {
      id: 'test.command-retry',
      name: 'Command retry',
      version: '1',
      activate({ commands }) {
        commands.register({
          name: 'count',
          description: 'Increment the test counter',
          async execute() {
            invocations += 1;
            commandStarted.resolve(undefined);
            return releaseCommand.promise;
          },
        });
      },
    };
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('unused')),
      plugins: [plugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });
    await runtime.initialize();
    const project = await runtime.createProject('Command retries', workspace);
    const thread = runtime.createThread(project.id, 'host');
    try {
      const firstPromise = runtime.submit(thread.id, 'stable-command-id', '/count');
      await commandStarted.promise;
      const racingRetry = await runtime.submit(thread.id, 'stable-command-id', '/count');
      expect(racingRetry.duplicate).toBe(true);
      expect(racingRetry.command?.text).toContain('already accepted');
      releaseCommand.resolve({ text: `Invocation ${invocations}` });
      const first = await firstPromise;
      expect(first.duplicate).toBe(false);
      expect(first.command?.text).toBe('Invocation 1');
      expect(invocations).toBe(1);

      store.close();
      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: new FakeModel(() => response('unused')),
        plugins: [plugin],
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      const retry = await runtime.submit(thread.id, 'stable-command-id', '/count');

      expect(retry.duplicate).toBe(true);
      expect(retry.command?.text).toBe('Invocation 1');
      expect(invocations).toBe(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      expect(
        store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'invocation-accepted'),
      ).toHaveLength(1);
      expect(
        store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'invocation-completed'),
      ).toMatchObject([{ payload: { result: { text: 'Invocation 1' } } }]);
      await expect(runtime.submit(thread.id, 'stable-command-id', '/other')).rejects.toThrow(
        /reused with different content/i,
      );
    } finally {
      releaseCommand.resolve({ text: 'cleanup' });
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not rerun a command whose accepted receipt survived without a completion record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-command-incomplete-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let invocations = 0;
    const plugin: PicoPlugin = {
      id: 'test.incomplete-command',
      name: 'Incomplete command',
      version: '1',
      activate({ commands }) {
        commands.register({
          name: 'count',
          description: 'Increment the test counter',
          execute() {
            invocations += 1;
            return { text: `Invocation ${invocations}` };
          },
        });
      },
    };
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('unused')),
      plugins: [plugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });
    await runtime.initialize();
    const project = await runtime.createProject('Incomplete command', workspace);
    const thread = runtime.createThread(project.id, 'host');
    const id = 'incomplete-command-id';
    const commandText = '/count';
    const requestHash = createHash('sha256').update(`${thread.id}\0${id}`).digest('hex');
    const commandHash = createHash('sha256').update(commandText).digest('hex');

    try {
      store.appendCanonical(thread.id, `pico:command:${requestHash}`, 'plugin', {
        pluginId: 'pico.commands',
        action: 'invocation-accepted',
        requestHash,
        commandHash,
      });
      await runtime.shutdown();
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: new FakeModel(() => response('unused')),
        plugins: [plugin],
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      const retry = await runtime.submit(thread.id, id, commandText);

      expect(retry.duplicate).toBe(true);
      expect(retry.command?.text).toContain('already accepted');
      expect(invocations).toBe(0);
      expect(
        store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'invocation-completed'),
      ).toHaveLength(0);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes Model stage input replacements to the default model adapter', async () => {
    let readPluginCanonicalHistory: (threadId: string) => CanonicalRecord[] = () => [];
    const plugin: PicoPlugin = {
      id: 'test.model-prompt',
      name: 'Model prompt modifier',
      version: '1',
      activate(context) {
        const { pipelines } = context;
        readPluginCanonicalHistory = context.canonical.list;
        pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) =>
          next({ ...input, systemPrompt: `${input.systemPrompt}\nProject context: stable architecture.` }),
        );
        pipelines.use<ModelStageInput, ModelResponse>('model', async (input, next) =>
          next({
            ...input,
            prompt: { ...input.prompt, system: `${input.prompt.system}\nUse concise answers.` },
          }),
        );
      },
    };
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'model-prompt-message', 'Hello');
      await env.runtime.drain();

      expect(model.prompts[0]?.system).toContain('Use concise answers.');
      expect(env.store.listRecords(thread.id).find((record) => record.kind === 'message')?.payload).toMatchObject({
        content: 'Hello',
      });
      const records = env.store.listRecords(thread.id);
      const assistant = records.find((record) => record.kind === 'assistant');
      expect(records.filter((record) => record.kind === 'assistant')).toHaveLength(1);
      expect(records).toHaveLength(3);
      expect(assistant).toBeDefined();
      const modelExecutionId = assistant!.id.replace(/:assistant$/, '');
      const attempts = env.runtime.getModelInputAttempts(thread.id, modelExecutionId);
      expect(attempts).toHaveLength(1);
      expect(attempts?.[0]).toMatchObject({
        promptSummary: {
          version: 1,
          model: model.prompts[0]?.model,
          turns: [{ kind: 'message', role: 'user', characters: 'Hello'.length }],
        },
        status: 'completed',
      });
      expect(attempts?.[0]?.promptSummary.systemCharacters).toBeGreaterThan(0);
      expect(attempts?.[0]?.promptSummary.systemFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(attempts?.[0]?.promptSummary.toolsFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(attempts?.[0]?.prompt).toMatchObject({
        version: 1,
        system: expect.stringContaining('Project context: stable architecture.'),
        turns: [{ kind: 'message', role: 'user', content: 'Hello' }],
      });
      const modelInputRecord = readPluginCanonicalHistory(thread.id).find(
        (record) => record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      );
      expect(modelInputRecord).toMatchObject({
        kind: 'plugin',
        payload: {
          pluginId: 'pico.runtime',
          action: 'model-input-recorded',
          executionId: modelExecutionId,
          prompt: { turns: [{ kind: 'message', content: 'Hello' }] },
        },
      });
      const diagnosticLog = env.store.listExecutionLog(modelExecutionId, 'model-input-requested');
      expect(diagnosticLog[0]?.detail).toHaveProperty('modelInputRecordId', modelInputRecord?.id);
      expect(diagnosticLog[0]?.detail).not.toHaveProperty('prompt');
      expect(JSON.stringify(diagnosticLog)).not.toContain('Hello');
      expect(JSON.stringify(attempts)).toContain('stable architecture');
      expect(env.runtime.getModelInputAttempts(env.createThread().id, modelExecutionId)).toBeNull();
      expect(env.store.listRecords(thread.id)).toEqual(records);
    } finally {
      await env.cleanup();
    }
  });

  it('runs a Tool Batch concurrently and waits for every call to settle', async () => {
    const started = deferred<void>();
    const releaseAlpha = deferred<string>();
    const releaseBeta = deferred<string>();
    let starts = 0;
    const startOrder: string[] = [];
    const scheduledOrder: string[] = [];
    const batchPlugin: PicoPlugin = {
      id: 'test.parallel-tools',
      name: 'Parallel tools',
      version: '1',
      activate({ tools, pipelines }) {
        for (const name of ['batch_alpha', 'batch_beta']) {
          tools.register({ name, description: name, parameters: { type: 'object', properties: {} } }, async () => {
            starts += 1;
            startOrder.push(name);
            if (starts === 2) started.resolve();
            return name === 'batch_alpha' ? releaseAlpha.promise : releaseBeta.promise;
          });
        }
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input, next) => {
          const execute = input.execute;
          return next({
            ...input,
            calls: [...input.calls].reverse(),
            execute: (call) => {
              scheduledOrder.push(call.name);
              return execute(call);
            },
          });
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [
            { id: 'alpha', name: 'batch_alpha', arguments: {} },
            { id: 'alpha', name: 'batch_beta', arguments: {} },
          ])
        : response('Both tools finished.'),
    );
    const env = await setupRuntime(model, { plugins: [batchPlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'parallel-message', 'Run both tools');
      await started.promise;
      expect(starts).toBe(2);
      expect(startOrder).toEqual(['batch_beta', 'batch_alpha']);
      expect(scheduledOrder).toEqual(['batch_beta', 'batch_alpha']);
      expect(model.calls).toBe(1);

      releaseAlpha.resolve('alpha done');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'batch_alpha' && execution.status === 'completed'),
      );
      expect(model.calls).toBe(1);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'batch_beta')?.status).toBe(
        'running',
      );

      releaseBeta.resolve('beta done');
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(2);
      const assistant = env.store.listRecords(thread.id).find((record) => record.kind === 'assistant')!;
      const assistantStep = assistant.payload as unknown as AssistantPayload;
      expect(new Set(assistantStep.toolCalls.map((call) => call.id)).size).toBe(2);
    } finally {
      releaseAlpha.resolve('cleanup');
      releaseBeta.resolve('cleanup');
      await env.cleanup();
    }
  });

  it('keeps a Model Step and its Tool Batch inside one step pipeline iteration', async () => {
    const events: string[] = [];
    let nextStepId = 0;
    let activeStepId: number | null = null;
    const pipelinePlugin: PicoPlugin = {
      id: 'test.step-boundary',
      name: 'Step boundary',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'step_boundary_tool', description: 'Step boundary test', parameters: { type: 'object' } },
          async () => 'tool finished',
        );
        pipelines.use<StepInput, void>('step', async (input, next) => {
          const stepId = ++nextStepId;
          activeStepId = stepId;
          events.push(`step:${stepId}:start`);
          try {
            return await next(input);
          } finally {
            events.push(`step:${stepId}:end`);
            activeStepId = null;
          }
        });
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input, next) => {
          events.push(`batch:${activeStepId ?? 'outside'}`);
          return next(input);
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'step-tool', name: 'step_boundary_tool', arguments: {} }])
        : response('The iteration finished.'),
    );
    const env = await setupRuntime(model, { plugins: [pipelinePlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'step-boundary-message', 'Use the tool');
      await env.runtime.drain();

      expect(events).toEqual(['step:1:start', 'batch:1', 'step:1:end', 'step:2:start', 'step:2:end']);
      expect(model.calls).toBe(2);
    } finally {
      await env.cleanup();
    }
  });

  it('settles the current Model Step Tool Batch before honoring Pause', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const plugin: PicoPlugin = {
      id: 'test.pause-current-batch',
      name: 'Pause current Tool Batch',
      version: '1',
      activate({ tools }) {
        tools.register(
          { name: 'pause_batch_tool', description: 'Pause batch test', parameters: { type: 'object' } },
          async () => 'current batch finished',
        );
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1 ? firstResponse.promise : response('Continued after the pause.'),
    );
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'pause-batch-message', 'Start the current iteration');
      await until(() => model.calls === 1);
      const signal = model.signals[0]!;
      env.runtime.pause(thread.id);
      expect(signal.aborted).toBe(false);

      firstResponse.resolve(response('', [{ id: 'pause-call', name: 'pause_batch_tool', arguments: {} }]));
      await env.runtime.drain();

      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'completed',
      );
      env.runtime.continue(thread.id);
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      firstResponse.resolve(response('cleanup'));
      await env.cleanup();
    }
  });

  it('pauses when a short-circuited step leaves durable work unprocessed', async () => {
    const plugin: PicoPlugin = {
      id: 'test.skip-step',
      name: 'Skip step',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<StepInput, void>('step', async () => undefined);
      },
    };
    const model = new FakeModel(() => response('Should not run.'));
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'skipped-step-message', 'Wait for the plugin');
      await env.runtime.drain();

      expect(model.calls).toBe(0);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(env.runtime.getThread(thread.id)?.pauseReason).toContain('safe boundary');
    } finally {
      await env.cleanup();
    }
  });

  it('persists a replacement Tool Batch result before entering the next Model Step', async () => {
    let toolStarted = false;
    const batchPlugin: PicoPlugin = {
      id: 'test.replacement-batch',
      name: 'Replacement Tool Batch',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'batch_replaced', description: 'Replaced by the batch stage', parameters: { type: 'object' } },
          async () => {
            toolStarted = true;
            return 'unexpected';
          },
        );
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input) => {
          const now = new Date().toISOString();
          return input.calls.map((call) => ({
            id: `${input.thread.id}:${input.batchId.replace(/:batch$/, '')}:${call.id}`,
            threadId: input.thread.id,
            batchId: input.batchId,
            kind: 'tool',
            toolName: call.name,
            arguments: call.arguments,
            status: 'completed',
            result: { handledBy: 'replacement batch' },
            error: null,
            createdAt: now,
            updatedAt: now,
          }));
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'replaced-call', name: 'batch_replaced', arguments: {} }])
        : response('The replacement result is durable.'),
    );
    const env = await setupRuntime(model, { plugins: [batchPlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'replacement-batch-message', 'Run the replacement batch');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'batch_replaced');
      expect(toolStarted).toBe(false);
      expect(execution?.status).toBe('completed');
      expect(execution?.result).toEqual({ handledBy: 'replacement batch' });
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(1);
      expect(model.calls).toBe(2);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('replacement batch'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('Pause preserves the current Model Step, saves incoming Messages, and Continue resumes later', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1 ? firstResponse.promise : response('Continued.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'pause-message-1', 'Start');
      await until(() => model.calls === 1);
      const signal = model.signals[0]!;
      env.runtime.pause(thread.id);
      await env.runtime.submit(thread.id, 'pause-message-2', 'Save this for later');
      expect(signal.aborted).toBe(false);
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('pausing');

      firstResponse.resolve(response('Finished the current step.'));
      await env.runtime.drain();
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(2);

      env.runtime.continue(thread.id);
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      firstResponse.resolve(response('cleanup'));
      await env.cleanup();
    }
  });

  it('keeps Interrupt available for a Tool Execution that outlives a paused Thread', async () => {
    const toolStarted = deferred<void>();
    const toolAborted = deferred<void>();
    let store: PicoStore | null = null;
    const plugin: PicoPlugin = {
      id: 'test.paused-active-tool',
      name: 'Paused active Tool',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'wait_for_interrupt', description: 'Wait for Interrupt', parameters: { type: 'object' } },
          async (_args, context) => {
            toolStarted.resolve(undefined);
            return new Promise((_, reject) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  toolAborted.resolve(undefined);
                  reject(new DOMException('Execution interrupted', 'AbortError'));
                },
                { once: true },
              );
            });
          },
        );
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input) => {
          void input.execute(input.calls[0]!);
          await toolStarted.promise;
          const execution = store!
            .listExecutions(input.thread.id)
            .find((item) => item.batchId === input.batchId && item.kind === 'tool');
          if (!execution) throw new Error('Tool Execution was not durably started');
          return [execution];
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'long-tool', name: 'wait_for_interrupt', arguments: {} }])
        : response('The tool was interrupted.'),
    );
    const env = await setupRuntime(model, { plugins: [plugin] });
    store = env.store;
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'paused-active-tool-message', 'Start a long tool');
      await toolStarted.promise;
      await env.runtime.drain();

      const paused = env.runtime.getThread(thread.id)!;
      const activeExecutions = env.store.listExecutions(thread.id);
      expect(paused.state).toBe('paused');
      expect(activeExecutions.some((execution) => execution.status === 'running')).toBe(true);
      expect(model.calls).toBe(1);
      expect(threadCanBeInterrupted(paused.state, activeExecutions)).toBe(true);

      await env.runtime.interrupt(thread.id);
      await toolAborted.promise;
      await until(() => env.store.listExecutions(thread.id).every((execution) => execution.status !== 'running'));
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'interrupted',
      );
      expect(threadCanBeInterrupted(env.runtime.getThread(thread.id)!.state, env.store.listExecutions(thread.id))).toBe(
        false,
      );
    } finally {
      await env.runtime.interrupt(thread.id);
      await env.cleanup();
    }
  });

  it('asks before a Host Executor tool call, then records the allowed result', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read:file:one', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('I read the file.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      await env.runtime.submit(thread.id, 'approval-message', 'Read facts.txt');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');

      await decidePermission(env.runtime, approval.executionId, true);
      await env.runtime.drain();
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
      const toolResult = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(toolResult?.payload).toMatchObject({ toolCallId: 'read:file:one', toolName: 'read_file' });
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toBe(true);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
      expect(model.prompts[1]?.turns.filter((turn) => turn.kind === 'tool_result')).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it('commits approval status, remembered permission, and audit record together', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'atomic-approval', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The approval was recorded.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'transactional approval', 'utf8');
    try {
      await env.runtime.submit(thread.id, 'atomic-approval-message', 'Read facts.txt.');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;
      env.store.db.exec(`
        CREATE TRIGGER fail_permission_audit
        BEFORE INSERT ON canonical_records
        WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
        BEGIN SELECT RAISE(ABORT, 'simulated permission denial audit failure'); END;
      `);

      await expect(decidePermission(env.runtime, approval.executionId, true, true)).rejects.toThrow(
        /simulated permission denial audit failure/,
      );
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('pending');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((item) => item.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toHaveLength(1);

      env.store.db.exec('DROP TRIGGER fail_permission_audit;');
      await decidePermission(env.runtime, approval.executionId, true, true);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((item) => item.name === 'read_file')?.policy,
      ).toBe('allow');
      expect(
        env.store
          .listRecords(thread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.executionId === approval.executionId &&
              record.payload.scope === 'thread',
          ),
      ).toBe(true);
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
    } finally {
      await env.cleanup();
    }
  });

  it('returns permission denials with a visible reason and guidance for the next Model Step', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'policy-denial', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The tool was blocked by policy, so I will explain that and offer another path.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await setPermission(env.runtime, thread.id, 'read_file', 'deny');
    try {
      await env.runtime.submit(thread.id, 'policy-denial-message', 'Read facts.txt.');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'read_file')!;
      const result = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(execution).toMatchObject({
        status: 'failed',
        error: 'Denied by the current permission policy.',
        result: {
          denied: true,
          reason: 'Denied by the current permission policy.',
          modelGuidance: expect.stringContaining('Do not repeat the same call.'),
        },
      });
      expect(result?.payload).toMatchObject({
        status: 'failed',
        error: 'Denied by the current permission policy.',
        result: { denied: true, modelGuidance: expect.any(String) },
      });
      const modelToolResult = model.prompts[1]?.turns.find((turn) => turn.kind === 'tool_result');
      expect(modelToolResult?.content).toContain('Denied by the current permission policy.');
      expect(modelToolResult?.content).toContain('Model guidance:');
      expect(modelToolResult?.content).toContain('Do not repeat the same call.');
    } finally {
      await env.cleanup();
    }
  });

  it('fails closed when the permission audit record for a denied Tool cannot be committed', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'atomic-denial', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The file was read after the permission decision could be recorded.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'transactional denial', 'utf8');
    await setPermission(env.runtime, thread.id, 'read_file', 'deny');
    try {
      env.store.db.exec(`
        CREATE TRIGGER fail_permission_denial_audit
        BEFORE INSERT ON canonical_records
        WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
          AND json_extract(NEW.payload_json, '$.pluginId') = 'pico.permissions'
          AND json_extract(NEW.payload_json, '$.action') = 'decision'
        BEGIN SELECT RAISE(ABORT, 'simulated permission denial audit failure'); END;
      `);

      await env.runtime.submit(thread.id, 'atomic-denial-message', 'Read facts.txt.');
      await env.runtime.drain();
      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'read_file')!;

      expect(env.store.getExecution(execution.id)?.status).toBe('failed');
      expect(env.store.getExecution(execution.id)?.error).toContain('simulated permission denial audit failure');
      expect(
        env.store
          .listRecords(thread.id)
          .filter(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.action === 'decision',
          ),
      ).toHaveLength(0);
      expect(env.store.getExecution(execution.id)?.result).toBeNull();
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toMatchObject([
        { payload: { status: 'failed' } },
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('Interrupt stops a pathological Host search while the Runtime remains responsive', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'regex-search', name: 'search_files', arguments: { pattern: '^(a+)+$' } }])
        : response('The search was interrupted.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/pathological.txt`, `${'a'.repeat(28)}!`, 'utf8');
    await setPermission(env.runtime, thread.id, 'search_files', 'allow');
    try {
      await env.runtime.submit(thread.id, 'regex-search-message', 'Search this workspace.');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'search_files' && execution.status === 'running'),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'search_files');
      const result = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(execution?.status).toBe('interrupted');
      expect((result?.payload as { status?: string }).status).toBe('interrupted');
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  }, 5000);

  it('Interrupt cancels a pending approval without recording a denial or starting the Tool', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'cancel-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The interrupted approval was not executed.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    try {
      await env.runtime.submit(thread.id, 'cancel-approval-message', 'Read facts.txt');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;

      env.store.db.exec(`
        CREATE TRIGGER fail_permission_cancel_audit
        BEFORE INSERT ON canonical_records
        WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
        BEGIN SELECT RAISE(ABORT, 'simulated permission cancellation audit failure'); END;
      `);
      await expect(env.runtime.interrupt(thread.id)).rejects.toThrow(/simulated permission cancellation audit failure/);
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('pending');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toHaveLength(1);
      env.store.db.exec('DROP TRIGGER fail_permission_cancel_audit;');

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('cancelled');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('interrupted');
      await expect(decidePermission(env.runtime, approval.executionId, true, true)).rejects.toThrow(/cancelled/i);
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(model.calls).toBe(1);
      const permissionRecords = env.store
        .listRecords(thread.id)
        .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions');
      expect(permissionRecords.some((record) => record.payload.action === 'cancel')).toBe(true);
      expect(
        permissionRecords.some((record) => record.payload.action === 'decision' && record.payload.decision === 'deny'),
      ).toBe(false);
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'tool_result' && record.payload.status === 'interrupted'),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('can persist an approval for one Tool in the Thread to avoid repeated prompts', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read-once', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : callNumber === 2
          ? response('', [{ id: 'read-again', name: 'read_file', arguments: { path: 'facts.txt' } }])
          : response('The file was read twice.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      await env.runtime.submit(thread.id, 'thread-approval-message', 'Read the file twice');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;

      await decidePermission(env.runtime, approval.executionId, true, true);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('allow');
      expect((await permissionView(env.runtime, thread.id)).approvals).toHaveLength(1);
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        env.store
          .listRecords(thread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.scope === 'thread',
          ),
      ).toBe(true);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(model.calls).toBe(3);
      expect(
        model.prompts[2]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('explicit Interrupt aborts a Model Step and leaves no partial assistant fact', async () => {
    const started = deferred<void>();
    const model = new FakeModel(
      (_prompt, _callNumber, signal) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
        }),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'interrupt-model-message', 'Begin');
      await started.promise;
      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();
      expect(model.signals[0]?.aborted).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      const modelExecution = env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(modelExecution?.status).toBe('interrupted');
      expect(env.runtime.getModelInputAttempts(thread.id, modelExecution!.id)).toMatchObject([
        {
          status: 'interrupted',
          promptSummary: { turns: [{ kind: 'message', role: 'user', characters: 'Begin'.length }] },
        },
      ]);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('discards partial streaming text when a Model Step fails', async () => {
    const model = new FakeModel((_prompt, _callNumber, _signal, onText) => {
      onText('unfinished draft');
      throw new Error('stream disconnected');
    });
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'stream-failure-message', 'Write something');
      await env.runtime.drain();
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      const modelExecution = env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(modelExecution?.status).toBe('failed');
      expect(env.runtime.getModelInputAttempts(thread.id, modelExecution!.id)).toMatchObject([
        {
          status: 'failed',
          error: 'Model request failed (provider_error).',
          promptSummary: { turns: [{ kind: 'message', role: 'user', characters: 'Write something'.length }] },
        },
      ]);
      expect(env.store.listRecords(thread.id).map((record) => record.kind)).toEqual(['message', 'plugin']);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('pauses on a model output limit and does not execute calls from the truncated response', async () => {
    const model = new FakeModel(() => ({
      ...response('The answer stops here'),
      finishReason: 'length',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      toolCalls: [{ id: 'truncated-call', name: 'read_file', arguments: { path: 'facts.txt' } }],
    }));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'output-limit-message', 'Answer and inspect facts.txt.');
      await env.runtime.drain();

      const assistant = env.store.listRecords(thread.id).find((record) => record.kind === 'assistant');
      expect(assistant?.payload).toMatchObject({
        content: 'The answer stops here',
        toolCalls: [],
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        finishReason: 'length',
      });
      expect(env.store.listExecutions(thread.id).filter((execution) => execution.kind === 'tool')).toHaveLength(0);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model')?.result).toMatchObject(
        {
          finishReason: 'length',
        },
      );
      expect(env.runtime.getThread(thread.id)).toMatchObject({
        state: 'paused',
        pauseReason: expect.stringContaining('output token limit'),
      });
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps the full long Thread history in the Model projection with each Tool Result once', async () => {
    const model = new FakeModel(() => response('Long history preserved.'));
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    const historySteps = 120;
    try {
      for (let index = 0; index < historySteps; index += 1) {
        env.store.appendMessage(thread.id, `projection-message-${index}`, {
          role: 'user',
          content: `User fact ${index}`,
          source: 'user',
        });
        const modelExecutionId = `projection-model-${index}`;
        const modelExecution = env.store.createModelExecution(modelExecutionId, thread.id, index);
        env.store.transitionExecution(modelExecution.id, 'running');
        const call = {
          id: `projection:call:${index}`,
          name: 'read_file',
          arguments: { path: `facts-${index}.txt` },
        };
        const batchId = `${modelExecutionId}:batch`;
        const executionId = `${thread.id}:${modelExecutionId}:${call.id}`;
        env.store.commitModelStep({
          assistantRecordId: `${modelExecutionId}:assistant`,
          modelExecutionId,
          threadId: thread.id,
          payload: assistantPayload({
            content: `Step ${index}`,
            toolCalls: [call],
            batchId,
            projectionThrough: index,
          }),
          toolCalls: [{ call, executionId }],
        });
        env.store.transitionExecution(executionId, 'completed', { result: { entry: index } });
        env.store.appendToolResult(thread.id, {
          executionId,
          toolCallId: call.id,
          batchId,
          toolName: call.name,
          status: 'completed',
          result: { entry: index },
        });
      }

      const listRecords = env.store.listRecords.bind(env.store);
      let fullHistoryReads = 0;
      env.store.listRecords = (threadId) => {
        fullHistoryReads += 1;
        return listRecords(threadId);
      };

      await env.runtime.submit(thread.id, 'projection-latest-message', 'Use the complete project history.');
      await env.runtime.drain();

      const turns = model.prompts[0]?.turns ?? [];
      expect(fullHistoryReads).toBe(2);
      expect(turns).toHaveLength(historySteps * 3 + 1);
      expect(turns[0]).toMatchObject({ kind: 'message', content: 'User fact 0' });
      expect(turns.filter((turn) => turn.kind === 'assistant_tools')).toHaveLength(historySteps);
      expect(turns.filter((turn) => turn.kind === 'tool_result')).toHaveLength(historySteps);
      expect(turns.at(-1)).toMatchObject({ kind: 'message', content: 'Use the complete project history.' });
      expect(turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('"entry":119'))).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('lets a child Thread and parent exchange ordinary Messages without blocking spawn', async () => {
    let parentId = '';
    let childId = '';
    let parentCalls = 0;
    let childCalls = 0;
    const model = new FakeModel((prompt) => {
      const threadId = prompt.system.match(/Current Thread ID: ([^\n]+)/)?.[1];
      if (threadId === parentId) {
        parentCalls += 1;
        if (parentCalls === 1)
          return response('', [
            {
              id: 'spawn',
              name: 'spawn_thread',
              arguments: { title: 'Research child', prompt: 'Find one useful fact.' },
            },
          ]);
        if (parentCalls === 2)
          return response('', [
            {
              id: 'reply',
              name: 'send_thread_message',
              arguments: { thread_id: childId, message: 'Please check the detail.' },
            },
          ]);
        return response('Parent received the child update.');
      }
      childCalls += 1;
      if (childCalls === 1)
        return response('', [
          {
            id: 'child-reply',
            name: 'send_thread_message',
            arguments: { thread_id: parentId, message: 'The detail is confirmed.' },
          },
        ]);
      return response('Child work is complete.');
    });
    const env = await setupRuntime(model);
    const parent = env.createThread('host', 'Main thread');
    parentId = parent.id;
    const unsubscribe = env.runtime.subscribe((event) => {
      const created = event.thread as { id?: string; parentThreadId?: string | null } | undefined;
      if (event.type === 'thread.created' && created?.parentThreadId === parent.id) childId = created.id ?? '';
    });
    try {
      await env.runtime.submit(parent.id, 'parent-child-start', 'Delegate a quick check');
      await env.runtime.drain();
      const child = env.store.getThread(childId);
      expect(child).not.toBeNull();
      expect(child?.projectId).toBe(parent.projectId);
      expect(child?.executorKind).toBe(parent.executorKind);
      expect(child?.parentThreadId).toBe(parent.id);
      expect(env.runtime.getSnapshot(parent.id)?.children.map((item) => item.id)).toContain(childId);

      const parentMessages = env.store.listRecords(parent.id).filter((record) => record.kind === 'message');
      const childMessages = env.store.listRecords(childId).filter((record) => record.kind === 'message');
      expect(
        parentMessages.some(
          (record) => record.payload.source === 'child' && record.payload.content === 'The detail is confirmed.',
        ),
      ).toBe(true);
      expect(
        childMessages.some(
          (record) => record.payload.source === 'agent' && record.payload.content === 'Please check the detail.',
        ),
      ).toBe(true);
      expect(parentCalls).toBeGreaterThanOrEqual(3);
      expect(childCalls).toBeGreaterThanOrEqual(2);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${parent.id}`) &&
            prompt.turns.some(
              (turn) =>
                turn.kind === 'message' &&
                turn.content ===
                  `[Message from Child Thread "Research child" (Thread ID: "${childId}")]\nThe detail is confirmed.`,
            ),
        ),
      ).toBe(true);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${childId}`) &&
            prompt.turns.some(
              (turn) =>
                turn.kind === 'message' &&
                turn.content ===
                  `[Message from Parent Thread "Main thread" (Thread ID: "${parent.id}")]\nPlease check the detail.`,
            ),
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('shares explicit Project context across Threads without changing canonical Messages', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const sourceThread = env.createThread('host', 'Context editor');
    const otherExecutorThread = env.runtime.createThread(env.project.id, 'host', 'Host continuation');
    const isolatedProject = await env.runtime.createProject('Separate Project', env.workspace);
    const isolatedThread = env.runtime.createThread(isolatedProject.id, 'host', 'Isolated context');
    const contextText = 'Keep canonical history append-only.\nUse Project Context for decisions shared across Threads.';
    try {
      const saved = await env.runtime.submit(
        sourceThread.id,
        'project-context-set',
        `/project-context set\n${contextText}`,
      );

      expect(saved.command?.text).toContain('Project context saved');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      expect(
        env.store.getPluginState<{
          entries: Array<{ projectId: string; text: string; source: string; status: string }>;
        }>('pico.project-context', 'memory', { entries: [] }).entries,
      ).toContainEqual(
        expect.objectContaining({
          projectId: env.project.id,
          text: contextText,
          source: 'manual',
          status: 'active',
        }),
      );
      expect(
        env.store
          .listRecords(sourceThread.id)
          .find((record) => record.kind === 'plugin' && record.payload.action === 'memory.recorded')?.payload,
      ).toMatchObject({
        pluginId: 'pico.project-context',
        projectId: env.project.id,
        category: 'fact',
      });
      expect(
        env.store
          .listRecords(sourceThread.id)
          .some(
            (record) =>
              record.kind === 'plugin' && record.payload.action === 'memory.recorded' && 'text' in record.payload,
          ),
      ).toBe(false);

      await env.runtime.submit(
        otherExecutorThread.id,
        'context-shared-message',
        'Apply the guidance about keeping canonical history append-only across Threads.',
      );
      await env.runtime.drain();
      const sharedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some(
          (turn) =>
            turn.kind === 'message' &&
            turn.content === 'Apply the guidance about keeping canonical history append-only across Threads.',
        ),
      );
      expect(sharedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        true,
      );
      expect(
        sharedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes('Relevant Project Memory')),
      ).toBe(true);

      await env.runtime.submit(isolatedThread.id, 'context-isolated-message', 'Check the other Project.');
      await env.runtime.drain();
      const isolatedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the other Project.'),
      );
      expect(isolatedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        false,
      );

      const cleared = await env.runtime.submit(sourceThread.id, 'project-context-clear', '/project-context clear');
      expect(cleared.command?.text).toContain('Manual Project Context cleared');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      await env.runtime.submit(otherExecutorThread.id, 'context-cleared-message', 'Check the updated guidance.');
      await env.runtime.drain();
      const clearedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the updated guidance.'),
      );
      expect(clearedPrompt?.turns.some((turn) => turn.kind === 'message' && turn.content.includes(contextText))).toBe(
        false,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('loads a local plugin tool, slash command, semantic UI contribution, state, and canonical log', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'note', name: 'save_thread_note', arguments: { note: 'Keep the setup small.' } }])
        : response('Saved.'),
    );
    const env = await setupRuntime(model, { pluginDirectory: resolve(process.cwd(), 'plugins') });
    const thread = env.createThread();
    try {
      expect(env.runtime.pluginInfo().plugins.some((plugin) => plugin.id === 'pico.example-notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'project-context')).toBe(true);
      expect(env.runtime.pluginInfo().ui.some((contribution) => contribution.id === 'pico.example-notes:notes')).toBe(
        true,
      );
      expect(
        env.runtime
          .pluginInfo()
          .ui.some(
            (contribution) =>
              contribution.id === 'pico.project-context:project-context' &&
              contribution.entry === 'webui' &&
              contribution.component === 'ProjectContextPanel',
          ),
      ).toBe(true);

      await env.runtime.submit(thread.id, 'plugin-tool-message', 'Save a note');
      await env.runtime.drain();
      expect(
        env.store.getPluginState<Record<string, Array<{ note: string }>>>('pico.example-notes', 'notesByThread', {})[
          thread.id
        ]?.[0]?.note,
      ).toBe('Keep the setup small.');
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.example-notes'),
      ).toBe(true);
      const command = await env.runtime.submit(thread.id, 'plugin-command', '/notes');
      expect(command.command?.text).toContain('Keep the setup small.');
    } finally {
      await env.cleanup();
    }
  });

  it('reports an invalid plugin pipeline stage and rolls back its partial contributions', async () => {
    const invalidPlugin: PicoPlugin = {
      id: 'test.invalid-pipeline-stage',
      name: 'Invalid pipeline stage',
      version: '1',
      activate({ tools, pipelines, ui }) {
        tools.register(
          {
            name: 'partial_plugin_tool',
            description: 'Must be removed when activation fails.',
            parameters: { type: 'object', properties: {} },
          },
          async () => ({ registered: true }),
        );
        ui.contribute({ slot: 'thread.toolbar', id: 'partial', label: 'Partial contribution' });
        pipelines.use('projetion' as never, async (input, next) => next(input));
      },
    };
    const validPlugin: PicoPlugin = {
      id: 'test.valid-after-invalid',
      name: 'Valid after invalid',
      version: '1',
      activate({ pipelines, ui }) {
        pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => next(input));
        ui.contribute({ slot: 'thread.toolbar', id: 'valid', label: 'Valid contribution' });
      },
    };
    const model = new FakeModel(() => response('The remaining plugins loaded.'));
    const env = await setupRuntime(model, { plugins: [invalidPlugin, validPlugin] });
    const thread = env.createThread();
    try {
      const info = env.runtime.pluginInfo();
      expect(info.errors).toContain('test.invalid-pipeline-stage: Unsupported execution pipeline stage: projetion');
      expect(info.plugins.map((plugin) => plugin.id)).toContain('test.valid-after-invalid');
      expect(info.plugins.map((plugin) => plugin.id)).not.toContain('test.invalid-pipeline-stage');
      expect(info.ui.map((contribution) => contribution.id)).toContain('test.valid-after-invalid:valid');
      expect(info.ui.map((contribution) => contribution.id)).not.toContain('test.invalid-pipeline-stage:partial');

      await env.runtime.submit(thread.id, 'plugin-stage-validation-message', 'Check the remaining plugins.');
      await env.runtime.drain();

      expect(model.prompts[0]?.tools.some((tool) => tool.name === 'partial_plugin_tool')).toBe(false);
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('passes frozen projections to plugins while preserving canonical facts', async () => {
    let frozenObserved = false;
    const immutablePlugin: PicoPlugin = {
      id: 'test.immutable-projection',
      name: 'Immutable projection probe',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<any, any>('projection', async (input, next) => {
          frozenObserved = Object.isFrozen(input.records[0]) && Object.isFrozen(input.records[0].payload);
          try {
            input.records[0].payload.content = 'rewritten';
          } catch {
            /* Frozen canonical view rejects writes. */
          }
          return next(input);
        });
      },
    };
    const model = new FakeModel(() => response('Kept intact.'));
    const env = await setupRuntime(model, { plugins: [immutablePlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'immutable-message', 'Original fact');
      await env.runtime.drain();
      expect(frozenObserved).toBe(true);
      expect(
        env.store.listRecords(thread.id).find((record) => record.id === 'immutable-message')?.payload.content,
      ).toBe('Original fact');
      expect(() =>
        env.store.db
          .prepare('UPDATE canonical_records SET payload_json = ? WHERE id = ?')
          .run('{"content":"rewritten"}', 'immutable-message'),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM canonical_records WHERE id = ?').run('immutable-message')).toThrow(
        /append-only/,
      );
      const pluginRecord = env.store.appendPluginRecord(thread.id, 'test.owner', {
        pluginId: 'forged.owner',
        action: 'test',
      });
      expect(pluginRecord.payload.pluginId).toBe('test.owner');
      const logId = (env.store.db.prepare('SELECT id FROM execution_log LIMIT 1').get() as { id: string }).id;
      expect(() =>
        env.store.db.prepare('UPDATE execution_log SET detail_json = ? WHERE id = ?').run('{}', logId),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM execution_log WHERE id = ?').run(logId)).toThrow(/append-only/);
    } finally {
      await env.cleanup();
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for an async condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
