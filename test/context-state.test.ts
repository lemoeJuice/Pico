import { describe, expect, it } from 'vitest';
import type { PromptTurn } from '../src/contracts/model.js';
import type { ProjectionProvenance } from '../src/contracts/runtime.js';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import type { ProjectionInput } from '../src/runtime/stages.js';
import { ThreadContextState } from '../src/runtime/context-state.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response, setupRuntime, setupTestCatalog } from './helpers.js';

const userTurn = (content: string): PromptTurn => ({ kind: 'message', role: 'user', content });
const provenance = (id: string, start: number, end: number): ProjectionProvenance => ({
  id,
  sourcePluginId: 'canonical',
  label: id,
  kind: 'canonical',
  disposition: 'raw',
  turnStartIndex: start,
  turnEndIndex: end,
});

describe('ThreadContextState', () => {
  it('serializes interleaved operations per Thread while keeping Threads independent', async () => {
    const state = new ThreadContextState();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = state.transact('thread-a', async (draft) => {
      draft.turns.push(userTurn('first'));
      await blocked;
      draft.turns.push(userTurn('second'));
    });
    const queuedAppend = state.append('thread-a', { turns: [userTurn('third')] });
    const otherThread = await state.append('thread-b', { turns: [userTurn('independent')] });

    expect(otherThread.turns.map((turn) => turn.content)).toEqual(['independent']);
    release();
    const transaction = await first;
    const appended = await queuedAppend;
    expect(transaction.snapshot.revision).toBe(1);
    expect(appended.revision).toBe(2);
    expect(appended.turns.map((turn) => turn.content)).toEqual(['first', 'second', 'third']);
  });

  it('isolates snapshots, inputs, and drafts retained by async closures', async () => {
    const state = new ThreadContextState();
    const source = [userTurn('canonical')];
    const initial = await state.replace('thread-a', {
      branchId: 'branch-1',
      turns: source,
      provenance: [provenance('record-1', 0, 1)],
    });
    source[0] = userTurn('changed input');
    (initial.turns[0] as { content: string }).content = 'changed snapshot';

    let retained: { turns: PromptTurn[]; provenance: ProjectionProvenance[] } | undefined;
    await state.transact('thread-a', (draft) => { retained = draft; });
    retained!.turns.push(userTurn('late mutation'));
    retained!.provenance.push(provenance('late-record', 0, 1));

    const snapshot = await state.read('thread-a');
    expect(snapshot.turns.map((turn) => turn.content)).toEqual(['canonical']);
    expect(snapshot.provenance.map((item) => item.id)).toEqual(['record-1']);
    expect(snapshot.provenance[0]).toMatchObject({ threadId: 'thread-a', branchId: 'branch-1' });
  });

  it('uses revisions for compare-and-swap and rejects stale branch writes', async () => {
    const state = new ThreadContextState();
    const restored = await state.replace('thread-a', {
      branchId: 'branch-1',
      turns: [userTurn('restored from canonical')],
      provenance: [provenance('canonical-record', 0, 1)],
    });
    const appended = await state.append('thread-a', {
      branchId: 'branch-1',
      turns: [userTurn('next')],
      provenance: [{ ...provenance('next-record', 0, 1), turnIndex: 0 }],
    });

    expect(appended.revision).toBe(restored.revision + 1);
    expect(appended.provenance[1]).toMatchObject({ turnStartIndex: 1, turnEndIndex: 2, turnIndex: 1 });
    await expect(state.append('thread-a', { branchId: 'branch-2', turns: [userTurn('wrong branch')] }))
      .rejects.toThrow(/replace the complete context/);

    const stale = await state.compareAndSwap('thread-a', restored.revision, { turns: [userTurn('stale')] });
    expect(stale.committed).toBe(false);
    expect(stale.snapshot.turns.map((turn) => turn.content)).toEqual(['restored from canonical', 'next']);

    const committed = await state.compareAndSwap('thread-a', appended.revision, {
      branchId: 'branch-2',
      turns: [userTurn('new branch canonical')],
      provenance: [provenance('branch-2-record', 0, 1)],
    });
    expect(committed).toMatchObject({ committed: true, snapshot: { branchId: 'branch-2', revision: 3 } });
  });

  it('runs a synchronous commit callback inside the revision queue slot', async () => {
    const state = new ThreadContextState();
    const initial = await state.replace('thread-a', {
      branchId: 'branch-1', sourceThrough: 3, turns: [userTurn('before')],
    });
    let externalCommitCount = 0;
    const queuedAppendPromise = state.append('thread-a', { turns: [userTurn('racing append')] });
    const stale = await state.commitIfRevision('thread-a', initial.revision, () => {
      externalCommitCount += 1;
      return {
        replacement: { branchId: 'branch-1', sourceThrough: 4, turns: [userTurn('compacted')] },
        commit: () => true,
      };
    });
    expect(stale.committed).toBe(false);
    expect(externalCommitCount).toBe(0);
    const queuedAppend = await queuedAppendPromise;
    const current = await state.read('thread-a');
    const committed = await state.commitIfRevision('thread-a', current.revision, () => {
      return {
        replacement: { branchId: 'branch-1', sourceThrough: 5, turns: [userTurn('summary'), userTurn('recent')] },
        commit: () => { externalCommitCount += 1; return true; },
      };
    });
    expect(queuedAppend.turns.map((turn) => turn.content)).toEqual(['before', 'racing append']);
    expect(committed.committed).toBe(true);
    expect(committed.snapshot).toMatchObject({ revision: current.revision + 1, sourceThrough: 5 });
    expect(committed.snapshot.turns.map((turn) => turn.content)).toEqual(['summary', 'recent']);
    expect(externalCommitCount).toBe(1);
    await expect(state.commitIfRevision('thread-a', committed.snapshot.revision, () => ({
      replacement: { turns: [{ kind: 'message', role: 'user', content: 'uncloneable', callback: () => undefined } as unknown as PromptTurn] },
      commit: () => { externalCommitCount += 1; return true; },
    }))).rejects.toThrow();
    expect(externalCommitCount).toBe(1);
    expect((await state.read('thread-a')).turns.map((turn) => turn.content)).toEqual(['summary', 'recent']);
  });

  it('clears state and continues the queue after a rejected operation', async () => {
    const state = new ThreadContextState();
    await state.replace('thread-a', { branchId: 'branch-1', turns: [userTurn('old')] });
    const failed = state.append('thread-a', { branchId: 'wrong-branch', turns: [userTurn('reject')] });
    const cleared = state.clear('thread-a');
    await expect(failed).rejects.toThrow();
    const snapshot = await cleared;

    expect(snapshot).toMatchObject({ threadId: 'thread-a', branchId: null, revision: 2, turns: [], provenance: [] });
    expect((await state.read('thread-a')).revision).toBe(2);
  });

  it('reconciles exact reads without revision changes, appends absolute provenance ranges, and rejects late old sources', async () => {
    const state = new ThreadContextState();
    const first = await state.synchronize('thread-a', {
      branchId: 'branch-1',
      sourceThrough: 4,
      turns: [userTurn('one'), userTurn('two')],
      provenance: [provenance('one', 0, 1), provenance('two', 1, 2)],
    });
    const same = await state.synchronize('thread-a', {
      branchId: 'branch-1',
      sourceThrough: 5,
      turns: [userTurn('one'), userTurn('two')],
      provenance: [provenance('one', 0, 1), provenance('two', 1, 2)],
    });
    const appended = await state.synchronize('thread-a', {
      branchId: 'branch-1',
      sourceThrough: 7,
      turns: [userTurn('one'), userTurn('two'), userTurn('three')],
      provenance: [provenance('one', 0, 1), provenance('two', 1, 2), provenance('three', 2, 3)],
    });
    const late = await state.synchronize('thread-a', {
      branchId: 'branch-1',
      sourceThrough: 6,
      turns: [userTurn('old projection')],
      provenance: [provenance('old', 0, 1)],
    });

    expect(same.revision).toBe(first.revision);
    expect(same.sourceThrough).toBe(5);
    expect(appended.revision).toBe(first.revision + 1);
    expect(appended.provenance.map(({ turnStartIndex, turnEndIndex }) => [turnStartIndex, turnEndIndex])).toEqual([
      [0, 1], [1, 2], [2, 3],
    ]);
    expect(late).toMatchObject({ revision: appended.revision, sourceThrough: 7 });
    expect(late.turns.map((turn) => turn.content)).toEqual(['one', 'two', 'three']);
  });

  it('uses the current ordinary projection while regenerating interleaved plugin turns and recent tool results', async () => {
    let injection = 0;
    const transientPlugin: PicoPlugin = {
      id: 'pico.test-context-injection',
      name: 'Context injection test',
      version: '1',
      pipelinePriority: { projection: 50 },
      activate({ pipelines }) {
        pipelines.use('projection', async (input, next) => {
          injection += 1;
          const turnIndex = Math.min(1, input.turns.length);
          const shiftedProvenance = (input.provenance ?? []).map((item) => ({
            ...item,
            ...(item.turnStartIndex === undefined || item.turnStartIndex < turnIndex
              ? {}
              : { turnStartIndex: item.turnStartIndex + 1 }),
            ...(item.turnEndIndex === undefined || item.turnEndIndex < turnIndex
              ? {}
              : { turnEndIndex: item.turnEndIndex + 1 }),
            ...(item.turnIndex === undefined || item.turnIndex < turnIndex
              ? {}
              : { turnIndex: item.turnIndex + 1 }),
          }));
          return next({
            ...input,
            turns: [
              ...input.turns.slice(0, turnIndex),
              userTurn(`temporary-${injection}`),
              ...input.turns.slice(turnIndex),
            ],
            provenance: [
              ...shiftedProvenance,
              {
                id: `temporary-${injection}`,
                sourcePluginId: 'pico.test-context-injection',
                label: 'per-request injection',
                kind: 'plugin',
                disposition: 'raw',
              turnIndex,
              },
            ],
          });
        });
      },
    };
    const env = await setupRuntime(new FakeModel(() => response('ok')), {
      plugins: [transientPlugin],
      disabledBuiltinPlugins: ['pico.rolling-context'],
    });
    const thread = env.createThread('runtime');
    let runtime = env.runtime;
    try {
      const user = env.store.appendCanonical(thread.id, 'state-user', 'message', {
        role: 'user', source: 'user', content: 'ordinary request',
      });
      const assistant = env.store.appendCanonical(thread.id, 'state-assistant-tools', 'assistant', {
        content: '',
        toolCalls: [{ id: 'recent-call', name: 'recent_tool', arguments: {} }],
        batchId: 'recent-batch',
        projectionThrough: user.record.seq,
        usage: null,
        model: 'test-model',
      });
      env.store.appendCanonical(thread.id, 'recent-execution:result', 'tool_result', {
        executionId: 'recent-execution',
        toolCallId: 'recent-call',
        batchId: 'recent-batch',
        toolName: 'recent_tool',
        status: 'completed',
        result: 'latest tool evidence',
      });

      const project = async () => {
        const records = env.store.listRecords(thread.id);
        return (runtime as unknown as RuntimeContextAccess).projectModelInput(
          thread, records, records.at(-1)?.seq ?? 0, false,
        );
      };
      const first = await project();
      const firstSnapshot = await (runtime as unknown as RuntimeContextAccess).contextStates.read(thread.id);
      const second = await project();
      const secondSnapshot = await (runtime as unknown as RuntimeContextAccess).contextStates.read(thread.id);

      expect(first.turns.map((turn) => turn.kind === 'message' ? turn.content : turn.kind)).toContain('temporary-1');
      expect(second.turns.map((turn) => turn.kind === 'message' ? turn.content : turn.kind)).toContain('temporary-2');
      expect(second.turns.map((turn) => turn.kind === 'message' ? turn.content : turn.kind)).not.toContain('temporary-1');
      expect(second.turns.findIndex((turn) => turn.kind === 'message' && turn.content === 'temporary-2'))
        .toBeGreaterThan(second.turns.findIndex((turn) => turn.kind === 'message' && turn.content === 'ordinary request'));
      expect(firstSnapshot.revision).toBe(secondSnapshot.revision);
      expect(secondSnapshot.turns.some((turn) => turn.kind === 'message' && turn.content.startsWith('temporary-'))).toBe(false);
      expect(secondSnapshot.turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('latest tool evidence'))).toBe(true);
      expect(secondSnapshot.turns.filter((turn) => turn.kind === 'tool_result' && turn.content.includes('latest tool evidence'))).toHaveLength(1);

      const target = assistant.record as CanonicalRecord;
      const rewind = runtime.rewindContextToMessage(thread.id, target.id);
      const rewound = await project();
      const rewoundSnapshot = await (runtime as unknown as RuntimeContextAccess).contextStates.read(thread.id);
      expect(rewoundSnapshot.branchId).toBe(rewind.projectionId);
      expect(rewound.turns.some((turn) => turn.kind === 'tool_result')).toBe(true);

      await runtime.shutdown();
      runtime = new PicoRuntime(env.store, {
        model: new FakeModel(() => response('restart ok')),
        pluginDirectory: `${env.directory}/empty-plugins`,
        plugins: [transientPlugin],
        disabledBuiltinPlugins: ['pico.rolling-context'],
      });
      await setupTestCatalog(runtime);
      await runtime.initialize();
      const restartedProjection = await project();
      const restartedSnapshot = await (runtime as unknown as RuntimeContextAccess).contextStates.read(thread.id);
      expect(restartedSnapshot.turns).toEqual(rewoundSnapshot.turns);
      expect(restartedSnapshot.branchId).toBe(rewoundSnapshot.branchId);
      expect(restartedProjection.turns.filter((turn) => turn.kind === 'message' && turn.content.startsWith('temporary-')))
        .toHaveLength(1);
    } finally {
      if (runtime !== env.runtime) await runtime.shutdown();
      await env.cleanup();
    }
  });
});

interface RuntimeContextAccess {
  projectModelInput(thread: Thread, records: readonly CanonicalRecord[], through: number, isModelStep?: boolean): Promise<ProjectionInput>;
  contextStates: ThreadContextState;
}
