import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { validatePluginUiTree } from '../../../plugins/ui-protocol.js';

function createHarness() {
  const source = readFileSync(new URL('../../../../plugins/pico.todo/webui/todo.js', import.meta.url), 'utf8');
  let tree: any[] = [];
  let onWindowMessage: ((event: any) => void) | undefined;
  const parent = {};
  const requests: Array<Record<string, any>> = [];
  const port = {
    onmessage: undefined as ((event: { data: any }) => void) | undefined,
    postMessage(message: Record<string, any>) {
      if (message.type === 'pico:plugin-ui:render') tree = message.tree;
      if (message.type === 'pico:plugin-ui:request') requests.push(message);
    },
    start() {},
  };
  runInNewContext(source, {
    document: {},
    window: {
      parent,
      addEventListener(_type: string, listener: (event: any) => void) {
        onWindowMessage = listener;
      },
    },
    queueMicrotask,
  });
  onWindowMessage?.({
    source: parent,
    data: {
      type: 'pico:plugin-ui:init',
      protocolVersion: 1,
      pluginId: 'pico.todo',
      entry: 'webui',
      viewType: 'component',
      viewId: 'TodoPanel',
      context: { thread: { id: 'thread-a' } },
    },
    ports: [port],
  });
  const respond = (request: Record<string, any>, value: unknown) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: request.id, ok: true, value } });
  const reject = (request: Record<string, any>, error: string) =>
    port.onmessage?.({ data: { type: 'pico:plugin-ui:response', id: request.id, ok: false, error } });
  return {
    get tree() {
      return tree;
    },
    requests,
    respond,
    reject,
    action(actionId: string, value?: string) {
      port.onmessage?.({
        data: { type: 'pico:plugin-ui:action', actionId, ...(value === undefined ? {} : { value }) },
      });
    },
    context(threadId?: string) {
      port.onmessage?.({
        data: { type: 'pico:plugin-ui:context', context: threadId ? { thread: { id: threadId } } : { thread: null } },
      });
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const text = (tree: unknown) => JSON.stringify(tree);
const assertValid = (tree: unknown) => expect(validatePluginUiTree(tree, 'thread.toolbar')).toBe(true);
const actionIds = (node: any): string[] => {
  if (Array.isArray(node)) return node.flatMap(actionIds);
  if (!node || typeof node !== 'object') return [];
  return [...(typeof node.actionId === 'string' ? [node.actionId] : []), ...Object.values(node).flatMap(actionIds)];
};
const threadResponse = (items: unknown[], revision = 1) => ({
  revision,
  items,
  openCount: items.filter((item: any) => item.status !== 'done').length,
});
const initialLoad = (h: ReturnType<typeof createHarness>, items: unknown[] = [], revision = 1) => {
  const request = h.requests[0];
  if (!request) throw new Error('Expected initial Todo request');
  expect(request.path).toBe('/api/plugins/pico.todo/threads?threadId=thread-a');
  h.respond(request, threadResponse(items, revision));
};
const bodyOf = (request: Record<string, any>) => JSON.parse(request.init.body);

it('renders phases and independent tasks in their server order and keeps the tree host-valid', async () => {
  const h = createHarness();
  initialLoad(h, [
    { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' },
    { id: 'task-root-a', type: 'task', title: 'Independent A', status: 'open' },
    { id: 'phase-b', type: 'phase', title: 'Phase B', status: 'open' },
    { id: 'task-root-b', type: 'task', title: 'Independent B', status: 'in_progress' },
    { id: 'task-child', type: 'task', title: 'Child task', phaseId: 'phase-a', status: 'open' },
  ]);
  await flush();
  assertValid(h.tree);
  const rendered = text(h.tree);
  expect(rendered.indexOf('"text":"Phase A"')).toBeLessThan(rendered.indexOf('"text":"Independent A"'));
  expect(rendered.indexOf('"text":"Independent A"')).toBeLessThan(rendered.indexOf('"text":"Phase B"'));
  expect(rendered.indexOf('"text":"Phase B"')).toBeLessThan(rendered.indexOf('"text":"Independent B"'));
  expect(rendered).toContain('Child task');
  expect(rendered).toContain('"text":"Open"');
  expect(rendered).not.toContain('move-up:phase-a');
  expect(rendered).not.toContain('delete:task-root-a');
  expect(rendered).not.toContain('add-task:phase-a');
  expect(actionIds(h.tree).length).toBe(new Set(actionIds(h.tree)).size);
  const nestedGroups = (node: any): any[] => {
    if (Array.isArray(node)) return node.flatMap(nestedGroups);
    if (!node || typeof node !== 'object') return [];
    return [
      ...(node.type === 'group' && node.layout === 'nested' ? [node] : []),
      ...Object.values(node).flatMap(nestedGroups),
    ];
  };
  const nested = nestedGroups(h.tree);
  expect(nested).toHaveLength(1);
  expect(text(nested[0])).toContain('Child task');
  expect(text(nested[0])).not.toContain('Independent A');
  expect(text(nested[0])).not.toContain('Independent B');
});

it('shows completed items, keeps status and phase controls inside Edit, and uses the compact add layout', async () => {
  const h = createHarness();
  initialLoad(h, [
    { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'done' },
    { id: 'task-a', type: 'task', title: 'Completed task', phaseId: 'phase-a', status: 'done' },
  ]);
  await flush();
  assertValid(h.tree);
  let rendered = text(h.tree);
  expect(rendered).toContain('Completed task');
  expect(rendered).not.toContain('Show completed');
  expect(rendered).not.toContain('Previous phases');
  expect(rendered).not.toContain('"label":"Title"');
  expect(rendered).toContain('"label":"Add item"');
  expect(rendered).toContain('"label":"Add"');
  expect(rendered).toContain('"layout":"form-row"');
  expect(rendered).toContain('"type":"separator"');
  expect(rendered).toContain('Todo items');
  expect(rendered).not.toContain('"label":"Status"');
  expect(rendered).not.toContain('"label":"Phase","value":"phase-a"');
  expect(rendered).toContain('"text":"Done"');

  h.action('more:task-a');
  rendered = text(h.tree);
  expect(rendered).toContain('"label":"Status"');
  expect(rendered).toContain('"actionId":"phase:task-a"');
  expect(actionIds(h.tree).filter((id) => id === 'more:task-a')).toHaveLength(1);
  h.action('more:phase-a');
  rendered = text(h.tree);
  expect(rendered).not.toContain('"actionId":"phase:task-a"');
  expect(rendered).toContain('"actionId":"status:phase-a"');
  expect(rendered).toContain('"actionId":"add-task:phase-a"');
  expect(actionIds(h.tree).length).toBe(new Set(actionIds(h.tree)).size);

  h.action('add-task:phase-a');
  rendered = text(h.tree);
  expect(rendered).toContain('"value":"phase-task"');
  expect(rendered).toContain('"actionId":"form.phase"');
  expect(rendered).toContain('"value":"phase-a"');
  expect(rendered).not.toContain('"actionId":"add-task:phase-a"');
  assertValid(h.tree);

  h.action('more:task-a');
  h.action('edit:task-a');
  rendered = text(h.tree);
  expect(rendered).toContain('"actionId":"edit.title"');
  expect(rendered).not.toContain('"actionId":"phase:task-a"');
  assertValid(h.tree);
});

it('shows a phase selector only when Task in phase is selected', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' }]);
  await flush();
  expect(text(h.tree)).not.toContain('"actionId":"form.phase"');
  h.action('form.type', 'phase-task');
  const rendered = text(h.tree);
  expect(rendered).toContain('"actionId":"form.phase"');
  expect(rendered).toContain('"label":"Phase A"');
  assertValid(h.tree);
});

it('sends add, edit, and move operations with the UI camelCase revision contract', async () => {
  const h = createHarness();
  initialLoad(
    h,
    [
      { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' },
      { id: 'task-a', type: 'task', title: 'Task A', phaseId: 'phase-a', status: 'open' },
      { id: 'task-b', type: 'task', title: 'Task B', phaseId: 'phase-a', status: 'open' },
    ],
    7,
  );
  await flush();
  assertValid(h.tree);

  h.action('form.type', 'task');
  h.action('form.title', 'Independent follow-up');
  h.action('add');
  let editRequest = h.requests.at(-1)!;
  expect(editRequest.path).toBe('/api/plugins/pico.todo/edit');
  expect(editRequest.init.method).toBe('POST');
  expect(bodyOf(editRequest)).toEqual({
    threadId: 'thread-a',
    expectedRevision: 7,
    operations: [{ action: 'add', type: 'task', title: 'Independent follow-up' }],
  });
  assertValid(h.tree);
  h.respond(editRequest, { revision: 8, items: [], openCount: 4 });
  await flush();
  const reload = h.requests.at(-1)!;
  h.respond(
    reload,
    threadResponse(
      [
        { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' },
        { id: 'task-a', type: 'task', title: 'Task A', phaseId: 'phase-a', status: 'open' },
        { id: 'task-b', type: 'task', title: 'Task B', phaseId: 'phase-a', status: 'open' },
        { id: 'task-root', type: 'task', title: 'Independent follow-up', status: 'open' },
      ],
      8,
    ),
  );
  await flush();

  h.action('more:task-a');
  h.action('edit:task-a');
  h.action('edit.title', 'Renamed task');
  h.action('edit.note', 'Keep the useful context');
  h.action('save:task-a');
  editRequest = h.requests.at(-1)!;
  expect(bodyOf(editRequest)).toEqual({
    threadId: 'thread-a',
    expectedRevision: 8,
    operations: [
      {
        action: 'update',
        id: 'task-a',
        title: 'Renamed task',
        note: 'Keep the useful context',
        nextAction: '',
        blocker: '',
      },
    ],
  });
  assertValid(h.tree);
  h.respond(editRequest, { revision: 9, items: [], openCount: 4 });
  await flush();
  h.respond(
    h.requests.at(-1)!,
    threadResponse(
      [
        { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' },
        {
          id: 'task-a',
          type: 'task',
          title: 'Renamed task',
          note: 'Keep the useful context',
          phaseId: 'phase-a',
          status: 'open',
        },
        { id: 'task-b', type: 'task', title: 'Task B', phaseId: 'phase-a', status: 'open' },
        { id: 'task-root', type: 'task', title: 'Independent follow-up', status: 'open' },
      ],
      9,
    ),
  );
  await flush();

  h.action('more:task-a');
  h.action('move-down:task-a');
  editRequest = h.requests.at(-1)!;
  expect(bodyOf(editRequest)).toEqual({
    threadId: 'thread-a',
    expectedRevision: 9,
    operations: [{ action: 'move', id: 'task-a', phaseId: 'phase-a', beforeId: null }],
  });
});

it('requires blocker text before committing a blocked task status', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'task-a', type: 'task', title: 'Resolve dependency', status: 'in_progress' }], 3);
  await flush();
  assertValid(h.tree);
  h.action('more:task-a');
  h.action('status:task-a', 'blocked');
  expect(h.requests).toHaveLength(1);
  expect(text(h.tree)).toContain('Blocker');
  assertValid(h.tree);
  h.action('blocked.value', 'Waiting on the access grant');
  h.action('blocked.save:task-a');
  const request = h.requests.at(-1)!;
  expect(bodyOf(request)).toEqual({
    threadId: 'thread-a',
    expectedRevision: 3,
    operations: [{ action: 'set_status', id: 'task-a', status: 'blocked', blocker: 'Waiting on the access grant' }],
  });
  assertValid(h.tree);
});

it('sends a status change when a task checkbox is toggled', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'task-a', type: 'task', title: 'Task', status: 'open' }], 3);
  await flush();
  h.action('more:task-a');
  h.action('status:task-a', 'done');
  expect(bodyOf(h.requests.at(-1)!)).toEqual({
    threadId: 'thread-a',
    expectedRevision: 3,
    operations: [{ action: 'set_status', id: 'task-a', status: 'done' }],
  });
});

it('keeps the editing revision if a background refresh observes a concurrent change', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'task-a', type: 'task', title: 'Original', status: 'open' }], 3);
  await flush();
  h.action('more:task-a');
  h.action('edit:task-a');
  h.action('edit.title', 'Local change');
  h.context('thread-a');
  await flush();
  h.respond(
    h.requests.at(-1)!,
    threadResponse([{ id: 'task-a', type: 'task', title: 'Remote change', status: 'open' }], 4),
  );
  await flush();
  h.action('save:task-a');
  expect(bodyOf(h.requests.at(-1)!).expectedRevision).toBe(3);
});

it('shows all root and phase tasks without pagination controls', async () => {
  const h = createHarness();
  const items = [
    { id: 'phase-a', type: 'phase', title: 'Paged phase', status: 'open' },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `root-${index}`,
      type: 'task',
      title: `Root task ${index}`,
      status: 'open',
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `child-${index}`,
      type: 'task',
      title: `Child task ${index}`,
      phaseId: 'phase-a',
      status: 'open',
    })),
  ];
  initialLoad(h, items);
  await flush();
  assertValid(h.tree);
  expect(text(h.tree)).not.toContain('Previous items');
  expect(text(h.tree)).not.toContain('Next items');
  expect(text(h.tree)).not.toContain('Previous tasks');
  expect(text(h.tree)).not.toContain('Next tasks');
  expect(text(h.tree)).toContain('Root task 0');
  expect(text(h.tree)).toContain('Root task 8');
  expect(text(h.tree)).toContain('Child task 9');
});

it('keeps a maximum 100-item Todo tree within host limits', async () => {
  const h = createHarness();
  initialLoad(h, [
    { id: 'phase-a', type: 'phase', title: 'Phase A', status: 'open' },
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `task-${index}`,
      type: 'task',
      title: `Task ${index}`,
      phaseId: 'phase-a',
      status: 'open',
    })),
  ]);
  await flush();
  assertValid(h.tree);
  expect(text(h.tree)).toContain('Task 98');
  expect(actionIds(h.tree).length).toBeLessThanOrEqual(512);
});

it('clears the open menu on thread changes and returns cleanly from Edit', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'task-a', type: 'task', title: 'Thread A task', status: 'open' }]);
  await flush();
  h.action('more:task-a');
  expect(text(h.tree)).toContain('delete:task-a');

  h.context('thread-b');
  expect(text(h.tree)).not.toContain('delete:task-a');
  const threadBLoad = h.requests.at(-1)!;
  expect(threadBLoad.path).toBe('/api/plugins/pico.todo/threads?threadId=thread-b');
  h.respond(threadBLoad, threadResponse([{ id: 'task-b', type: 'task', title: 'Thread B task', status: 'open' }]));
  await flush();
  h.action('more:task-b');
  h.action('edit:task-b');
  expect(text(h.tree)).toContain('edit.title');
  h.action('cancel-edit');
  expect(text(h.tree)).not.toContain('edit.title');
  expect(text(h.tree)).not.toContain('delete:task-b');
  assertValid(h.tree);
});

it('keeps the rendered tree within host limits with long notes and many long phase names', async () => {
  const h = createHarness();
  const phases = Array.from({ length: 80 }, (_, i) => ({
    id: `phase-${i}`,
    type: 'phase',
    title: `${i} ${'P'.repeat(230)}`,
    status: 'open',
    note: 'N'.repeat(4000),
  }));
  const tasks = Array.from({ length: 16 }, (_, i) => ({
    id: `task-${i}`,
    type: 'task',
    title: `Task ${i}`,
    status: 'open',
    phaseId: `phase-${Math.floor(i / 4)}`,
    note: 'N'.repeat(4000),
    nextAction: 'A'.repeat(4000),
    blocker: 'B'.repeat(4000),
  }));
  initialLoad(h, [...phases, ...tasks]);
  await flush();
  assertValid(h.tree);
});

it('shows a revision conflict, reloads the latest server revision, and displays refreshed items', async () => {
  const h = createHarness();
  initialLoad(h, [{ id: 'task-a', type: 'task', title: 'Old title', status: 'open' }], 2);
  await flush();
  h.action('more:task-a');
  h.action('edit:task-a');
  h.action('edit.title', 'Local title');
  h.action('save:task-a');
  const mutation = h.requests.at(-1)!;
  expect(bodyOf(mutation).expectedRevision).toBe(2);
  h.reject(mutation, '409 revision conflict');
  await flush();
  assertValid(h.tree);
  const refresh = h.requests.at(-1)!;
  expect(refresh.path).toBe('/api/plugins/pico.todo/threads?threadId=thread-a');
  h.respond(
    refresh,
    threadResponse([{ id: 'task-a', type: 'task', title: 'Changed elsewhere', status: 'in_progress' }], 4),
  );
  await flush();
  assertValid(h.tree);
  expect(text(h.tree)).toContain('latest version has been loaded');
  expect(text(h.tree)).toContain('Changed elsewhere');
  expect(text(h.tree)).not.toContain('Old title');
  expect(text(h.tree)).toContain('1 unfinished');
});
