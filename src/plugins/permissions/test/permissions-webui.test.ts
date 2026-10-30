import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function createHarness(
  status = 'pending',
  approvalStatus: string | null = 'pending',
  viewId = 'PermissionResultActions',
) {
  let onWindowMessage: ((event: any) => void) | undefined;
  let tree: any[] = [];
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') tree = message.tree;
      if (message.type === 'pico:plugin-ui:request') {
        requests.push(message);
        const path = typeof message.path === 'string' ? message.path : '';
        const value = path.endsWith('/mcp-servers')
          ? { allowedMcpServers: { 'server-1': true } }
          : path.endsWith('/threads?threadId=thread')
            ? {
                tools: [],
                autoReview: false,
                approvals: approvalStatus ? [{ executionId: 'execution', status: approvalStatus }] : [],
                descendantApprovals: [{ threadId: 'child', threadTitle: 'Research', toolName: 'read_file' }],
              }
            : { ok: true };
        queueMicrotask(() =>
          port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: message.id, ok: true, value } }),
        );
      }
    },
    start() {},
  };
  runInNewContext(
    readFileSync(new URL('../../../../plugins/pico.permissions/webui/permissions.js', import.meta.url), 'utf8'),
    {
      document: {},
      window: {
        parent,
        addEventListener(_type: string, callback: typeof onWindowMessage) {
          onWindowMessage = callback;
        },
      },
      queueMicrotask,
    },
  );
  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.permissions',
      entry: 'webui',
      viewType: 'component',
      viewId,
      context: {
        thread: viewId === 'ToolPermissions' ? { id: 'thread' } : null,
        threadId: 'thread',
        mcpServer: { id: 'server-1' },
        toolResult: { executionId: 'execution', status },
      },
    },
    ports: [port],
  });
  return {
    get tree() {
      return tree;
    },
    requests,
    action(actionId: string, value?: string) {
      port.onmessage?.({ data: { type: 'pico:plugin-ui:action', actionId, value } });
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

it('renders host-safe approval actions only while an approval is pending and routes the selected action through the bridge', async () => {
  const harness = createHarness();
  await flush();
  const text = JSON.stringify(harness.tree);
  expect(text).toContain('Allow once');
  expect(text).toContain('Deny');
  expect(harness.tree).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'group',
        layout: 'spread',
        children: expect.arrayContaining([
          expect.objectContaining({
            type: 'actions',
            children: expect.arrayContaining([expect.objectContaining({ label: 'Allow once', tone: 'primary' })]),
          }),
        ]),
      }),
    ]),
  );
  expect(text).not.toContain('<article');
  expect(harness.requests[0]?.path).toBe('/api/plugins/pico.permissions/threads?threadId=thread');

  harness.action('decision:allow');
  await flush();
  const decision = harness.requests.find((request) => request.path === '/api/plugins/pico.permissions/approvals');
  expect(decision?.init.method).toBe('POST');
  expect(JSON.parse(decision?.init.body)).toEqual({ executionId: 'execution', allow: true, rememberForThread: false });
  expect(
    harness.requests.filter((request) => request.path.endsWith('/threads?threadId=thread')).length,
  ).toBeGreaterThan(1);
});

it('renders and updates the server default without requiring a selected Thread', async () => {
  const harness = createHarness('pending', 'pending', 'McpServerPermissions');
  await flush();
  expect(JSON.stringify(harness.tree)).toContain('Allow this server');
  expect(JSON.stringify(harness.tree)).toContain('"checked":true');
  harness.action('mcp-server', 'false');
  await flush();
  const update = harness.requests.find(
    (request) => request.path.endsWith('/mcp-servers') && request.init?.method === 'PUT',
  );
  expect(JSON.parse(update?.init.body)).toEqual({ serverId: 'server-1', enabled: false });
});

it('shows pending child approvals and opens the child Thread', async () => {
  const harness = createHarness('pending', 'pending', 'ToolPermissions');
  await flush();
  expect(JSON.stringify(harness.tree)).toContain('Research: read_file');
  harness.action('open:child');
  await flush();
  expect(harness.requests).toContainEqual(expect.objectContaining({ action: 'open-thread', threadId: 'child' }));
});

it('does not render result actions for non-pending executions or resolved approvals', async () => {
  for (const status of ['running', 'completed', 'failed', 'interrupted']) {
    const harness = createHarness(status);
    await flush();
    expect(JSON.stringify(harness.tree)).not.toContain('Allow once');
  }
  const resolved = createHarness('pending', 'allowed');
  await flush();
  expect(JSON.stringify(resolved.tree)).not.toContain('Allow once');
});
