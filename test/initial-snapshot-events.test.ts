import { describe, expect, it } from 'vitest';
import type { ThreadSnapshot } from '../src/contracts/runtime.js';
import type { CanonicalRecord, Execution, Thread } from '../src/core/types.js';
import { reconcileInitialSnapshot } from '../src/web/initial-snapshot-events.js';

const record = (seq: number): CanonicalRecord => ({
  id: `r${seq}`, threadId: 't', seq, kind: 'message', createdAt: '',
  payload: { role: 'user', source: 'user', content: `message ${seq}` },
});
const snapshot = (): ThreadSnapshot => ({
  thread: { id: 't', projectId: 'p' } as Thread,
  modelSelection: {} as ThreadSnapshot['modelSelection'], contextUsage: null,
  projectionStatus: 'not_loaded', records: [record(1), record(2)], executions: [], children: [],
  hasEarlierRecords: false, historyPageSize: 20,
});

describe('initial history and in-flight events', () => {
  it('replays new records and newer execution updates, ignoring duplicates and older execution updates', () => {
    const completed = { id: 'e', threadId: 't', kind: 'model', status: 'completed', updatedAt: '2026-01-02' } as Execution;
    const initial = { ...snapshot(), executions: [completed] };
    const next = reconcileInitialSnapshot(initial, [
      { type: 'record', record: record(2) },
      { type: 'record', record: record(3) },
      { type: 'execution', execution: { ...completed, status: 'running', updatedAt: '2026-01-01' } },
    ]);
    expect(next?.records.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(next?.executions[0]?.status).toBe('completed');
  });

  it('requires a fresh projection for a gap or a branch change', () => {
    expect(reconcileInitialSnapshot(snapshot(), [{ type: 'record', record: record(4) }])).toBeNull();
    const rewind = { ...record(3), kind: 'plugin', payload: { pluginId: 'pico.runtime', action: 'context-rewound' } } as CanonicalRecord;
    expect(reconcileInitialSnapshot(snapshot(), [{ type: 'record', record: rewind }])).toBeNull();
  });

  it('applies a thread update received while the request was in flight', () => {
    const initial = snapshot();
    const updated = { ...initial.thread, state: 'running' } as Thread;
    expect(reconcileInitialSnapshot(initial, [{ type: 'thread', thread: updated }])?.thread.state).toBe('running');
  });
});
