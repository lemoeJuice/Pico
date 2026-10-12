import { describe, expect, it } from 'vitest';
import {
  clearAcceptedMessageDraft,
  hasPendingMessageSubmission,
  messageSubmissionId,
  settleMessageSubmission,
  type PendingMessageIds,
  withPendingThreadSubmission,
} from '../src/web/message-retries.js';

describe('Thread-scoped message retries', () => {
  it('reuses an uncertain request ID only for the same content in the same Thread', () => {
    const pending: PendingMessageIds = new Map();
    let nextId = 0;
    const createId = (): string => `message-${++nextId}`;

    const first = messageSubmissionId(pending, 'thread-a', 'Same text', createId);
    const retry = messageSubmissionId(pending, 'thread-a', 'Same text', createId);
    const otherThread = messageSubmissionId(pending, 'thread-b', 'Same text', createId);

    expect(retry).toBe(first);
    expect(otherThread).not.toBe(first);
    expect(nextId).toBe(2);
  });

  it('keeps other uncertain submissions and allows a fresh ID after acceptance', () => {
    const pending: PendingMessageIds = new Map();
    let nextId = 0;
    const createId = (): string => `message-${++nextId}`;
    const first = messageSubmissionId(pending, 'thread-a', 'First message', createId);
    const second = messageSubmissionId(pending, 'thread-a', 'Second message', createId);
    expect(hasPendingMessageSubmission(pending, 'thread-a', first)).toBe(true);

    expect(settleMessageSubmission(pending, 'thread-a', first)).toBe(true);
    expect(settleMessageSubmission(pending, 'thread-a', first)).toBe(false);
    expect(hasPendingMessageSubmission(pending, 'thread-a', first)).toBe(false);

    expect(messageSubmissionId(pending, 'thread-a', 'Second message', createId)).toBe(second);
    expect(messageSubmissionId(pending, 'thread-a', 'First message', createId)).not.toBe(first);
  });

  it('clears only the accepted Thread draft when its text is unchanged', () => {
    const drafts = { 'thread-a': 'Sent text', 'thread-b': 'Other Thread draft' };

    expect(clearAcceptedMessageDraft(drafts, 'thread-a', 'Sent text')).toEqual({
      'thread-a': '',
      'thread-b': 'Other Thread draft',
    });
    expect(clearAcceptedMessageDraft(drafts, 'thread-a', 'Different text')).toBe(drafts);
  });

  it('tracks pending submissions independently so one Thread can continue while another is sending', () => {
    const empty = new Set<string>();
    const threadA = withPendingThreadSubmission(empty, 'thread-a', true);
    const both = withPendingThreadSubmission(threadA, 'thread-b', true);
    const threadB = withPendingThreadSubmission(both, 'thread-a', false);

    expect(empty.size).toBe(0);
    expect(threadA).toEqual(new Set(['thread-a']));
    expect(both).toEqual(new Set(['thread-a', 'thread-b']));
    expect(threadB).toEqual(new Set(['thread-b']));
  });
});
