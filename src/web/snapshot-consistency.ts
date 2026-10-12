export async function fetchStableSnapshot<T>(
  fetchSnapshot: () => Promise<T>,
  revision: () => number,
  isCurrent: () => boolean,
): Promise<T | null> {
  while (isCurrent()) {
    const startedAt = revision();
    const snapshot = await fetchSnapshot();
    if (!isCurrent()) return null;
    if (revision() === startedAt) return snapshot;
  }
  return null;
}
