import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { validatePluginUiTree } from '../../ui-protocol.js';

const firstExecutionId =
  '01234567-89ab-cdef-0123-456789abcdef:12345678-1234-1234-1234-123456789abc:call_1234567890/+long';
const secondExecutionId = '01234567-89ab-cdef-0123-456789abcdef:12345678-1234-1234-1234-123456789abc:call_second';

function createHarness(
  status = 'pending',
  approvalStatus: string | null = 'pending',
  viewId = 'PermissionResultActions',
  includeChildApprovals = true,
  failChildDecision = false,
  failChildAuto = false,
) {
  let onWindowMessage: ((event: any) => void) | undefined;
  let tree: any[] = [];
  let descendantApprovals = includeChildApprovals
    ? [
        {
          executionId: firstExecutionId,
          threadId: 'child',
          threadTitle: 'Research',
          toolName: 'read_file',
          arguments: { path: 'notes.md' },
          reviewer: { model: 'reviewer-1', outcome: 'allow', reason: 'Safe to inspect.' },
        },
        {
          executionId: secondExecutionId,
          threadId: 'child',
          threadTitle: 'Research',
          toolName: 'write_file',
          arguments: { path: 'result.md' },
        },
      ]
    : [];
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') tree = message.tree;
      if (message.type === 'pico:plugin-ui:request') {
        requests.push(message);
        const path = typeof message.path === 'string' ? message.path : '';
        if (path.endsWith('/child-auto-review') && !failChildAuto) {
          const body = JSON.parse(message.init.body);
          const selected = descendantApprovals.find((approval) => approval.executionId === body.executionId);
          if (selected) {
            descendantApprovals = descendantApprovals.map((approval) =>
              approval.threadId === selected.threadId
                ? { ...approval, autoReview: true, autoReviewDenials: true }
                : approval,
            );
          }
        }
        const value = path.endsWith('/mcp-servers')
          ? { allowedMcpServers: { 'server-1': true } }
          : path.endsWith('/threads?threadId=thread')
            ? {
                tools: [],
                autoReview: false,
                approvals: approvalStatus ? [{ executionId: 'execution', status: approvalStatus }] : [],
                descendantApprovals,
              }
            : { ok: true };
        const failed =
          (failChildDecision && path.endsWith('/approvals') && message.init?.method === 'POST') ||
          (failChildAuto && path.endsWith('/child-auto-review'));
        queueMicrotask(() =>
          port.onmessage?.({
            data: {
              type: 'pico:plugin-ui:response',
              id: message.id,
              ok: !failed,
              ...(failed ? { error: 'approval failed' } : { value }),
            },
          }),
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
        thread: ['ToolPermissions', 'ChildThreadApprovals'].includes(viewId) ? { id: 'thread' } : null,
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
    setDescendantApprovals(approvals: typeof descendantApprovals) {
      descendantApprovals = approvals;
      port.onmessage?.({
        data: { type: 'pico:plugin-ui:event', event: { type: 'plugin.updated', pluginId: 'pico.permissions' } },
      });
    },
    get descendantApprovals() {
      return descendantApprovals;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function findNode(tree: any[], predicate: (node: any) => boolean): any {
  for (const node of tree) {
    if (predicate(node)) return node;
    const found = findNode(node.children ?? [], predicate);
    if (found) return found;
  }
  return undefined;
}

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

it('moves pending child approvals to the main Thread card and lets the user inspect and decide', async () => {
  const toolbar = createHarness('pending', 'pending', 'ToolPermissions');
  await flush();
  expect(JSON.stringify(toolbar.tree)).not.toContain('Research');

  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals');
  await flush();
  expect(harness.tree.filter((node) => node.type === 'card')).toHaveLength(2);
  expect(validatePluginUiTree(harness.tree, 'thread.card')).toBe(true);
  expect(JSON.stringify(harness.tree)).toContain('Research · read_file');
  expect(JSON.stringify(harness.tree)).toContain('notes.md');
  expect(JSON.stringify(harness.tree)).toContain('Safe to inspect.');
  const firstCard = harness.tree[0]!;
  const secondCard = harness.tree[1]!;
  const firstCardContent = firstCard.children[0].children;
  const actionRow = firstCardContent.find((node: any) => node.type === 'group' && node.layout === 'spread');
  expect(actionRow.children[0].children.map((node: any) => node.label)).toEqual(['Deny', 'Allow once']);
  expect(actionRow.children[1].children.map((node: any) => node.label)).toEqual(['Open Thread', 'Switch to auto']);
  expect(JSON.stringify(firstCard)).toContain('Allow in Thread handles this request');
  const secondActionRow = secondCard.children[0].children.find(
    (node: any) => node.type === 'group' && node.layout === 'spread',
  );
  expect(secondActionRow.children[0].children.map((node: any) => node.label)).toEqual([
    'Deny',
    'Allow once',
    'Allow in Thread',
  ]);
  expect(firstCardContent.findIndex((node: any) => node === actionRow)).toBeLessThan(
    firstCardContent.findIndex((node: any) => node.type === 'disclosure'),
  );
  const expandAction = findNode([firstCard], (node) => node.type === 'disclosure').actionId;
  const allowAction = findNode([firstCard], (node) => node.label === 'Allow once').actionId;
  const openAction = findNode([secondCard], (node) => node.label === 'Open Thread').actionId;
  harness.action(expandAction);
  await flush();
  expect(JSON.stringify(harness.tree)).toContain('Tool arguments');
  expect(validatePluginUiTree(harness.tree, 'thread.card')).toBe(true);
  harness.action(allowAction);
  await flush();
  const decision = harness.requests.find((request) => request.path === '/api/plugins/pico.permissions/approvals');
  expect(JSON.parse(decision?.init.body)).toEqual({
    executionId: firstExecutionId,
    allow: true,
    rememberForThread: false,
  });
  harness.action(openAction);
  await flush();
  expect(harness.requests).toContainEqual(expect.objectContaining({ action: 'open-thread', threadId: 'child' }));
  harness.action(findNode([secondCard], (node) => node.label === 'Allow in Thread').actionId);
  await flush();
  const rememberedDecision = harness.requests.filter(
    (request) => request.path === '/api/plugins/pico.permissions/approvals',
  )[1];
  expect(JSON.parse(rememberedDecision?.init.body)).toEqual({
    executionId: secondExecutionId,
    allow: true,
    rememberForThread: true,
  });
});

it('renders no child approval card when there are no pending descendant requests', async () => {
  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals', false);
  await flush();
  expect(harness.tree).toEqual([]);
});

it('keeps approval actions bound to the same execution across updates and ignores resolved requests', async () => {
  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals');
  await flush();
  const firstAllow = findNode([harness.tree[0]], (node) => node.label === 'Allow once').actionId;
  const secondDeny = findNode([harness.tree[1]], (node) => node.label === 'Deny').actionId;
  const [first, second] = harness.descendantApprovals;
  harness.setDescendantApprovals([second!, first!]);
  await flush();
  expect(validatePluginUiTree(harness.tree, 'thread.card')).toBe(true);
  harness.action(secondDeny);
  await flush();
  const decisions = () =>
    harness.requests.filter((request) => request.path === '/api/plugins/pico.permissions/approvals');
  expect(JSON.parse(decisions()[0]!.init.body)).toEqual({
    executionId: secondExecutionId,
    allow: false,
    rememberForThread: false,
  });
  harness.setDescendantApprovals([second!]);
  await flush();
  harness.action(firstAllow);
  await flush();
  expect(decisions()).toHaveLength(1);
});

it('shows an approval error in the child request card', async () => {
  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals', true, true);
  await flush();
  harness.action(findNode(harness.tree, (node) => node.label === 'Allow once').actionId);
  await flush();
  expect(JSON.stringify(harness.tree)).toContain('approval failed');
});

it('enables both automatic review settings for the selected child without deciding its pending request', async () => {
  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals');
  await flush();
  const action = findNode([harness.tree[0]], (node) => node.label === 'Switch to auto');
  expect(action.disabled).toBe(false);
  expect(JSON.stringify(harness.tree)).toContain('Allow in Thread handles this request');
  harness.action(action.actionId);
  await flush();
  const request = harness.requests.find((item) => item.path.endsWith('/child-auto-review'));
  expect(request?.init.method).toBe('POST');
  expect(JSON.parse(request?.init.body)).toEqual({ parentThreadId: 'thread', executionId: firstExecutionId });
  expect(harness.requests.some((item) => item.path.endsWith('/approvals') && item.init?.method === 'POST')).toBe(false);
  expect(harness.tree).toHaveLength(2);
  expect(findNode([harness.tree[0]], (node) => node.label === 'Switch to auto').disabled).toBe(true);
  expect(findNode([harness.tree[1]], (node) => node.label === 'Switch to auto').disabled).toBe(true);
  expect(validatePluginUiTree(harness.tree, 'thread.card')).toBe(true);
});

it('shows an error if enabling automatic review fails and keeps the control available', async () => {
  const harness = createHarness('pending', 'pending', 'ChildThreadApprovals', true, false, true);
  await flush();
  harness.action(findNode(harness.tree, (node) => node.label === 'Switch to auto').actionId);
  await flush();
  expect(JSON.stringify(harness.tree)).toContain('approval failed');
  expect(findNode(harness.tree, (node) => node.label === 'Switch to auto').disabled).toBe(false);
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
