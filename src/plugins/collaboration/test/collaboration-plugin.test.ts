import { describe, expect, it } from 'vitest';
import type { Thread } from '../../../core/types.js';
import type { CatalogSelection } from '../../../contracts/model-catalog.js';
import { ExecutionPipelines } from '../../../core/pipeline.js';
import { collaborationPlugin } from '../../../plugins/collaboration.js';
import type { PluginContext } from '../../../plugins/host.js';

function makeThread(id: string, projectId = 'project-1', parentThreadId: string | null = null): Thread {
  return {
    id,
    projectId,
    executorId: `executor-${id}`,
    executorKind: 'host',
    executorRemote: false,
    executorLabel: 'Host · Project',
    workspacePath: '/workspace',
    title: id,
    parentThreadId,
    createdByAgent: parentThreadId !== null,
    pauseRequested: false,
    pauseReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'idle',
  };
}

function setup() {
  const parent = makeThread('parent');
  const threadsById = new Map<string, Thread>([[parent.id, parent]]);
  const selectionByThread = new Map<string, CatalogSelection>([
    [
      parent.id,
      {
        modelId: 'parent-model',
        adapterId: 'parent-adapter',
        parameters: { temperature: 0.4, options: { reasoningEffort: 'high' } },
      },
    ],
  ]);
  const tools = new Map<
    string,
    (args: Record<string, unknown>, context: { thread?: Thread; executionId: string }) => unknown
  >();
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  const stateMap = new Map<string, unknown>();
  const pipelines = new ExecutionPipelines();
  const canonicalRecords = [
    {
      id: 'record-1',
      threadId: parent.id,
      seq: 1,
      kind: 'message' as const,
      payload: { role: 'assistant', content: 'Result is verified.', source: 'agent' },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
  ];
  const sent = new Map<string, { sender: string; target: string; content: string }>();
  const createByKey = new Map<string, Thread>();
  let idCount = 0;
  const context = {
    threads: {
      get: (id: string) => threadsById.get(id) ?? null,
      modelSelection: (id: string) => selectionByThread.get(id)!,
      validateModelSelection: (selection: CatalogSelection) => structuredClone(selection),
      updateModelSelection: (id: string, selection: CatalogSelection) => {
        selectionByThread.set(id, structuredClone(selection));
        return selection;
      },
      list: (projectId?: string) =>
        [...threadsById.values()].filter((thread) => !projectId || thread.projectId === projectId),
      tools: async () => [],
      binding: () => ({ remoteConnectionId: null }),
      create: (
        projectId: string,
        _kind: Thread['executorKind'],
        title: string,
        options: { parentThreadId?: string | null; idempotencyKey?: string; modelSelection?: CatalogSelection },
      ) => {
        const existing = options.idempotencyKey ? createByKey.get(options.idempotencyKey) : undefined;
        if (existing) return existing;
        const child = { ...makeThread(`child-${++idCount}`, projectId, options.parentThreadId ?? null), title };
        threadsById.set(child.id, child);
        if (options.modelSelection) selectionByThread.set(child.id, structuredClone(options.modelSelection));
        if (options.idempotencyKey) createByKey.set(options.idempotencyKey, child);
        return child;
      },
      send: (sender: string, target: string, content: string, messageId: string) => {
        const inserted = !sent.has(messageId);
        sent.set(messageId, { sender, target, content });
        return { delivered: inserted, threadId: target, messageId };
      },
      pause: (id: string, reason: string) => {
        const thread = threadsById.get(id)!;
        const updated = { ...thread, state: 'paused' as const, pauseReason: reason, pauseRequested: true };
        threadsById.set(id, updated);
        return updated;
      },
      resume: (id: string) => {
        const thread = threadsById.get(id)!;
        const updated = { ...thread, state: 'idle' as const, pauseReason: null, pauseRequested: false };
        threadsById.set(id, updated);
        return updated;
      },
    },
    models: {
      catalog: () => [],
      matchingAdapters: () => [],
      validateSelection: (selection: { modelId: string }) => {
        if (selection.modelId === 'invalid') throw new Error('unsupported parameters');
        return structuredClone(selection);
      },
    },
    tools: {
      register: (
        definition: { name: string },
        execute: (args: Record<string, unknown>, context: { thread?: Thread; executionId: string }) => unknown,
      ) => tools.set(definition.name, execute),
    },
    pipelines: {
      use: (stage: string, interceptor: never) => pipelines.use(stage as never, collaborationPlugin.id, interceptor),
    },
    commands: { register: () => undefined },
    ui: { contribute: () => undefined, registerPage: () => undefined },
    http: {
      register: (
        method: string,
        path: string,
        handler: (request: { body: unknown; query: URLSearchParams }) => unknown,
      ) => routes.set(`${method} ${path}`, handler),
    },
    state: {
      get: <T>(key: string, fallback: T): T => (stateMap.has(key) ? (stateMap.get(key) as T) : fallback),
      set: <T>(key: string, value: T) => {
        stateMap.set(key, value);
      },
      transaction: <T>(run: () => T): T => run(),
      subscribe: () => () => undefined,
    },
    canonical: {
      read: (threadId: string, options: { afterSeq?: number; limit?: number } = {}) =>
        canonicalRecords
          .filter((record) => record.seq > (options.afterSeq ?? 0))
          .map((record) => ({ ...record, threadId }))
          .slice(0, options.limit ?? 100),
      list: () => [],
      append: () => {
        throw new Error('unused');
      },
      subscribe: () => () => undefined,
    },
  } as unknown as PluginContext;
  void collaborationPlugin.activate?.(context);
  return { parent, threadsById, tools, routes, sent, pipelines, stateMap, selectionByThread, canonicalRecords };
}

describe('Collaboration plugin', () => {
  it('spawns a child once per execution, preserves ordinary message semantics, and can list children', async () => {
    const env = setup();
    const spawn = env.tools.get('spawn_thread')!;
    const toolContext = { thread: env.parent, executionId: 'execution-1' };
    const first = (await spawn({ prompt: 'Inspect the cache boundary', title: 'Cache check' }, toolContext)) as {
      threadId: string;
      initialMessageDelivered: boolean;
    };
    const retry = (await spawn({ prompt: 'Inspect the cache boundary', title: 'Cache check' }, toolContext)) as {
      threadId: string;
      initialMessageDelivered: boolean;
    };
    expect(retry.threadId).toBe(first.threadId);
    expect(first.initialMessageDelivered).toBe(true);
    expect(retry.initialMessageDelivered).toBe(false);
    // Simulate a crash after Runtime creates the child but before plugin state is written.
    env.stateMap.delete('spawn-index');
    const recoveryRetry = (await spawn(
      { prompt: 'Inspect the cache boundary', title: 'Cache check' },
      toolContext,
    )) as {
      threadId: string;
    };
    expect(recoveryRetry.threadId).toBe(first.threadId);
    expect(env.threadsById.size).toBe(2);
    expect([...env.sent.values()]).toEqual([
      { sender: env.parent.id, target: first.threadId, content: 'Inspect the cache boundary' },
    ]);
    expect(await env.tools.get('list_child_threads')!({}, toolContext)).toEqual([
      expect.objectContaining({ threadId: first.threadId, title: 'Cache check', state: 'idle' }),
    ]);
    expect(await env.tools.get('read_thread_history')!({ thread_id: first.threadId }, toolContext)).toMatchObject({
      records: [expect.objectContaining({ seq: 1, output: 'Result is verified.' })],
      next_after_seq: 1,
      has_more: false,
    });
    expect(await env.tools.get('read_thread_history')!({}, toolContext)).toMatchObject({
      records: [expect.objectContaining({ seq: 1, output: 'Result is verified.' })],
    });
    await expect(spawn({ prompt: 'Different task' }, toolContext)).rejects.toThrow('already used');
  });

  it('bounds history pages and returns oversized records in bounded chunks', async () => {
    const env = setup();
    const oversized = 'a'.repeat(20_000);
    env.canonicalRecords[0]!.payload = { role: 'assistant', content: oversized, source: 'agent' };
    const read = env.tools.get('read_thread_history')!;
    const toolContext = { thread: env.parent, executionId: 'read-large' };

    expect(() => read({ after_seq: -1 }, toolContext)).toThrow('after_seq must be a non-negative integer');
    expect(() => read({ offset: 1 }, toolContext)).toThrow('offset and chunk_chars require record_seq');
    expect(() => read({}, toolContext)).toThrow(/record at seq 1 exceeds.*record_seq=1.*chunk_chars=8000/);
    const first = read({ record_seq: 1, offset: 0, chunk_chars: 8_000 }, toolContext) as {
      records: Array<{ chunk: { text: string; offset: number; total_chars: number }; next_offset: number | null }>;
    };
    expect(first.records[0]?.chunk).toMatchObject({ offset: 0, total_chars: expect.any(Number) });
    expect(first.records[0]?.chunk.text.length).toBeLessThanOrEqual(8_000);
    expect(first.records[0]?.next_offset).toBeGreaterThan(0);
    const second = read({ record_seq: 1, offset: first.records[0]!.next_offset!, chunk_chars: 8_000 }, toolContext) as {
      records: Array<{ chunk: { offset: number } }>;
    };
    expect(second.records[0]?.chunk.offset).toBe(first.records[0]!.next_offset);
  });

  it('rejects messages outside the Project and exposes safe child management routes', async () => {
    const env = setup();
    const foreign = makeThread('foreign', 'project-2');
    env.threadsById.set(foreign.id, foreign);
    const send = env.tools.get('send_thread_message')!;
    await expect(
      send({ thread_id: foreign.id, message: 'hello' }, { thread: env.parent, executionId: 'send-1' }),
    ).rejects.toThrow('same Project');
    expect(() =>
      env.tools.get('read_thread_history')!({ thread_id: foreign.id }, { thread: env.parent, executionId: 'read-1' }),
    ).toThrow('same Project');

    const spawn = env.tools.get('spawn_thread')!;
    const child = (await spawn({ prompt: 'Work' }, { thread: env.parent, executionId: 'spawn-2' })) as {
      threadId: string;
    };
    const postMessage = env.routes.get('POST /threads/message')!;
    expect(
      postMessage({
        body: {
          parentThreadId: env.parent.id,
          childThreadId: child.threadId,
          message: 'Follow up',
          operationId: 'ui-op-1',
        },
        query: new URLSearchParams(),
      }),
    ).toMatchObject({ delivered: true });
    const postState = env.routes.get('POST /threads/state')!;
    expect(
      postState({
        body: { parentThreadId: env.parent.id, childThreadId: child.threadId, action: 'pause' },
        query: new URLSearchParams(),
      }),
    ).toMatchObject({ state: 'paused' });
    expect(
      postState({
        body: { parentThreadId: env.parent.id, childThreadId: child.threadId, action: 'resume' },
        query: new URLSearchParams(),
      }),
    ).toMatchObject({ state: 'idle' });
    expect(() =>
      postMessage({
        body: {
          parentThreadId: env.parent.id,
          childThreadId: foreign.id,
          message: 'Cross project',
          operationId: 'ui-op-2',
        },
        query: new URLSearchParams(),
      }),
    ).toThrow('does not belong');
  });

  it('inherits the fixed parent selection, isolates explicit target overrides, and keeps retry selection stable', async () => {
    const env = setup();
    const spawn = env.tools.get('spawn_thread')!;
    const first = (await spawn({ prompt: 'Inherited task' }, { thread: env.parent, executionId: 'stable-spawn' })) as {
      threadId: string;
    };
    const inherited = env.selectionByThread.get(first.threadId)!;
    expect(inherited).toEqual(env.selectionByThread.get(env.parent.id));

    env.selectionByThread.set(env.parent.id, {
      modelId: 'new-parent-model',
      adapterId: 'new-parent-adapter',
      parameters: { temperature: 0.1, options: { reasoningEffort: 'low' } },
    });
    const retry = (await spawn({ prompt: 'Inherited task' }, { thread: env.parent, executionId: 'stable-spawn' })) as {
      threadId: string;
    };
    expect(retry.threadId).toBe(first.threadId);
    expect(env.selectionByThread.get(first.threadId)).toEqual(inherited);

    const override = (await spawn(
      {
        prompt: 'Override task',
        model: { modelId: 'gpt-5', adapterId: 'chatgpt', parameters: { options: {} } },
      },
      { thread: env.parent, executionId: 'override-spawn' },
    )) as { threadId: string };
    expect(env.selectionByThread.get(override.threadId)).toEqual({
      modelId: 'gpt-5',
      adapterId: 'chatgpt',
      parameters: { options: {} },
    });
    await expect(
      spawn(
        { prompt: 'Override task', model: { modelId: 'different', adapterId: 'chatgpt', parameters: { options: {} } } },
        { thread: env.parent, executionId: 'override-spawn' },
      ),
    ).rejects.toThrow('different model selection');
    await expect(
      spawn(
        { prompt: 'Bad override', model: { modelId: 'invalid', adapterId: 'chatgpt', parameters: { options: {} } } },
        {
          thread: env.parent,
          executionId: 'invalid-spawn',
        },
      ),
    ).rejects.toThrow('unsupported parameters');
  });

  it('adds child collaboration guidance to each Model Input projection', async () => {
    const env = setup();
    const projected = (await env.pipelines.run(
      'projection',
      { systemPrompt: 'Base prompt' },
      async (input) => input,
    )) as { systemPrompt: string };
    expect(projected.systemPrompt).toContain('Spawning returns immediately');
    expect(projected.systemPrompt).toContain('paused Thread');
  });
});
