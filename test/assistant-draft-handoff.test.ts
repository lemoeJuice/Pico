import { describe, expect, it } from 'vitest';
import type { CanonicalRecord } from '../src/core/types.js';
import { observeCommittedDraft, reconcileDraftHandoffs, shouldRenderAssistantDraft } from '../src/web/assistant-draft-handoff.js';
import { AssistantDraftStore } from '../src/web/assistant-drafts-store.js';

function assistantRecord(id: string): CanonicalRecord {
  return {
    id,
    threadId: 'thread-a',
    seq: 1,
    kind: 'assistant',
    createdAt: '2026-10-29T00:00:00.000Z',
    payload: { content: 'stable reply' },
  } as CanonicalRecord;
}

describe('assistant draft handoff', () => {
  it('keeps the draft visible until its stable assistant record is in the snapshot', () => {
    expect(shouldRenderAssistantDraft('exec-a', [])).toBe(true);
    expect(shouldRenderAssistantDraft('exec-a', [assistantRecord('exec-other:assistant')])).toBe(true);
    expect(shouldRenderAssistantDraft('exec-a', [assistantRecord('exec-a:assistant')])).toBe(false);
  });

  it('does not treat a same-id non-assistant record as the handoff target', () => {
    const message = { ...assistantRecord('exec-a:assistant'), kind: 'message' } as CanonicalRecord;
    expect(shouldRenderAssistantDraft('exec-a', [message])).toBe(true);
  });

  it('does not revive a committed draft older than the current history page', () => {
    const latest = { ...assistantRecord('other:assistant'), seq: 40 };
    expect(shouldRenderAssistantDraft('exec-a', [latest], 39)).toBe(false);
    expect(shouldRenderAssistantDraft('exec-a', [latest], 41)).toBe(true);
    expect(shouldRenderAssistantDraft('exec-a', [], 39)).toBe(true);
    expect(shouldRenderAssistantDraft('exec-a', [latest])).toBe(true);
  });

  it('reconciles old, current and not-yet-visible replies without discarding an active draft', () => {
    const store = new AssistantDraftStore();
    store.appendText('thread-a', 'old', 'old reply');
    store.appendText('thread-a', 'later', 'awaiting the next page');
    store.appendText('thread-a', 'active', 'writing');
    const page = [{ ...assistantRecord('other:assistant'), seq: 40 }];
    reconcileDraftHandoffs(store, 'thread-a', page, [
      { executionId: 'old', status: 'completed', assistantSeq: 39 },
      { executionId: 'later', status: 'completed', assistantSeq: 41 },
      { executionId: 'active', status: 'running', assistantSeq: null },
    ]);
    expect(store.getContentForExecution('thread-a', 'old')).toBeNull();
    expect(store.getContentForExecution('thread-a', 'later')).toMatchObject({ settled: true, committedSeq: 41 });
    expect(store.getContentForExecution('thread-a', 'active')).toMatchObject({ text: 'writing' });
    expect(store.getContentForExecution('thread-a', 'active')?.settled).toBeUndefined();
  });

  it('retires a background reply but keeps a selected reply until its stable record is shown', () => {
    const store = new AssistantDraftStore();
    store.appendText('background', 'old', 'background reply');
    store.appendText('current', 'live', 'visible reply');
    observeCommittedDraft(store, 'background', 'old', 4, false);
    observeCommittedDraft(store, 'current', 'live', 5, true);
    expect(store.getContents('background')).toEqual([]);
    expect(store.getContentForExecution('current', 'live')).toMatchObject({ text: 'visible reply', settled: true });
  });
});
