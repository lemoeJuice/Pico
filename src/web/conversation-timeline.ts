import type { CanonicalRecord } from '../core/types.js';

/** Keep execution branches at their projection boundary, outside the user bubble. */
export function conversationTimeline<T extends { projectionThrough: number }>(
  records: readonly CanonicalRecord[],
  groups: readonly T[],
): Array<{ type: 'record'; record: CanonicalRecord } | { type: 'group'; group: T }> {
  return [
    ...records.map((record) => ({ type: 'record' as const, record, position: record.seq })),
    ...groups.map((group) => ({ type: 'group' as const, group, position: group.projectionThrough + 0.5 })),
  ].sort((a, b) => a.position - b.position);
}
