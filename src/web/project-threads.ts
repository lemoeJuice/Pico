export function upsertProjectThread<T extends { id: string; projectId: string }>(
  threads: T[],
  thread: T,
  selectedProjectId: string | null,
): T[] {
  if (thread.projectId !== selectedProjectId) return threads;
  const index = threads.findIndex((item) => item.id === thread.id);
  if (index < 0) return [thread, ...threads];
  const next = [...threads];
  next[index] = thread;
  return next;
}
