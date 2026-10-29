import type { AssistantPayload, CanonicalRecord, Execution, ToolResultPayload } from '../core/types.js';
import type { ThreadSnapshot } from '../contracts/runtime.js';

// Local only: a rewind, restore, or missed record requires a fresh projection.
const activePathStale = Symbol('activePathStale');
type LiveSnapshot = ThreadSnapshot & { [activePathStale]?: boolean };

function changesProjection(record: CanonicalRecord): boolean {
  if (record.kind !== 'plugin') return false;
  const payload = record.payload as Record<string, unknown>;
  return (
    payload.pluginId === 'pico.runtime' &&
    (payload.action === 'context-rewound' || payload.action === 'context-restored')
  );
}

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
  const {
    activePathRecordIds: _recordIds,
    activePathExecutionIds: _executionIds,
    hasInactiveHistory: _inactive,
    historyBranches: _branches,
    projectionStatus: _projectionStatus,
    ...withoutProjection
  } = merged;
  return {
    ...withoutProjection,
    thread: current.thread,
    modelSelection: current.modelSelection,
    contextUsage: current.contextUsage,
    ...(current.projectionStatus ? { projectionStatus: current.projectionStatus } : {}),
    children: current.children,
    executions: mergeById(earlier.executions, current.executions, (execution) => execution.id),
    ...(current.activePathRecordIds ? { activePathRecordIds: current.activePathRecordIds } : {}),
    ...(current.activePathExecutionIds ? { activePathExecutionIds: current.activePathExecutionIds } : {}),
    ...(current.hasInactiveHistory === undefined ? {} : { hasInactiveHistory: current.hasInactiveHistory }),
    ...(current.historyBranches ? { historyBranches: current.historyBranches } : {}),
    ...((current as LiveSnapshot)[activePathStale] ? { [activePathStale]: true } : {}),
  };
}

export function appendSnapshotRecord(
  current: ThreadSnapshot,
  record: CanonicalRecord,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  const latestSeq = current.records.at(-1)?.seq;
  const stale =
    (current as LiveSnapshot)[activePathStale] ||
    changesProjection(record) ||
    (latestSeq !== undefined && record.seq !== latestSeq + 1);
  const projectionUpdate = {
    ...(stale ? { [activePathStale]: true } : {}),
    ...(!stale && current.activePathRecordIds && !current.activePathRecordIds.includes(record.id)
      ? { activePathRecordIds: [...current.activePathRecordIds, record.id] }
      : {}),
  };
  const allRecords = mergeById(current.records, [record], (item) => item.id).sort(
    (left, right) => left.seq - right.seq,
  );
  if (preserveLoadedHistory || allRecords.length <= current.historyPageSize) {
    return { ...current, ...projectionUpdate, records: allRecords };
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
    ...projectionUpdate,
    records,
    hasEarlierRecords: current.hasEarlierRecords || records.length < allRecords.length,
  };
}

export function appendSnapshotExecution(current: ThreadSnapshot, execution: Execution): ThreadSnapshot {
  const executions = [execution, ...current.executions.filter((item) => item.id !== execution.id)];
  if (execution.kind !== 'model' || !current.activePathExecutionIds || (current as LiveSnapshot)[activePathStale]) {
    return { ...current, executions };
  }
  const activeIds = new Set(current.activePathRecordIds ?? []);
  const assistantId = `${execution.id}:assistant`;
  const assistant = current.records.find((record) => record.id === assistantId);
  const through = execution.arguments?.projectionThrough;
  const activeRewindId = current.historyBranches?.find((branch) => branch.active)?.id ?? null;
  const generation = execution.arguments?.activePathRewindId ?? null;
  const boundary =
    typeof through === 'number'
      ? current.records
          .filter((record) => record.seq <= through && record.kind !== 'plugin' && activeIds.has(record.id))
          .at(-1)
      : undefined;
  const ids = new Set(current.activePathExecutionIds);
  if (assistant) {
    if (activeIds.has(assistant.id)) ids.add(execution.id);
    else ids.delete(execution.id);
  } else if (generation === activeRewindId && boundary) {
    ids.add(execution.id);
  }
  return { ...current, executions, activePathExecutionIds: [...ids] };
}
