import type { CanonicalRecord } from '../core/types.js';
import type { DraftHandoffExecutionState } from '../contracts/runtime.js';
import type { AssistantDraftStore } from './assistant-drafts-store.js';

/** Offscreen replies can be retired immediately; visible replies wait for the rendered snapshot. */
export function observeCommittedDraft(
  store: AssistantDraftStore,
  threadId: string,
  executionId: string,
  seq: number,
  selected: boolean,
): void {
  if (selected) store.markSettled(threadId, executionId, seq);
  else store.clear(threadId, executionId);
}

/** Keep the transient message visible until its stable record is in the rendered snapshot. */
export function shouldRenderAssistantDraft(
  executionId: string,
  records: readonly CanonicalRecord[],
  committedSeq?: number,
): boolean {
  if (records.some((record) => record.id === `${executionId}:assistant` && record.kind === 'assistant')) return false;
  const firstSeq = records[0]?.seq;
  // The durable reply is older than this contiguous page, so it belongs to
  // earlier history rather than to the live end of the timeline.
  return committedSeq === undefined || firstSeq === undefined || committedSeq >= firstSeq;
}

/** Apply authoritative execution state only to the drafts that were queried. */
export function reconcileDraftHandoffs(
  store: AssistantDraftStore,
  threadId: string,
  records: readonly CanonicalRecord[],
  states: readonly DraftHandoffExecutionState[],
): void {
  for (const state of states) {
    if (state.status === 'failed' || state.status === 'interrupted') {
      store.clear(threadId, state.executionId);
    } else if (state.status === 'completed') {
      store.markSettled(threadId, state.executionId, state.assistantSeq ?? undefined);
      if (state.assistantSeq !== null && !shouldRenderAssistantDraft(state.executionId, records, state.assistantSeq)) {
        store.clear(threadId, state.executionId);
      }
    }
  }
}
