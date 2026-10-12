import type { Execution } from '../core/types.js';

export type AssistantDraft = { executionId: string; text: string };
export type AssistantDrafts = Record<string, AssistantDraft>;
export type AssistantStreamExecutions = Map<string, string>;

export function appendAssistantDraft(
  drafts: AssistantDrafts,
  threadId: string,
  executionId: string,
  delta: string,
): AssistantDrafts {
  const current = drafts[threadId];
  const text = current?.executionId === executionId ? `${current.text}${delta}` : delta;
  return { ...drafts, [threadId]: { executionId, text } };
}

export function assistantDraftForThread(drafts: AssistantDrafts, threadId: string | null): string {
  return threadId ? (drafts[threadId]?.text ?? '') : '';
}

export function clearAssistantDraft(drafts: AssistantDrafts, threadId: string, executionId?: string): AssistantDrafts {
  const current = drafts[threadId];
  if (!current || (executionId !== undefined && current.executionId !== executionId)) return drafts;
  const next = { ...drafts };
  delete next[threadId];
  return next;
}

export function observeAssistantExecutions(
  active: AssistantStreamExecutions,
  unavailable: AssistantStreamExecutions,
  executions: readonly Pick<Execution, 'id' | 'threadId' | 'kind' | 'status'>[],
  observedOnConnection: ReadonlySet<string>,
): { active: AssistantStreamExecutions; unavailable: AssistantStreamExecutions } {
  if (!executions.some((execution) => execution.kind === 'model')) return { active, unavailable };
  const nextActive = new Map(active);
  const nextUnavailable = new Map(unavailable);
  for (const execution of executions) {
    if (execution.kind !== 'model') continue;
    if (execution.status === 'pending' || execution.status === 'running') {
      for (const [activeId, threadId] of nextActive) {
        if (threadId === execution.threadId && activeId !== execution.id) {
          nextActive.delete(activeId);
          nextUnavailable.delete(activeId);
        }
      }
      nextActive.set(execution.id, execution.threadId);
      if (observedOnConnection.has(execution.id)) {
        nextUnavailable.delete(execution.id);
      } else {
        nextUnavailable.set(execution.id, execution.threadId);
      }
    } else {
      nextActive.delete(execution.id);
      nextUnavailable.delete(execution.id);
    }
  }
  return { active: nextActive, unavailable: nextUnavailable };
}

export function assistantStreamsAfterDisconnect(
  active: AssistantStreamExecutions,
  drafts: AssistantDrafts,
  unavailable: AssistantStreamExecutions,
): AssistantStreamExecutions {
  const next = new Map(unavailable);
  for (const [executionId, threadId] of active) next.set(executionId, threadId);
  for (const [threadId, draft] of Object.entries(drafts)) next.set(draft.executionId, threadId);
  return next;
}

export function canAppendAssistantDelta(
  active: AssistantStreamExecutions,
  unavailable: AssistantStreamExecutions,
  threadId: string,
  executionId: string,
): boolean {
  return active.get(executionId) === threadId && !unavailable.has(executionId);
}
