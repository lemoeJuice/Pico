import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread, UiContribution } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import { formatOpenTodos, todoPlugin } from '../src/plugins/todo.js';
import type { ProjectionInput } from '../src/runtime/stages.js';

function harness() {
  const values = new Map<string, unknown>();
  const records = new Map<string, CanonicalRecord[]>();
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { executionId: string; thread?: Thread }) => unknown
  >();
  const contributions: UiContribution[] = [];
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  let project:
    | ((input: ProjectionInput, next: (input: ProjectionInput) => Promise<ProjectionInput>) => Promise<ProjectionInput>)
    | null = null;
  const thread = { id: 'thread-1' } as Thread;
  const context = {
    tools: {
      register(
        definition: { name: string },
        execute: (args: Record<string, unknown>, toolContext: { executionId: string; thread?: Thread }) => unknown,
      ) {
        tools.set(definition.name, execute);
      },
    },
    pipelines: {
      use(_stage: string, interceptor: typeof project) {
        project = interceptor;
      },
    },
    commands: { register() {} },
    ui: {
      contribute(contribution: UiContribution) {
        contributions.push(contribution);
      },
    },
    http: {
      register(method: string, path: string, handler: (request: { body: unknown; query: URLSearchParams }) => unknown) {
        routes.set(`${method} ${path}`, handler);
      },
    },
    state: {
      get<T>(key: string, fallback: T): T {
        return (values.has(key) ? values.get(key) : fallback) as T;
      },
      set<T>(key: string, value: T) {
        values.set(key, structuredClone(value));
      },
      transaction<T>(run: () => T): T {
        return run();
      },
      subscribe() {
        return () => undefined;
      },
    },
    canonical: {
      append(threadId: string, payload: Record<string, unknown>) {
        const list = records.get(threadId) ?? [];
        const record = {
          id: `record-${list.length + 1}`,
          threadId,
          seq: list.length + 1,
          kind: 'plugin',
          payload,
          createdAt: new Date().toISOString(),
        } as CanonicalRecord;
        records.set(threadId, [...list, record]);
        return record;
      },
      list(threadId: string) {
        return records.get(threadId) ?? [];
      },
      read(threadId: string) {
        return records.get(threadId) ?? [];
      },
      subscribe() {
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  todoPlugin.activate?.(context);
  const runTool = (name: string, args: Record<string, unknown>, executionId = `exec-${Math.random()}`) => {
    const implementation = tools.get(name);
    if (!implementation) throw new Error(`Tool not found: ${name}`);
    return implementation(args, { executionId, thread });
  };
  return { context, thread, records, tools, routes, contributions, getProjection: () => project, runTool };
}

describe('Todo plugin', () => {
  it('registers model tools without a Thread toolbar contribution', () => {
    const env = harness();
    expect(env.tools.has('todo_add')).toBe(true);
    expect(env.tools.has('todo_list')).toBe(true);
    expect(env.contributions).toEqual([]);
  });

  it('keeps add retries idempotent and preserves concurrent additions', () => {
    const env = harness();
    const first = env.runTool('todo_add', { title: 'Inspect the deployment', operation_id: 'add-1' }, 'call-a') as {
      item: { id: string };
    };
    const retry = env.runTool('todo_add', { title: 'Inspect the deployment', operation_id: 'add-1' }, 'call-a') as {
      item: { id: string };
    };
    const second = env.runTool('todo_add', { title: 'Review the UI', operation_id: 'add-2' }, 'call-b') as {
      item: { id: string };
    };
    expect(retry.item.id).toBe(first.item.id);
    expect(second.item.id).not.toBe(first.item.id);
    expect(env.runTool('todo_list', {}, 'call-c')).toMatchObject({ openCount: 2 });
    expect(env.records.get(env.thread.id)).toHaveLength(2);
  });

  it('injects open items with stable source IDs and removes completed items from projection', async () => {
    const env = harness();
    const { item } = env.runTool(
      'todo_add',
      { title: 'Run focused tests', priority: 5, next_action: 'Start with plugin tests' },
      'call-a',
    ) as { item: { id: string } };
    const base: ProjectionInput = {
      thread: env.thread,
      records: [],
      through: 0,
      systemPrompt: 'base',
      turns: [],
      tools: [],
    };
    const invoke = async () => env.getProjection()!(base, async (input) => input);
    const projected = await invoke();
    expect(projected.turns.at(-1)).toMatchObject({ kind: 'message', role: 'user' });
    expect(projected.turns.at(-1)?.kind === 'message' && projected.turns.at(-1)?.content).toContain(`[${item.id}]`);
    expect(projected.turns.at(-1)?.kind === 'message' && projected.turns.at(-1)?.content).toContain(
      'Next: Start with plugin tests',
    );
    expect(projected.provenance).toMatchObject([
      { id: `pico.todo:${item.id}`, sourcePluginId: 'pico.todo', disposition: 'raw', turnIndex: 0 },
    ]);
    env.runTool('todo_complete', { id: item.id, operation_id: 'done-1' }, 'call-done');
    expect((await invoke()).turns).toEqual([]);
    expect(env.runTool('todo_list', {}, 'call-list')).toMatchObject({ openCount: 0 });
  });

  it('keeps completed items in history and supports thread-scoped manual API updates', () => {
    const env = harness();
    const response = env.routes.get('POST /items')!({
      body: { threadId: env.thread.id, title: 'Check source link', operationId: 'ui-add-1' },
      query: new URLSearchParams(),
    }) as { item: { id: string } };
    env.routes.get('PATCH /items')!({
      body: { threadId: env.thread.id, id: response.item.id, status: 'done', operationId: 'ui-done-1' },
      query: new URLSearchParams(),
    });
    const list = env.routes.get('GET /threads')!({
      body: null,
      query: new URLSearchParams({ threadId: env.thread.id }),
    }) as { items: Array<{ status: string }> };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.status).toBe('done');
    expect(env.records.get(env.thread.id)?.map((record) => (record.payload as { action: string }).action)).toEqual([
      'todo.updated',
      'todo.updated',
    ]);
  });

  it('sorts projection by priority and omits a blank projection', () => {
    expect(formatOpenTodos([])).toBe('');
  });
});
