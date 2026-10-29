import { describe, expect, it } from 'vitest';
import type { Thread, ToolDefinition } from '../../../core/types.js';
import { todoPlugin, type TodoItem } from '../../../plugins/todo.js';
import type { PluginContext, PluginHttpRequest } from '../../../plugins/host.js';
import type { ProjectionInput } from '../../../runtime/stages.js';

type ToolRun = (args: Record<string, unknown>, context: { thread?: Thread; executionId: string }) => unknown;
type HttpHandler = (request: PluginHttpRequest) => unknown;
type Projection = (
  input: ProjectionInput,
  next: (input: ProjectionInput) => Promise<ProjectionInput>,
) => Promise<ProjectionInput>;

function setup(initialState?: unknown) {
  const state = new Map<string, unknown>();
  const tools = new Map<string, { definition: ToolDefinition; run: ToolRun }>();
  const routes = new Map<string, HttpHandler>();
  const thread = { id: 'todo-thread', projectId: 'project' } as Thread;
  let projection: Projection | undefined;
  let contribution: unknown;
  if (initialState !== undefined) state.set('byThread', initialState);
  const context = {
    threads: { get: (id: string) => (id === thread.id ? thread : null), list: () => [thread] },
    tools: { register: (definition: ToolDefinition, run: ToolRun) => tools.set(definition.name, { definition, run }) },
    pipelines: {
      use: (_stage: string, interceptor: Projection) => {
        projection = interceptor;
      },
    },
    ui: { contribute: (value: unknown) => (contribution = value), registerPage: () => undefined },
    http: {
      register: (method: string, path: string, handler: HttpHandler) => routes.set(`${method} ${path}`, handler),
    },
    state: {
      get: <T>(key: string, fallback: T): T => (state.has(key) ? (state.get(key) as T) : fallback),
      set: <T>(key: string, value: T): void => {
        state.set(key, value);
      },
      transaction: <T>(run: () => T): T => {
        const previous = new Map(state);
        try {
          return run();
        } catch (error) {
          state.clear();
          for (const [key, value] of previous) state.set(key, value);
          throw error;
        }
      },
      subscribe: () => () => undefined,
    },
  } as unknown as PluginContext;
  void todoPlugin.activate?.(context);
  return {
    state,
    tools,
    routes,
    thread,
    get projection() {
      return projection;
    },
    contribution,
    tool(name: string, args: Record<string, unknown> = {}) {
      const registered = tools.get(name);
      if (!registered) throw new Error(`Tool ${name} was not registered.`);
      return registered.run(args, { thread, executionId: 'execution' });
    },
    route(method: string, path: string, body: unknown = {}, query = new URLSearchParams()) {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Route ${method} ${path} was not registered.`);
      return handler({ body, query, origin: null });
    },
  };
}

const addPhase = (title: string, client_ref: string) => ({ action: 'add', type: 'phase', title, client_ref });
const addTask = (title: string, phase_ref?: string) => ({
  action: 'add',
  type: 'task',
  title,
  ...(phase_ref ? { phase_ref } : {}),
});

describe('Todo plugin', () => {
  it('registers the thread panel, revisioned API, and two model tools', () => {
    const env = setup();
    expect(env.contribution).toMatchObject({
      slot: 'thread.toolbar',
      id: 'todo-panel',
      entry: 'webui',
      component: 'TodoPanel',
    });
    expect(env.routes.has('GET /threads')).toBe(true);
    expect(env.routes.has('POST /edit')).toBe(true);
    expect([...env.tools.keys()]).toEqual(expect.arrayContaining(['todo_list', 'todo_edit']));
    expect(env.tools.has('todo_add')).toBe(false);
    expect(env.tools.has('todo_complete')).toBe(false);
    expect(env.tools.get('todo_edit')!.definition.parameters).toMatchObject({
      type: 'object',
      required: ['expected_revision', 'operations'],
      additionalProperties: false,
    });
  });

  it('lists revisioned phases and tasks and applies a batch with same-batch phase references', () => {
    const env = setup();
    const added = env.tool('todo_edit', {
      expected_revision: 0,
      operations: [addPhase('Ship the release', 'release'), addTask('Write notes', 'release'), addTask('Tag build')],
    }) as { revision: number; items: TodoItem[] };
    expect(added.revision).toBe(1);
    expect(added.items).toHaveLength(3);
    const phase = added.items.find((item) => item.type === 'phase')!;
    const linked = added.items.find((item) => item.title === 'Write notes')!;
    expect(linked).toMatchObject({ type: 'task', phaseId: phase.id, status: 'open' });
    expect(added.items.find((item) => item.title === 'Tag build')).toMatchObject({ type: 'task', status: 'open' });
    expect(env.tool('todo_list')).toMatchObject({ revision: 1, openCount: 3, items: added.items });
    expect(env.route('GET', '/threads', {}, new URLSearchParams({ threadId: env.thread.id }))).toMatchObject({
      revision: 1,
      openCount: 3,
      items: added.items,
    });
  });

  it('validates phase completion and automatically reopens a phase when a task is reopened', () => {
    const env = setup();
    const batch = env.tool('todo_edit', {
      expected_revision: 0,
      operations: [addPhase('Prepare launch', 'p'), addTask('Verify build', 'p')],
    }) as { revision: number; items: TodoItem[] };
    const phase = batch.items.find((item) => item.type === 'phase')!;
    const task = batch.items.find((item) => item.type === 'task')!;
    expect(() =>
      env.tool('todo_edit', {
        expected_revision: 1,
        operations: [{ action: 'set_status', id: phase.id, status: 'done' }],
      }),
    ).toThrow();
    const doneTask = env.tool('todo_edit', {
      expected_revision: 1,
      operations: [{ action: 'set_status', id: task.id, status: 'done' }],
    }) as { revision: number; items: TodoItem[] };
    expect(doneTask.items.find((item) => item.id === phase.id)?.status).toBe('open');
    const donePhase = env.tool('todo_edit', {
      expected_revision: 2,
      operations: [{ action: 'set_status', id: phase.id, status: 'done' }],
    }) as { revision: number; items: TodoItem[] };
    expect(donePhase.items.find((item) => item.id === phase.id)?.status).toBe('done');
    const reopened = env.tool('todo_edit', {
      expected_revision: 3,
      operations: [{ action: 'set_status', id: task.id, status: 'open' }],
    }) as { revision: number; items: TodoItem[] };
    expect(reopened.items.find((item) => item.id === phase.id)?.status).toBe('open');
  });

  it('supports editing fields, moving/reordering tasks, and deleting a phase while retaining tasks as roots', () => {
    const env = setup();
    const initial = env.tool('todo_edit', {
      expected_revision: 0,
      operations: [addPhase('One', 'one'), addPhase('Two', 'two'), addTask('A', 'one'), addTask('B', 'one')],
    }) as { revision: number; items: TodoItem[] };
    const [one, two] = initial.items.filter((item) => item.type === 'phase');
    const [a, b] = initial.items.filter((item) => item.type === 'task');
    const edited = env.tool('todo_edit', {
      expected_revision: 1,
      operations: [
        {
          action: 'update',
          id: a!.id,
          title: 'Prepare A',
          note: 'Keep context',
          next_action: 'Open checklist',
          blocker: 'Waiting for access',
        },
        { action: 'set_status', id: a!.id, status: 'blocked', blocker: 'Waiting for access' },
        { action: 'move', id: b!.id, phase_id: two!.id, before_id: null },
      ],
    }) as { revision: number; items: TodoItem[] };
    expect(edited.items.find((item) => item.id === a!.id)).toMatchObject({
      title: 'Prepare A',
      note: 'Keep context',
      nextAction: 'Open checklist',
      status: 'blocked',
      blocker: 'Waiting for access',
    });
    expect(edited.items.find((item) => item.id === b!.id)?.phaseId).toBe(two!.id);
    const deleted = env.tool('todo_edit', {
      expected_revision: 2,
      operations: [{ action: 'delete', id: one!.id }],
    }) as { revision: number; items: TodoItem[] };
    expect(deleted.items.find((item) => item.id === a!.id)?.phaseId).toBeUndefined();
    expect(deleted.items.find((item) => item.id === b!.id)?.phaseId).toBe(two!.id);
  });

  it('rejects stale revisions atomically for both model and UI edits', () => {
    const env = setup();
    env.tool('todo_edit', { expected_revision: 0, operations: [addPhase('Existing', 'p')] });
    const before = env.tool('todo_list');
    expect(() =>
      env.tool('todo_edit', { expected_revision: 0, operations: [addPhase('Must not persist', 'x')] }),
    ).toThrow(/revision/i);
    expect(env.tool('todo_list')).toEqual(before);
    expect(() =>
      env.route('POST', '/edit', {
        threadId: env.thread.id,
        expectedRevision: 0,
        operations: [addTask('Also rejected')],
      }),
    ).toThrow(/revision/i);
    expect(env.tool('todo_list')).toEqual(before);
  });

  it('rolls back an entire batch if a later operation is invalid', () => {
    const env = setup();
    const before = env.tool('todo_list');
    expect(() =>
      env.tool('todo_edit', {
        expected_revision: 0,
        operations: [
          addPhase('Must not persist', 'p'),
          { action: 'add', type: 'task', title: 'Bad', phase_id: 'missing' },
        ],
      }),
    ).toThrow(/not found/i);
    expect(env.tool('todo_list')).toEqual(before);
  });

  it('retains the order of phases and standalone tasks across moves', () => {
    const env = setup();
    const initial = env.tool('todo_edit', {
      expected_revision: 0,
      operations: [addPhase('Phase A', 'a'), addTask('Root task'), addPhase('Phase B', 'b'), addTask('Child', 'a')],
    }) as { items: TodoItem[] };
    const root = initial.items.find((item) => item.title === 'Root task')!;
    const phase = initial.items.find((item) => item.title === 'Phase A')!;
    const moved = env.tool('todo_edit', {
      expected_revision: 1,
      operations: [{ action: 'move', id: root.id, phase_id: null, before_id: phase.id }],
    }) as { items: TodoItem[] };
    expect(moved.items.map((item) => item.title)).toEqual(['Root task', 'Phase A', 'Child', 'Phase B']);
  });

  it('migrates arbitrary-depth legacy trees without losing entries or relationship context', () => {
    const env = setup({
      'todo-thread': [
        { id: 'root', title: 'Legacy project', status: 'open' },
        { id: 'child', title: 'Legacy child', status: 'done', parentId: 'root' },
        { id: 'grandchild', title: 'Legacy grandchild', status: 'open', parentId: 'child' },
        { id: 'orphan', title: 'Legacy orphan', status: 'open', parentId: 'missing' },
      ],
    });
    const result = env.tool('todo_list', { include_completed: true }) as { items: TodoItem[]; openCount: number };
    expect(result.items).toHaveLength(4);
    expect(result.items.find((item) => item.id === 'root')).toMatchObject({ type: 'phase', status: 'open' });
    expect(result.items.find((item) => item.id === 'child')).toMatchObject({
      type: 'task',
      status: 'done',
      phaseId: 'root',
    });
    expect(result.items.find((item) => item.id === 'grandchild')).toMatchObject({
      type: 'task',
      status: 'open',
      phaseId: 'root',
    });
    expect(result.items.find((item) => item.id === 'orphan')).toMatchObject({ type: 'task', status: 'open' });
    expect(result.items.find((item) => item.id === 'grandchild')?.note).toMatch(/child/);
    expect(result.openCount).toBe(3);
  });

  it('keeps the capability hint stable and outside turns, and filters it by available Todo tools', async () => {
    const env = setup();
    const toolDefs = [...env.tools.values()].map((tool) => tool.definition);
    const input = {
      thread: env.thread,
      records: [],
      through: 0,
      systemPrompt: 'Base instructions',
      turns: [],
      tools: toolDefs,
    } as unknown as ProjectionInput;
    const projected = await env.projection!(input, async (next) => next);
    env.tool('todo_edit', { expected_revision: 0, operations: [addPhase('Mutable title is never prompt text', 'p')] });
    const again = await env.projection!(input, async (next) => next);
    expect(projected.systemPrompt).toBe(again.systemPrompt);
    expect(projected.systemPrompt).toContain('todo_list');
    expect(projected.systemPrompt).not.toContain('Mutable title is never prompt text');
    expect(projected.turns).toEqual([]);
    expect(projected.provenance).toBeUndefined();
    const noTodo = await env.projection!({ ...input, tools: [] } as unknown as ProjectionInput, async (next) => next);
    expect(noTodo.systemPrompt).toBe('Base instructions');
    expect(noTodo.turns).toEqual([]);
  });
});
