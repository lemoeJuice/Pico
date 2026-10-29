import { describe, expect, it } from 'vitest';
import type { CanonicalRecord } from '../src/core/types.js';
import { shouldRenderAssistantDraft } from '../src/web/assistant-draft-handoff.js';

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
});
