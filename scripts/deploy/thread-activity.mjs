/** Count Threads that make stopping the Runtime unsafe. */
export async function getActiveThreadCount(threads, readThreadSnapshot) {
  if (!Array.isArray(threads)) throw new Error('The Runtime returned an invalid Thread list; refusing to restart.');
  const activeThreadIds = new Set();
  const snapshotThreads = [];
  for (const thread of threads) {
    switch (thread?.state) {
      case 'idle':
        break;
      case 'paused':
      case 'model_error':
        snapshotThreads.push(thread);
        break;
      case 'running':
      case 'pausing':
      case 'waiting_permission':
        activeThreadIds.add(thread.id);
        break;
      default:
        throw new Error('The Runtime returned an unknown Thread state; refusing to restart.');
    }
  }
  for (let index = 0; index < snapshotThreads.length; index += 8) {
    const page = snapshotThreads.slice(index, index + 8);
    const snapshots = await Promise.all(
      page.map((thread) => {
        if (typeof thread.id !== 'string' || !thread.id) {
          throw new Error('The Runtime returned a Thread without an ID; refusing to restart.');
        }
        return readThreadSnapshot(thread.id);
      }),
    );
    for (const [pageIndex, snapshot] of snapshots.entries()) {
      if (!Array.isArray(snapshot?.executions)) {
        throw new Error('The Runtime returned an invalid execution snapshot; refusing to restart.');
      }
      if (snapshot.executions.some((execution) => execution.status === 'pending' || execution.status === 'running')) {
        activeThreadIds.add(page[pageIndex].id);
      }
    }
  }
  return activeThreadIds.size;
}
