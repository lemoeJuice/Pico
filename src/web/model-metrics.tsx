import { useEffect, useState } from 'react';
import type { ModelInputAttempt } from '../contracts/runtime.js';

/** Uses provider-reported output tokens and excludes time before the first visible text. */
export function latestGenerationTokensPerSecond(attempts: ModelInputAttempt[]): number | null {
  const request = attempts.flatMap((attempt) => attempt.providerRequests ?? []).at(-1);
  if (!request || request.outcome !== 'completed') return null;
  const { outputTokens } = request.usage ?? {};
  const { durationMs, firstTextMs } = request;
  if (
    typeof outputTokens !== 'number' ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    typeof firstTextMs !== 'number' ||
    !Number.isFinite(firstTextMs) ||
    firstTextMs < 0 ||
    durationMs <= firstTextMs
  ) {
    return null;
  }
  return (outputTokens * 1000) / (durationMs - firstTextMs);
}

export function ComposerTps({
  threadId,
  executionId,
  status,
  request,
}: {
  threadId: string;
  executionId: string | null;
  status: string | null;
  request<T>(path: string): Promise<T>;
}) {
  const [result, setResult] = useState<{ key: string; value: number | null } | null>(null);
  const key = JSON.stringify([threadId, executionId, status]);
  useEffect(() => {
    let current = true;
    setResult(null);
    try {
      // Discard values saved by the previous text-estimation implementation.
      localStorage.removeItem(`pico.visible-text-tps.${threadId}`);
    } catch {
      /* Storage is optional. */
    }
    // Only a settled execution has authoritative output usage. This also clears a previous
    // execution's number as soon as a new turn starts or its status changes.
    if (!executionId || status !== 'completed')
      return () => {
        current = false;
      };
    void request<{ attempts: ModelInputAttempt[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/executions/${encodeURIComponent(executionId)}/model-input`,
    )
      .then(({ attempts }) => {
        if (current) setResult({ key, value: latestGenerationTokensPerSecond(attempts) });
      })
      .catch(() => {
        if (current) setResult({ key, value: null });
      });
    return () => {
      current = false;
    };
  }, [threadId, executionId, status, request, key]);
  const value = status === 'completed' && result?.key === key ? result.value : null;
  return (
    <span
      className="composer-tps"
      title="Provider-reported output tokens per second, measured from the first visible text through the end of the latest completed model request. Unavailable when token usage or timing is missing."
      aria-label={
        value === null ? 'Output token speed unavailable' : `Output token speed ${Math.round(value)} tokens per second`
      }
    >
      {value === null ? 'TPS —' : `TPS ${Math.round(value)}`}
    </span>
  );
}
