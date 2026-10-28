import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Execution, Thread, ThreadModelSelection } from '../src/core/types.js';
import type { ThreadSnapshot } from '../src/runtime/runtime.js';
import {
  appendSnapshotExecution,
  appendSnapshotRecord,
  mergeEarlierSnapshot,
  mergeLatestSnapshot,
} from '../src/web/history-pages.js';

function snapshot(
  threadId: string,
  records: CanonicalRecord[],
  hasEarlierRecords: boolean,
  state: Thread['state'] = 'idle',
  executions: Execution[] = [],
): ThreadSnapshot {
  return {
    thread: { id: threadId, projectId: 'project', state } as Thread,
    modelSelection: {
      modelId: 'test-model-id',
      adapterId: 'test-adapter',
      provider: 'openai-compatible',
      connectionId: 'default',
      model: 'test-model',
      parameters: { temperature: 0.2, options: {} },
    } satisfies ThreadModelSelection,
    contextUsage: { inputTokens: 0, source: 'estimate' },
    records,
    executions,
    children: [],
    hasEarlierRecords,
    historyPageSize: 100,
  };
}

function records(from: number, through: number): CanonicalRecord[] {
  return Array.from({ length: through - from + 1 }, (_value, index) => {
    const seq = from + index;
    return {
      id: `record-${seq}`,
      threadId: 'thread',
      seq,
      kind: 'message',
      payload: { role: 'user', content: `Message ${seq}`, source: 'user' },
      createdAt: new Date(seq).toISOString(),
    };
  });
}

describe('Thread history page merging', () => {
  it('prepends an earlier page while keeping the latest Thread state', () => {
    const current = snapshot('thread', records(11, 20), true, 'running');
    const earlier = snapshot('thread', records(1, 10), false, 'idle');

    const merged = mergeEarlierSnapshot(current, earlier);

    expect(merged.records.map((record) => record.seq)).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
    expect(merged.thread.state).toBe('running');
    expect(merged.hasEarlierRecords).toBe(false);
  });

  it('merges overlapping reconnect snapshots but never hides a missing record range', () => {
    const current = snapshot('thread', records(10, 20), true);
    const overlapping = snapshot('thread', records(15, 25), false, 'paused');
    const merged = mergeLatestSnapshot(current, overlapping);
    expect(merged.records.map((record) => record.seq)).toEqual(Array.from({ length: 16 }, (_v, i) => i + 10));
    expect(merged.thread.state).toBe('paused');
    expect(merged.hasEarlierRecords).toBe(true);

    const gap = mergeLatestSnapshot(
      snapshot('thread', records(1, 5), false),
      snapshot('thread', records(20, 25), true),
    );
    expect(gap.records.map((record) => record.seq)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(gap.hasEarlierRecords).toBe(true);
  });

  it('preserves active path metadata from the current snapshot when loading an earlier page', () => {
    const current = {
      ...snapshot('thread', records(11, 20), true),
      activePathRecordIds: ['record-1', 'record-11', 'record-20'],
      activePathExecutionIds: ['current-execution'],
      hasInactiveHistory: true,
      historyBranches: [
        {
          id: 'rewind-current',
          parentId: null,
          targetRecordId: 'record-11',
          targetSeq: 11,
          createdAt: new Date(11).toISOString(),
          preview: 'current branch',
          onActivePath: true,
          active: true,
        },
      ],
    };
    const earlier = {
      ...snapshot('thread', records(1, 10), false),
      activePathRecordIds: ['record-1', 'record-10'],
      activePathExecutionIds: ['older-page-execution'],
      hasInactiveHistory: true,
    };

    const merged = mergeEarlierSnapshot(current, earlier);

    expect(merged.records.map((record) => record.seq)).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
    expect(merged.activePathRecordIds).toEqual(current.activePathRecordIds);
    expect(merged.activePathExecutionIds).toEqual(current.activePathExecutionIds);
    expect(merged.historyBranches).toEqual(current.historyBranches);
  });

  it('uses a fresh snapshot to recover active path membership after a record gap', () => {
    const current = {
      ...snapshot('thread', records(1, 5), false),
      activePathRecordIds: ['record-1', 'record-5'],
      hasInactiveHistory: true,
    };
    const refreshed = {
      ...snapshot('thread', records(20, 25), true),
      activePathRecordIds: ['record-1', 'record-25'],
      activePathExecutionIds: ['fresh-execution'],
      hasInactiveHistory: true,
    };

    const merged = mergeLatestSnapshot(current, refreshed);

    expect(merged.records.map((record) => record.seq)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(merged.activePathRecordIds).toEqual(refreshed.activePathRecordIds);
    expect(merged.activePathExecutionIds).toEqual(refreshed.activePathExecutionIds);
  });

  it('keeps the live history window bounded unless the user loaded older pages', () => {
    const current = snapshot('thread', records(1, 100), false);
    const appended = appendSnapshotRecord(current, records(101, 101)[0]!);
    expect(appended.records).toHaveLength(100);
    expect(appended.records[0]?.seq).toBe(2);
    expect(appended.records.at(-1)?.seq).toBe(101);
    expect(appended.hasEarlierRecords).toBe(true);

    const expanded = appendSnapshotRecord(current, records(101, 101)[0]!, true);
    expect(expanded.records).toHaveLength(101);
    expect(expanded.hasEarlierRecords).toBe(false);
  });

  it('adds an in-order appended record to the active path membership', () => {
    const current = {
      ...snapshot('thread', records(1, 2), false),
      activePathRecordIds: ['record-1', 'record-2'],
      hasInactiveHistory: true,
    };

    const appended = appendSnapshotRecord(current, records(3, 3)[0]!);

    expect(appended.activePathRecordIds).toEqual(['record-1', 'record-2', 'record-3']);
  });

  it.each(['context-rewound', 'context-restored'])(
    'does not blindly add a %s structural record to the active path',
    (action) => {
      const current = {
        ...snapshot('thread', records(1, 2), false),
        activePathRecordIds: ['record-1', 'record-2'],
        hasInactiveHistory: true,
      };
      const structuralRecord: CanonicalRecord = {
        id: `structure-${action}`,
        threadId: 'thread',
        seq: 3,
        kind: 'plugin',
        payload: { pluginId: 'pico.runtime', action, version: 1 },
        createdAt: new Date(3).toISOString(),
      };

      const appended = appendSnapshotRecord(current, structuralRecord);
      const subsequent = appendSnapshotRecord(appended, records(4, 4)[0]!);

      expect(appended.records.map((record) => record.id)).toContain(structuralRecord.id);
      expect(appended.activePathRecordIds).toEqual(current.activePathRecordIds);
      expect(subsequent.activePathRecordIds).toEqual(current.activePathRecordIds);
    },
  );

  it('does not add a record across a sequence gap to active path membership', () => {
    const current = {
      ...snapshot('thread', records(1, 2), false),
      activePathRecordIds: ['record-1', 'record-2'],
      hasInactiveHistory: true,
    };

    const appended = appendSnapshotRecord(current, records(4, 4)[0]!);
    const subsequent = appendSnapshotRecord(appended, records(5, 5)[0]!);

    expect(appended.records.map((record) => record.seq)).toEqual([1, 2, 4]);
    expect(appended.activePathRecordIds).toEqual(current.activePathRecordIds);
    expect(subsequent.activePathRecordIds).toEqual(current.activePathRecordIds);
    const fresh = { ...snapshot('thread', records(1, 5), false), activePathRecordIds: ['record-1', 'record-5'] };
    const recovered = mergeLatestSnapshot(subsequent, fresh);
    expect(appendSnapshotRecord(recovered, records(6, 6)[0]!).activePathRecordIds).toContain('record-6');
  });

  it('adds executions only when their generation and input boundary belong to the active path', () => {
    const current = {
      ...snapshot('thread', records(1, 3), false),
      activePathRecordIds: ['record-1', 'record-2', 'record-3'],
      activePathExecutionIds: ['prior-execution'],
      hasInactiveHistory: true,
      historyBranches: [
        {
          id: 'rewind-current',
          parentId: null,
          targetRecordId: 'record-2',
          targetSeq: 3,
          createdAt: new Date(4).toISOString(),
          preview: 'active branch',
          onActivePath: true,
          active: true,
        },
      ],
    };
    const execution = (id: string, generation: string, status: Execution['status'] = 'running') =>
      ({
        id,
        threadId: 'thread',
        kind: 'model',
        batchId: null,
        toolName: null,
        arguments: { projectionThrough: 3, activePathRewindId: generation },
        status,
        result: null,
        error: null,
        createdAt: new Date(5).toISOString(),
        updatedAt: new Date(5).toISOString(),
      }) as Execution;

    const active = appendSnapshotExecution(current, execution('active-execution', 'rewind-current'));
    const oldGeneration = appendSnapshotExecution(current, execution('old-execution', 'rewind-old'));
    const failed = appendSnapshotExecution(active, execution('active-execution', 'rewind-current', 'failed'));

    expect(active.activePathExecutionIds).toContain('active-execution');
    expect(active.executions.find((item) => item.id === 'active-execution')?.status).toBe('running');
    expect(oldGeneration.activePathExecutionIds).not.toContain('old-execution');
    expect(failed.activePathExecutionIds).toContain('active-execution');
    expect(failed.executions.find((item) => item.id === 'active-execution')?.status).toBe('failed');

    const paged = { ...current, records: records(10, 12), activePathExecutionIds: ['active-execution'] };
    const updatedOutsidePage = appendSnapshotExecution(paged, execution('active-execution', 'rewind-old', 'failed'));
    expect(updatedOutsidePage.activePathExecutionIds).toContain('active-execution');
  });

  it('keeps a large active Tool Batch intact while new records arrive', () => {
    const batchId = 'model-step:batch';
    const assistant: CanonicalRecord = {
      id: 'model-step:assistant',
      threadId: 'thread',
      seq: 10,
      kind: 'assistant',
      payload: { content: '', toolCalls: [], batchId, projectionThrough: 1, usage: null, model: 'test' },
      createdAt: new Date(10).toISOString(),
    };
    const currentRecords = records(1, 200);
    currentRecords[9] = assistant;
    const execution = {
      id: 'tool-execution',
      threadId: 'thread',
      batchId,
      kind: 'tool',
      toolName: 'read_file',
      arguments: {},
      status: 'running',
      result: null,
      error: null,
      createdAt: new Date(10).toISOString(),
      updatedAt: new Date(200).toISOString(),
    } as Execution;

    const appended = appendSnapshotRecord(
      snapshot('thread', currentRecords, false, 'running', [execution]),
      records(201, 201)[0]!,
    );

    expect(appended.records).toHaveLength(192);
    expect(appended.records[0]?.id).toBe('model-step:assistant');
    expect(appended.hasEarlierRecords).toBe(true);
  });
});
