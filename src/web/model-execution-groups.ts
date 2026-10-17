import type { AssistantPayload, CanonicalRecord, Execution } from '../core/types.js';

export interface ModelExecutionVariant {
  execution: Execution;
  assistantRecord: CanonicalRecord | null;
}
export interface ModelExecutionGroup {
  projectionThrough: number;
  variants: ModelExecutionVariant[];
}
export function assistantRecordHasVisibleResult(record: CanonicalRecord | null): boolean {
  if (!record) return false;
  const payload = record.payload as unknown as AssistantPayload;
  return (
    (typeof payload.content === 'string' && payload.content.trim().length > 0) ||
    (Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0)
  );
}
export function modelExecutionCanRetry(variant: ModelExecutionVariant): boolean {
  return (
    variant.execution.status === 'failed' ||
    variant.execution.status === 'interrupted' ||
    (variant.execution.status === 'completed' &&
      Boolean(variant.assistantRecord) &&
      !assistantRecordHasVisibleResult(variant.assistantRecord))
  );
}
export function modelExecutionProjectionThrough(execution: Execution): number | null {
  const through = execution.arguments?.projectionThrough;
  return typeof through === 'number' && Number.isSafeInteger(through) ? through : null;
}

/** Plugin audit records can advance the projection without starting a new conversational step. */
export function modelExecutionGroups(records: readonly CanonicalRecord[], executions: readonly Execution[]) {
  const assistants = new Map(
    records
      .filter((record) => record.kind === 'assistant')
      .map((record) => [record.id.replace(/:assistant$/, ''), record]),
  );
  const groupsByBoundary = new Map<number, ModelExecutionVariant[]>();
  for (const execution of executions) {
    if (execution.kind !== 'model') continue;
    const through = modelExecutionProjectionThrough(execution);
    if (through === null) continue;
    const projected = records.filter((record) => record.seq <= through);
    if (!projected.some((record) => record.kind === 'message')) continue;
    const boundary = projected.filter((record) => record.kind !== 'plugin').at(-1)?.seq ?? through;
    const assistantRecord = execution.status === 'completed' ? (assistants.get(execution.id) ?? null) : null;
    if (execution.status === 'completed' && !assistantRecord) continue;
    const variants = groupsByBoundary.get(boundary) ?? [];
    variants.push({ execution, assistantRecord });
    groupsByBoundary.set(boundary, variants);
  }
  const groups: ModelExecutionGroup[] = [];
  const groupedAssistantRecordIds = new Set<string>();
  for (const [boundary, variants] of groupsByBoundary) {
    variants.sort(
      (a, b) =>
        a.execution.createdAt.localeCompare(b.execution.createdAt) || a.execution.id.localeCompare(b.execution.id),
    );
    if (variants.length === 1 && !modelExecutionCanRetry(variants[0]!) && variants[0]!.execution.status === 'completed')
      continue;
    groups.push({ projectionThrough: boundary, variants });
    for (const variant of variants)
      if (variant.assistantRecord) groupedAssistantRecordIds.add(variant.assistantRecord.id);
  }
  return { groups, groupedAssistantRecordIds };
}

/** A newly started attempt supersedes a selection made against an older attempt list. */
export function selectedAttemptIndex(
  group: ModelExecutionGroup,
  selection: { id: string; latestId: string } | null,
): number {
  const latestIndex = group.variants.length - 1;
  if (!selection || selection.latestId !== group.variants[latestIndex]?.execution.id) return latestIndex;
  const index = group.variants.findIndex((variant) => variant.execution.id === selection.id);
  return index >= 0 ? index : latestIndex;
}
