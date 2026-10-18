import type { AssistantPayload, CanonicalRecord, Execution, ToolResultPayload } from '../core/types.js';
import type { ThreadSnapshot } from '../contracts/runtime.js';

function mergeById<T>(older: readonly T[], newer: readonly T[], idOf: (item: T) => string): T[] {
  const values = new Map(older.map((item) => [idOf(item), item]));
  for (const item of newer) values.set(idOf(item), item);
  return [...values.values()];
}

function mergeSnapshotData(current: ThreadSnapshot, next: ThreadSnapshot, hasEarlierRecords: boolean): ThreadSnapshot {
  return {
    ...next,
    records: mergeById<CanonicalRecord>(current.records, next.records, (record) => record.id).sort(
      (left, right) => left.seq - right.seq,
    ),
    executions: mergeById<Execution>(current.executions, next.executions, (execution) => execution.id),
    hasEarlierRecords,
  };
}

export function mergeLatestSnapshot(current: ThreadSnapshot | null, next: ThreadSnapshot): ThreadSnapshot {
  if (!current || current.thread.id !== next.thread.id) return next;
  const currentFirst = current.records[0]?.seq;
  const currentLast = current.records.at(-1)?.seq;
  const nextFirst = next.records[0]?.seq;
  const nextLast = next.records.at(-1)?.seq;
  if (
    (currentLast !== undefined && nextFirst !== undefined && currentLast + 1 < nextFirst) ||
    (nextLast !== undefined && currentFirst !== undefined && nextLast + 1 < currentFirst)
  ) {
    // The live connection missed a range of records. Use the fresh page instead of
    // presenting a timeline that looks complete while silently containing a gap.
    return next;
  }
  const hasEarlierRecords =
    currentFirst !== undefined && (nextFirst === undefined || currentFirst < nextFirst)
      ? current.hasEarlierRecords
      : next.hasEarlierRecords;
  return mergeSnapshotData(current, next, hasEarlierRecords);
}

export function mergeEarlierSnapshot(current: ThreadSnapshot, earlier: ThreadSnapshot): ThreadSnapshot {
  if (current.thread.id !== earlier.thread.id) return current;
  const merged = mergeSnapshotData(current, earlier, earlier.hasEarlierRecords);
  return { ...merged, thread: current.thread, children: current.children };
}

export function appendSnapshotRecord(
  current: ThreadSnapshot,
  record: CanonicalRecord,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  const allRecords = mergeById(current.records, [record], (item) => item.id).sort(
    (left, right) => left.seq - right.seq,
  );
  if (preserveLoadedHistory || allRecords.length <= current.historyPageSize) {
    return { ...current, records: allRecords };
  }

  let firstKeptSeq = allRecords[allRecords.length - current.historyPageSize]!.seq;
  const visibleResults = new Set(
    allRecords
      .filter((item) => item.kind === 'tool_result' && item.seq >= firstKeptSeq)
      .map((item) => (item.payload as unknown as ToolResultPayload).batchId),
  );
  const activeBatches = new Set(
    current.executions
      .filter((execution) => execution.batchId && (execution.status === 'pending' || execution.status === 'running'))
      .map((execution) => execution.batchId!),
  );
  for (const item of allRecords) {
    if (item.kind !== 'assistant') continue;
    const batchId = (item.payload as unknown as AssistantPayload).batchId;
    if (batchId && (visibleResults.has(batchId) || activeBatches.has(batchId))) {
      firstKeptSeq = Math.min(firstKeptSeq, item.seq);
    }
  }
  const records = allRecords.filter((item) => item.seq >= firstKeptSeq);
  return {
    ...current,
    records,
    hasEarlierRecords: current.hasEarlierRecords || records.length < allRecords.length,
  };
}
