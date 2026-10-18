/** Read replayable reasoning from current payloads and older DeepSeek payloads. */
export function assistantReasoningContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  if (typeof value.reasoningContent === 'string') return value.reasoningContent;
  if (value.reasoningFormat === 'deepseek-content' && typeof value.reasoningSummary === 'string')
    return value.reasoningSummary;
  return undefined;
}
