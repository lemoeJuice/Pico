export type PendingMessageIds = Map<string, Map<string, string>>;

export const MESSAGE_SUBMISSION_TIMEOUT_MS = 20_000;

export function messageSubmissionRequestInit(
  id: string,
  content: string,
  timeoutMs = MESSAGE_SUBMISSION_TIMEOUT_MS,
): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({ id, content }),
    signal: AbortSignal.timeout(timeoutMs),
  };
}

export function messageSubmissionFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Message delivery is unconfirmed. Your draft is safe; send it again to retry without duplicating it.';
  }
  return error instanceof Error ? error.message : String(error);
}

export function withPendingThreadSubmission(
  pending: ReadonlySet<string>,
  threadId: string,
  isPending: boolean,
): Set<string> {
  const next = new Set(pending);
  if (isPending) next.add(threadId);
  else next.delete(threadId);
  return next;
}

/** Reuse an uncertain submission ID only for the same content in the same Thread. */
export function messageSubmissionId(
  pending: PendingMessageIds,
  threadId: string,
  content: string,
  createId: () => string,
): string {
  let threadMessages = pending.get(threadId);
  if (!threadMessages) {
    threadMessages = new Map();
    pending.set(threadId, threadMessages);
  }
  const existing = threadMessages.get(content);
  if (existing) return existing;
  const id = createId();
  threadMessages.set(content, id);
  return id;
}

/** Clear a pending identity after its acceptance is confirmed by HTTP or canonical history. */
export function settleMessageSubmission(pending: PendingMessageIds, threadId: string, id: string): boolean {
  const threadMessages = pending.get(threadId);
  if (!threadMessages) return false;
  let settled = false;
  for (const [content, pendingId] of threadMessages) {
    if (pendingId === id) {
      threadMessages.delete(content);
      settled = true;
    }
  }
  if (threadMessages.size === 0) pending.delete(threadId);
  return settled;
}

export function hasPendingMessageSubmission(pending: PendingMessageIds, threadId: string, id: string): boolean {
  return [...(pending.get(threadId)?.values() ?? [])].includes(id);
}

export function clearAcceptedMessageDraft(
  drafts: Record<string, string>,
  threadId: string,
  content: string,
): Record<string, string> {
  if ((drafts[threadId] ?? '').trim() !== content) return drafts;
  return { ...drafts, [threadId]: '' };
}
