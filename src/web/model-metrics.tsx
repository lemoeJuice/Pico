import { useEffect, useState } from 'react';
import type { ModelInputAttempt } from '../contracts/runtime.js';

/** Select the final physical request, including when it did not report token usage. */
export function latestOutputTokensPerSecond(attempts: ModelInputAttempt[]): number | null {
  const requests = attempts.flatMap((attempt) => attempt.providerRequests ?? []);
  const value = requests.at(-1)?.outputTokensPerSecond;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
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
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setValue(null);
    if (!executionId || status === 'pending' || status === 'running')
      return () => {
        active = false;
      };
    void request<{ attempts: ModelInputAttempt[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/executions/${encodeURIComponent(executionId)}/model-input`,
    )
      .then((result) => {
        if (active) setValue(latestOutputTokensPerSecond(result.attempts));
      })
      .catch(() => {
        if (active) setValue(null);
      });
    return () => {
      active = false;
    };
  }, [threadId, executionId, status, request]);
  return (
    <span
      className="composer-tps"
      title="Provider output tokens per second over the entire request, including the wait for the first text."
      aria-label={
        value === null
          ? 'Output speed unavailable'
          : `Output speed ${Math.round(value)} tokens per second including initial wait`
      }
    >
      {value === null ? 'TPS —' : `TPS ${Math.round(value)}`}
    </span>
  );
}
