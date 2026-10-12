import { describe, expect, it } from 'vitest';
import {
  appendAssistantDraft,
  assistantStreamsAfterDisconnect,
  assistantDraftForThread,
  canAppendAssistantDelta,
  clearAssistantDraft,
  observeAssistantExecutions,
  type AssistantDrafts,
  type AssistantStreamExecutions,
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

  it('hides an unreplayable stream tail after disconnect but allows a new Model Step', () => {
    const active: AssistantStreamExecutions = new Map([['execution-a', 'thread-a']]);
    const unavailable = assistantStreamsAfterDisconnect(active, {}, new Map());

    expect(canAppendAssistantDelta(active, unavailable, 'thread-a', 'execution-a')).toBe(false);

    const resumed = observeAssistantExecutions(
      active,
      unavailable,
      [
        {
          id: 'execution-b',
          threadId: 'thread-b',
          kind: 'model',
          status: 'running',
        },
      ],
      new Set(['execution-b']),
    );
    expect(canAppendAssistantDelta(resumed.active, resumed.unavailable, 'thread-b', 'execution-b')).toBe(true);
  });

  it('marks a Model Step not observed on the current connection unavailable until its durable outcome', () => {
    const running = observeAssistantExecutions(
      new Map(),
      new Map(),
      [
        {
          id: 'execution-a',
          threadId: 'thread-a',
          kind: 'model',
          status: 'running',
        },
      ],
      new Set(),
    );
    expect(running.unavailable.get('execution-a')).toBe('thread-a');

    const observed = observeAssistantExecutions(
      running.active,
      running.unavailable,
      [
        {
          id: 'execution-a',
          threadId: 'thread-a',
          kind: 'model',
          status: 'running',
        },
      ],
      new Set(['execution-a']),
    );
    expect(observed.unavailable.has('execution-a')).toBe(false);

    const completed = observeAssistantExecutions(
      observed.active,
      observed.unavailable,
      [
        {
          id: 'execution-a',
          threadId: 'thread-a',
          kind: 'model',
          status: 'completed',
        },
      ],
      new Set(),
    );
    expect(completed.unavailable.has('execution-a')).toBe(false);
  });

  it('replaces a stale unavailable step when a later Model Step starts in the same Thread', () => {
    const interruptedStream = observeAssistantExecutions(
      new Map(),
      new Map(),
      [
        {
          id: 'old-execution',
          threadId: 'thread-a',
          kind: 'model',
          status: 'running',
        },
      ],
      new Set(),
    );
    const nextStep = observeAssistantExecutions(
      interruptedStream.active,
      interruptedStream.unavailable,
      [
        {
          id: 'new-execution',
          threadId: 'thread-a',
          kind: 'model',
          status: 'running',
        },
      ],
      new Set(['new-execution']),
    );

    expect(nextStep.active.has('old-execution')).toBe(false);
    expect(nextStep.unavailable.has('old-execution')).toBe(false);
    expect(canAppendAssistantDelta(nextStep.active, nextStep.unavailable, 'thread-a', 'new-execution')).toBe(true);
  });
});
