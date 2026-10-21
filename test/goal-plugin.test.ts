import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Execution, Thread } from '../src/core/types.js';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import { goalPlugin } from '../src/plugins/goal.js';
import type { PluginContext } from '../src/plugins/host.js';
import type { ProjectionInput } from '../src/runtime/stages.js';

function setup() {
  const state = new Map<string, unknown>();
  const records: CanonicalRecord[] = [];
  let thread: Thread = {
    id: 'thread-1',
    projectId: 'project-1',
    executorId: 'executor-1',
    executorKind: 'runtime',
    executorRemote: false,
    executorLabel: 'Runtime',
    workspacePath: '/workspace',
    title: 'Goal test',
    parentThreadId: null,
    createdByAgent: false,
    pauseRequested: false,
    pauseReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'idle',
  };
  const executions = new Map<string, Execution>();
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { thread?: Thread }) => Promise<unknown> | unknown
  >();
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  const pipelines = new ExecutionPipelines();
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  let continuation: ((threadId: string) => boolean) | undefined;
  let failCanonicalAppend = false;
  const context = {
    threads: {
      get: (id: string) => (id === thread.id ? thread : null),
      list: () => [thread],
      tools: async () => [],
      binding: () => null,
      create: () => thread,
      send: () => ({ delivered: true, threadId: thread.id, messageId: 'message' }),
      pause: (id: string) => {
        pauseCalls.push(id);
        thread = { ...thread, state: 'paused', pauseRequested: true };
        return thread;
      },
      resume: (id: string) => {
        resumeCalls.push(id);
        thread = { ...thread, state: 'idle', pauseRequested: false };
        return thread;
      },
    },
    executions: {
      get: (id: string) => executions.get(id) ?? null,
      fail: () => {
        throw new Error('unused');
      },
      subscribe: () => () => undefined,
    },
    models: {
      complete: async () => {
        throw new Error('unused');
      },
      history: () => [],
      subscribe: () => () => undefined,
      registerProvider: () => undefined,
    },
    continuations: {
      register: (callback: (threadId: string) => boolean) => {
        continuation = callback;
        return () => undefined;
      },
    },
    tools: {
      register: (
        definition: { name: string },
        execute: (args: Record<string, unknown>, context: { thread?: Thread }) => unknown,
      ) => {
        tools.set(definition.name, execute);
      },
    },
    pipelines: {
      use: (stage: string, interceptor: never) => pipelines.use(stage as never, goalPlugin.id, interceptor),
    },
    commands: { register: () => undefined },
    ui: { contribute: () => undefined, registerPage: () => undefined },
    http: {
      register: (
        method: string,
        path: string,
        handler: (request: { body: unknown; query: URLSearchParams }) => unknown,
      ) => {
        routes.set(`${method} ${path}`, handler);
      },
    },
    state: {
      get: <T>(key: string, fallback: T): T => (state.has(key) ? (state.get(key) as T) : fallback),
      set: <T>(key: string, value: T) => {
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
      subscribe: () => () => undefined,
    },
    canonical: {
      append: (threadId: string, payload: Record<string, unknown>) => {
        if (failCanonicalAppend) throw new Error('simulated audit failure');
        const record = {
          id: `record-${records.length + 1}`,
          threadId,
          seq: records.length + 1,
          kind: 'plugin',
          payload,
          createdAt: new Date().toISOString(),
        } as CanonicalRecord;
        records.push(record);
        return record;
      },
      list: (threadId: string) => records.filter((record) => record.threadId === threadId),
      read: (threadId: string, options?: { afterSeq?: number }) =>
        records.filter((record) => record.threadId === threadId && record.seq > (options?.afterSeq ?? 0)),
      subscribe: () => () => undefined,
    },
  } as unknown as PluginContext;
  void goalPlugin.activate?.(context);
  const route = (
    path: string,
    body: unknown = {},
    query = new URLSearchParams(),
    method = path === '/goal' && query.size > 0 ? 'GET' : path === '/goal' ? 'PUT' : 'POST',
  ) => {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`Missing route ${method} ${path}`);
    return handler({ body, query });
  };
  return {
    context,
    thread,
    state,
    records,
    executions,
    tools,
    pipelines,
    pauseCalls,
    resumeCalls,
    route,
    continuation: () => continuation!,
    setFailCanonicalAppend(value: boolean) {
      failCanonicalAppend = value;
    },
  };
}

describe('Goal plugin', () => {
  it('keeps the continuation check read-only and does not pause for pending model steps', () => {
    const env = setup();
    env.route('/goal', {
      threadId: env.thread.id,
      text: 'Keep the ledger consistent',
      completionCriteria: 'Audit commits',
    });
    const existingState = structuredClone(env.state.get('goals'));
    const auditCount = env.records.length;
    for (let seq = 2; seq < 14; seq += 1) {
      env.records.push({
        id: `assistant-pending-${seq}`,
        threadId: env.thread.id,
        seq,
        kind: 'assistant',
        payload: { content: 'step', toolCalls: [] },
        createdAt: '',
      });
    }
    expect(env.continuation()(env.thread.id)).toBe(true);
    expect(env.continuation()(env.thread.id)).toBe(true);
    expect(env.state.get('goals')).toEqual(existingState);
    expect(env.records).toHaveLength(auditCount + 12);
    expect(env.pauseCalls).toEqual([]);
  });

  it('rolls back initial Goal creation when its Canonical audit write fails', () => {
    const env = setup();
    env.setFailCanonicalAppend(true);
    expect(() =>
      env.route('/goal', {
        threadId: env.thread.id,
        text: 'Atomic create',
        completionCriteria: 'No partial state',
      }),
    ).toThrow('simulated audit failure');
    expect(env.state.has('goals')).toBe(false);
    expect(env.records).toHaveLength(0);
  });

  it('lets the user define and manage a Goal, projects it with provenance, and keeps edits out of agent tools', async () => {
    const env = setup();
    const created = env.route('/goal', {
      threadId: env.thread.id,
      text: 'Ship the migration',
      constraints: 'Keep API compatible',
      completionCriteria: 'Tests pass and migration verified',
    }) as { goal: { id: string; status: string } };
    expect(created.goal.status).toBe('active');
    const input: ProjectionInput = {
      thread: env.thread,
      records: [],
      through: 0,
      systemPrompt: '',
      turns: [],
      tools: [],
    };
    const projected = await env.pipelines.run<ProjectionInput, ProjectionInput>(
      'projection',
      input,
      async (next) => next,
    );
    expect(projected.turns).toHaveLength(1);
    expect(projected.turns[0]?.kind).toBe('message');
    expect(projected.turns[0]?.kind === 'message' ? projected.turns[0].content : '').toContain('Ship the migration');
    expect(projected.provenance).toEqual([
      expect.objectContaining({ sourcePluginId: 'pico.goal', kind: 'plugin', disposition: 'raw', turnIndex: 0 }),
    ]);
    expect(env.tools.has('goal_checkpoint')).toBe(true);
    expect([...env.tools.keys()]).not.toContain('goal_edit');

    env.route('/goal/action', { threadId: env.thread.id, action: 'pause' });
    expect(
      (env.route('/goal', {}, new URLSearchParams({ threadId: env.thread.id })) as { goal: { status: string } }).goal
        .status,
    ).toBe('paused');
    env.route('/goal/action', { threadId: env.thread.id, action: 'resume' });
    expect(env.resumeCalls).toEqual([env.thread.id]);
    const cleared = env.route('/goal/action', { threadId: env.thread.id, action: 'clear' }) as {
      goal: { status: string };
    };
    expect(cleared.goal.status).toBe('cleared');
  });

  it('requires verifiable same-Thread evidence before completion and does not pause by model-step count', async () => {
    const env = setup();
    env.route('/goal', {
      threadId: env.thread.id,
      text: 'Verify the fix',
      completionCriteria: 'Regression test passes',
    });
    const checkpoint = env.tools.get('goal_checkpoint')!;
    await expect(
      Promise.resolve(
        checkpoint(
          {
            progress: 'Done',
            status: 'completed',
            verificationSummary: 'Looks good',
            verificationExecutionId: 'missing',
          },
          { thread: env.thread },
        ),
      ),
    ).rejects.toThrow('completed execution in this Thread');
    env.executions.set('exec-1', {
      id: 'exec-1',
      threadId: env.thread.id,
      batchId: null,
      kind: 'tool',
      toolName: 'test',
      arguments: {},
      status: 'completed',
      result: 'pass',
      error: null,
      createdAt: '',
      updatedAt: '',
    });
    await checkpoint(
      {
        progress: 'Regression test passed',
        status: 'completed',
        verificationSummary: 'Execution exec-1 returned pass',
        verificationExecutionId: 'exec-1',
      },
      { thread: env.thread },
    );
    expect(
      (
        env.route('/goal', {}, new URLSearchParams({ threadId: env.thread.id })) as {
          goal: { status: string; evidence: { id: string } };
        }
      ).goal,
    ).toMatchObject({ status: 'completed', evidence: { id: 'exec-1' } });

    env.route('/goal', { threadId: env.thread.id, text: 'Another task', completionCriteria: 'Verified' });
    for (let index = 1; index <= 13; index += 1) {
      env.records.push({
        id: `assistant-${index}`,
        threadId: env.thread.id,
        seq: env.records.length + 1,
        kind: 'assistant',
        payload: { content: `step ${index}`, toolCalls: [] },
        createdAt: '',
      });
      expect(env.continuation()(env.thread.id)).toBe(true);
    }
    expect(env.continuation()(env.thread.id)).toBe(true);
    expect(env.pauseCalls).toEqual([]);
    expect(
      (
        env.route('/goal', {}, new URLSearchParams({ threadId: env.thread.id })) as {
          goal: { status: string; blocker: string };
        }
      ).goal,
    ).toMatchObject({ status: 'active', blocker: '' });
  });
});
