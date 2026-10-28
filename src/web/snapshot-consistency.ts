export type SnapshotRetryOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  wait?: (delayMs: number) => Promise<void>;
  onRetry?: (progress: SnapshotRetryProgress) => void;
};

export type SnapshotRetryProgress = {
  error: unknown;
  attempt: number;
  delayMs: number;
};

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableSnapshotError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  if ('name' in error && error.name === 'TimeoutError') return true;
  if (!('status' in error) || typeof error.status !== 'number') return false;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export async function fetchStableSnapshot<T>(
  fetchSnapshot: () => Promise<T>,
  revision: () => number,
  isCurrent: () => boolean,
  options: SnapshotRetryOptions = {},
): Promise<T | null> {
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const retry = options.isRetryable ?? isRetryableSnapshotError;
  const pause = options.wait ?? wait;
  let consecutiveFailures = 0;

  while (isCurrent()) {
    const startedAt = revision();
    let snapshot: T;
    try {
      snapshot = await fetchSnapshot();
    } catch (error) {
      if (!isCurrent()) return null;
      if (!retry(error)) throw error;
      if (revision() !== startedAt) consecutiveFailures = 0;
      const delay = Math.min(initialDelayMs * 2 ** consecutiveFailures, maxDelayMs);
      consecutiveFailures += 1;
      options.onRetry?.({ error, attempt: consecutiveFailures, delayMs: delay });
      await pause(delay);
      continue;
    }
    if (!isCurrent()) return null;
    if (revision() === startedAt) return snapshot;
    consecutiveFailures = 0;
  }
  return null;
}

export function snapshotThreadIsSelected(threadId: string, selectedThreadId: string | null): boolean {
  return threadId === selectedThreadId;
}

export function updateSnapshotForThread<T extends { thread: { id: string } }>(
  snapshot: T | null,
  threadId: string,
  update: (current: T) => T,
): T | null {
  if (!snapshot || !snapshotThreadIsSelected(snapshot.thread.id, threadId)) return snapshot;
  return update(snapshot);
}

export function snapshotForSelection<T extends { thread: { id: string; projectId: string } }>(
  snapshot: T | null,
  threadId: string | null,
  projectId: string | null,
): T | null {
  if (!snapshot || !threadId || !projectId) return null;
  return snapshotThreadIsSelected(snapshot.thread.id, threadId) && snapshot.thread.projectId === projectId
    ? snapshot
    : null;
}
