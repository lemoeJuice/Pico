export type AssistantDraft = { executionId: string; text: string };
export type AssistantDrafts = Record<string, AssistantDraft>;

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
