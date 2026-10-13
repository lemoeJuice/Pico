import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Execution, Thread } from '../src/core/types.js';
import type { ThreadSnapshot } from '../src/runtime/runtime.js';
import { appendSnapshotRecord, mergeEarlierSnapshot, mergeLatestSnapshot } from '../src/web/history-pages.js';

function snapshot(
  threadId: string,
  records: CanonicalRecord[],
  hasEarlierRecords: boolean,
  state: Thread['state'] = 'idle',
  executions: Execution[] = [],
): ThreadSnapshot {
  return {
    thread: { id: threadId, projectId: 'project', state } as Thread,
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
