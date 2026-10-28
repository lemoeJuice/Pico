import type { Execution } from '../core/types.js';

export type ToolCallPreview = { index: number; id?: string; name?: string; argumentsText: string };
export type AssistantDraft = {
  executionId: string;
  text: string;
  unconfirmed?: boolean;
  previewIncomplete?: boolean;
  reasoningSummary?: string;
  tools?: ToolCallPreview[];
};
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
  return { ...drafts, [threadId]: { ...(current?.executionId === executionId ? current : {}), executionId, text } };
}

export function appendAssistantPreview(
  drafts: AssistantDrafts,
  threadId: string,
  executionId: string,
  preview: { type: 'reasoning'; delta: string } | { type: 'tool'; call: ToolCallPreview },
): AssistantDrafts {
  const existing = drafts[threadId];
  const current: AssistantDraft = existing?.executionId === executionId ? existing : { executionId, text: '' };
  if (preview.type === 'reasoning') {
    return {
      ...drafts,
      [threadId]: { ...current, reasoningSummary: (current.reasoningSummary ?? '') + preview.delta },
    };
  }
  const previous = current.tools?.find((call) => call.index === preview.call.index);
  const call = { ...previous, ...preview.call };
  const tools = [...(current.tools ?? []).filter((item) => item.index !== call.index), call].sort(
    (a, b) => a.index - b.index,
  );
  return { ...drafts, [threadId]: { ...current, tools } };
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
