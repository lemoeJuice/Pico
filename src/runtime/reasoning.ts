/** Read replayable reasoning from the current assistant payload contract. */
export function assistantReasoningContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  return typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined;
}
