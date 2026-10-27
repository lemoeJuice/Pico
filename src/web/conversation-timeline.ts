import type { CanonicalRecord } from '../core/types.js';

/** Keep execution branches at their projection boundary, outside the user bubble. */
export function conversationTimeline<T extends { projectionThrough: number }>(
  records: readonly CanonicalRecord[],
  groups: readonly T[],
): Array<{ type: 'record'; record: CanonicalRecord } | { type: 'group'; group: T }> {
  return [
    ...records.map((record) => {
      const payload = record.kind === 'plugin' ? (record.payload as Record<string, unknown>) : null;
      const rewindTargetSeq =
        payload?.pluginId === 'pico.runtime' &&
        payload.action === 'context-rewound' &&
        Number.isSafeInteger(payload.targetSeq)
          ? (payload.targetSeq as number)
          : null;
      return {
        type: 'record' as const,
        record,
        position: rewindTargetSeq === null ? record.seq : rewindTargetSeq + 0.25,
      };
    }),
    ...groups.map((group) => ({ type: 'group' as const, group, position: group.projectionThrough + 0.5 })),
  ].sort((a, b) => a.position - b.position);
}
