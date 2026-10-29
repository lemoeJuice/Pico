import type { CanonicalRecord } from '../core/types.js';

/** Keep the transient message visible until its stable record is in the rendered snapshot. */
export function shouldRenderAssistantDraft(
  executionId: string,
  records: readonly CanonicalRecord[],
): boolean {
  return !records.some((record) => record.id === `${executionId}:assistant` && record.kind === 'assistant');
}
