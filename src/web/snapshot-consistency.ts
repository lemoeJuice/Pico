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
