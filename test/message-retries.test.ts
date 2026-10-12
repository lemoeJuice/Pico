import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  clearAcceptedMessageDraft,
  hasPendingMessageSubmission,
  messageSubmissionFailureMessage,
  messageSubmissionRequestInit,
  messageSubmissionId,
  settleMessageSubmission,
  type PendingMessageIds,
  withPendingThreadSubmission,
} from '../src/web/message-retries.js';

describe('Thread-scoped message retries', () => {
  it('times out an unconfirmed Message request so the same draft can be retried', async () => {
    const pending: PendingMessageIds = new Map();
    const createId = (): string => 'message-timeout';
    const id = messageSubmissionId(pending, 'thread-a', 'Keep this draft', createId);
    const request = messageSubmissionRequestInit(id, 'Keep this draft', 50);
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');

    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({ id: 'message-timeout', content: 'Keep this draft' });
    let timeoutError: unknown;
    try {
      await fetch(`http://127.0.0.1:${address.port}/messages`, request);
    } catch (error) {
      timeoutError = error;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(timeoutError).toMatchObject({ name: 'TimeoutError' });
    expect(messageSubmissionId(pending, 'thread-a', 'Keep this draft', createId)).toBe(id);
    expect(messageSubmissionFailureMessage(timeoutError)).toContain('delivery is unconfirmed');
  });

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
