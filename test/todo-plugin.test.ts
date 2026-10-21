import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import { todoPlugin } from '../src/plugins/todo.js';
import type { PluginContext } from '../src/plugins/host.js';

function setup() {
  const state = new Map<string, unknown>();
  const records: CanonicalRecord[] = [];
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { thread?: Thread; executionId: string }) => unknown
  >();
  let failAudit = true;
  const thread = { id: 'todo-thread', projectId: 'project' } as Thread;
  const context = {
    threads: { get: (id: string) => (id === thread.id ? thread : null), list: () => [thread] },
    tools: {
      register: (
        definition: { name: string },
        run: (args: Record<string, unknown>, context: { thread?: Thread; executionId: string }) => unknown,
      ) => tools.set(definition.name, run),
    },
    pipelines: { use: () => undefined },
    commands: { register: () => undefined },
    ui: { contribute: () => undefined, registerPage: () => undefined },
    http: { register: () => undefined },
    state: {
      get: <T>(key: string, fallback: T): T => (state.has(key) ? (state.get(key) as T) : fallback),
      set: <T>(key: string, value: T): void => {
        state.set(key, value);
      },
      transaction: <T>(run: () => T): T => {
        const previous = new Map(state);
        const recordCount = records.length;
        try {
          return run();
        } catch (error) {
          state.clear();
          for (const [key, value] of previous) state.set(key, value);
          records.splice(recordCount);
          throw error;
        }
      },
    },
    canonical: {
      append: (threadId: string, payload: Record<string, unknown>) => {
        if (failAudit) throw new Error('simulated audit failure');
        const record = {
          id: `record-${records.length + 1}`,
          threadId,
          seq: records.length + 1,
          kind: 'plugin',
          payload,
          createdAt: '',
        } as CanonicalRecord;
        records.push(record);
        return record;
      },
      list: (threadId: string) => records.filter((record) => record.threadId === threadId),
      read: (threadId: string) => records.filter((record) => record.threadId === threadId),
      subscribe: () => () => undefined,
    },
  } as unknown as PluginContext;
  void todoPlugin.activate?.(context);
  return {
    state,
    records,
    tools,
    thread,
    allowAudit: () => {
      failAudit = false;
    },
  };
}

describe('Todo plugin transactions', () => {
  it('rolls back Todo state and retry identity when its audit append fails', () => {
    const env = setup();
    expect(() =>
      env.tools.get('todo_add')!(
        { title: 'Atomic item', operation_id: 'todo-op' },
        {
          thread: env.thread,
          executionId: 'execution',
        },
      ),
    ).toThrow('simulated audit failure');
    expect(env.state.has('byThread')).toBe(false);
    expect(env.records).toEqual([]);

    env.allowAudit();
    const result = env.tools.get('todo_add')!(
      { title: 'Atomic item', operation_id: 'todo-op' },
      {
        thread: env.thread,
        executionId: 'execution',
      },
    );
    expect(result).toMatchObject({ created: true, item: { title: 'Atomic item' } });
    expect(env.records).toHaveLength(1);
  });
});
