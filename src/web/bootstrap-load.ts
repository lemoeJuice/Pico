import { fetchStableSnapshot, type SnapshotRetryProgress } from './snapshot-consistency.js';

// Each resource can finish or fail independently; a slow optional resource must
// not hold back Projects or other parts of the workspace.
export async function loadBootstrapResource<T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
  apply: (result: T) => void,
  fail: (error: unknown) => void,
  onRetry?: (progress: SnapshotRetryProgress) => void,
): Promise<void> {
  try {
    const result = await fetchStableSnapshot(request, () => 0, isCurrent, onRetry ? { onRetry } : {});
    if (isCurrent() && result !== null) apply(result);
  } catch (error) {
    if (isCurrent()) fail(error);
  }
}
