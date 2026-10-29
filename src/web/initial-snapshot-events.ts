import type { ThreadSnapshot } from '../contracts/runtime.js';
import type { CanonicalRecord, Execution, Thread, ThreadModelSelection } from '../core/types.js';
import { appendSnapshotExecution, appendSnapshotRecord } from './history-pages.js';
import { updateThreadSnapshot } from './thread-state.js';

export type InitialSnapshotEvent =
  | { type: 'record'; record: CanonicalRecord }
  | { type: 'execution'; execution: Execution }
  | { type: 'thread'; thread: Thread }
  | { type: 'modelSelection'; selection: ThreadModelSelection };

export function isHistoryBranchChange(record: CanonicalRecord): boolean {
  const payload = record.payload as Record<string, unknown>;
  return record.kind === 'plugin' && payload.pluginId === 'pico.runtime' &&
    (payload.action === 'context-rewound' || payload.action === 'context-restored');
}

/** Replay events observed while the first page was in flight, or request a fresh projection
 * when a missing record or a branch change prevents a safe provisional view. */
export function reconcileInitialSnapshot(
  initial: ThreadSnapshot,
  events: readonly InitialSnapshotEvent[],
): ThreadSnapshot | null {
  let snapshot = initial;
  for (const event of events) {
    if (event.type === 'record') {
      const record = event.record;
      if (record.threadId !== snapshot.thread.id || snapshot.records.some((item) => item.id === record.id)) continue;
      if (isHistoryBranchChange(record)) return null;
      const last = snapshot.records.at(-1)?.seq;
      if (last !== undefined && record.seq > last + 1) return null;
      if (last === undefined || record.seq > last) snapshot = appendSnapshotRecord(snapshot, record);
    } else if (event.type === 'execution') {
      const execution = event.execution;
      if (execution.threadId !== snapshot.thread.id) continue;
      const current = snapshot.executions.find((item) => item.id === execution.id);
      if (current && (current.updatedAt > execution.updatedAt ||
          (current.updatedAt === execution.updatedAt && current.status !== 'pending' && current.status !== 'running' &&
           (execution.status === 'pending' || execution.status === 'running')))) continue;
      snapshot = appendSnapshotExecution(snapshot, execution);
    } else if (event.type === 'thread') {
      const updated = event.thread;
      if (updated.id === snapshot.thread.id) {
        const next = updateThreadSnapshot(snapshot, updated);
        if (!next) return null;
        snapshot = next;
      } else if (updated.parentThreadId === snapshot.thread.id || snapshot.children.some((child) => child.id === updated.id)) {
        const children = snapshot.children.filter((item) => item.id !== updated.id);
        if (updated.parentThreadId === snapshot.thread.id && !updated.archivedAt && !updated.deletedAt) children.unshift(updated);
        snapshot = { ...snapshot, children };
      }
    } else {
      snapshot = { ...snapshot, modelSelection: event.selection };
    }
  }
  return snapshot;
}
