import { describe, expect, it } from 'vitest';
import {
  appendAssistantDraft,
  assistantDraftForThread,
  clearAssistantDraft,
  type AssistantDrafts,
} from '../src/web/assistant-drafts.js';

describe('Thread-scoped assistant streaming drafts', () => {
  it('keeps concurrent Thread streams isolated and resumes the selected draft after switching', () => {
    let drafts: AssistantDrafts = {};
    drafts = appendAssistantDraft(drafts, 'thread-a', 'execution-a', 'First');
    drafts = appendAssistantDraft(drafts, 'thread-b', 'execution-b', 'Other');
    drafts = appendAssistantDraft(drafts, 'thread-a', 'execution-a', ' half');

    expect(assistantDraftForThread(drafts, 'thread-a')).toBe('First half');
    expect(assistantDraftForThread(drafts, 'thread-b')).toBe('Other');
    expect(assistantDraftForThread(drafts, null)).toBe('');
  });

  it('clears only the matching execution draft when a committed step or end event arrives', () => {
    let drafts: AssistantDrafts = {};
    drafts = appendAssistantDraft(drafts, 'thread-a', 'old-execution', 'Old partial');
    drafts = appendAssistantDraft(drafts, 'thread-a', 'new-execution', 'New partial');

    const afterOldEnd = clearAssistantDraft(drafts, 'thread-a', 'old-execution');
    expect(assistantDraftForThread(afterOldEnd, 'thread-a')).toBe('New partial');

    const afterNewEnd = clearAssistantDraft(afterOldEnd, 'thread-a', 'new-execution');
    expect(assistantDraftForThread(afterNewEnd, 'thread-a')).toBe('');
    expect(clearAssistantDraft(drafts, 'thread-b')).toBe(drafts);
  });
});
