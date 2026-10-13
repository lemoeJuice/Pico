export type PendingMessageIds = Map<string, Map<string, string>>;

export const MESSAGE_SUBMISSION_TIMEOUT_MS = 20_000;
export const COMPOSER_STATE_STORAGE_KEY = 'pico.composer.v1';

export interface ComposerState {
  draftsByThread: Record<string, string>;
  pendingMessages: PendingMessageIds;
}

export function parseComposerState(serialized: string | null): ComposerState {
  if (!serialized) return { draftsByThread: {}, pendingMessages: new Map() };
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
      return { draftsByThread: {}, pendingMessages: new Map() };
    }
    const raw = value as { draftsByThread?: unknown; pendingMessages?: unknown };
    const draftsByThread: Record<string, string> = {};
    if (raw.draftsByThread && typeof raw.draftsByThread === 'object' && !Array.isArray(raw.draftsByThread)) {
      for (const [threadId, content] of Object.entries(raw.draftsByThread)) {
        if (threadId && typeof content === 'string' && content.length > 0) draftsByThread[threadId] = content;
      }
    }
    const pendingMessages: PendingMessageIds = new Map();
    if (raw.pendingMessages && typeof raw.pendingMessages === 'object' && !Array.isArray(raw.pendingMessages)) {
      for (const [threadId, entries] of Object.entries(raw.pendingMessages)) {
        if (!threadId || !entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        const messages = new Map<string, string>();
        for (const [content, id] of Object.entries(entries)) {
          if (content && typeof id === 'string' && id) messages.set(content, id);
        }
        if (messages.size > 0) pendingMessages.set(threadId, messages);
      }
    }
    return { draftsByThread, pendingMessages };
  } catch {
    return { draftsByThread: {}, pendingMessages: new Map() };
  }
}

export function serializeComposerState(state: ComposerState): string {
  const draftsByThread = Object.fromEntries(
    Object.entries(state.draftsByThread).filter(([threadId, content]) => threadId && content.length > 0),
  );
  const pendingMessages: Record<string, Record<string, string>> = {};
  for (const [threadId, messages] of state.pendingMessages) {
    if (threadId && messages.size > 0) pendingMessages[threadId] = Object.fromEntries(messages);
  }
  return JSON.stringify({ version: 1, draftsByThread, pendingMessages });
}

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

/** Settle the uncertain identity and clear its unchanged draft as one state transition. */
export function acceptComposerMessage(state: ComposerState, threadId: string, id: string, content: string): boolean {
  if (!settleMessageSubmission(state.pendingMessages, threadId, id)) return false;
  state.draftsByThread = clearAcceptedMessageDraft(state.draftsByThread, threadId, content);
  return true;
}
