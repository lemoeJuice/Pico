import type { Thread } from '../core/types.js';
import type { ThreadSnapshot } from '../contracts/runtime.js';
import { upsertProjectThread } from './project-threads.js';

export interface ThreadStateProjection {
  threads: Thread[];
  threadsByProject: Record<string, Thread[]>;
  snapshot: ThreadSnapshot | null;
}

/** Apply the same Thread projection rules to the selected list, project cache, and snapshot. */
export function applyThreadStateUpdate(
  current: ThreadStateProjection,
  updated: Thread,
  selectedProjectId: string | null,
): ThreadStateProjection {
  // List responses carry activity metadata; ordinary thread events may omit it.
  const previous = current.threads.find((thread) => thread.id === updated.id)
    ?? (updated.projectId ? current.threadsByProject[updated.projectId]?.find((thread) => thread.id === updated.id) : undefined);
  if (updated.lastUserMessageAt === undefined && previous?.lastUserMessageAt !== undefined) {
    updated = { ...updated, lastUserMessageAt: previous.lastUserMessageAt };
  }
  const isActive = !updated.archivedAt && !updated.deletedAt;
  const projectThreads = updated.projectId ? (current.threadsByProject[updated.projectId] ?? []) : [];
  const sameSelection = current.threads.filter((thread) => thread.id !== updated.id);
  return {
    threads: isActive
      ? upsertProjectThread(sameSelection, updated, selectedProjectId)
      : current.threads.filter((thread) => thread.id !== updated.id),
    threadsByProject: {
      ...current.threadsByProject,
      ...(updated.projectId
        ? {
            [updated.projectId]: isActive
              ? upsertProjectThread(projectThreads, updated, updated.projectId)
              : projectThreads.filter((thread) => thread.id !== updated.id),
          }
        : {}),
    },
    snapshot:
      current.snapshot?.thread.id !== updated.id
        ? current.snapshot
        : isActive
          ? { ...current.snapshot, thread: updated }
          : null,
  };
}

export function updateThreadList(threads: Thread[], updated: Thread, selectedProjectId: string | null): Thread[] {
  return applyThreadStateUpdate({ threads, threadsByProject: {}, snapshot: null }, updated, selectedProjectId).threads;
}

export function updateThreadSnapshot(snapshot: ThreadSnapshot | null, updated: Thread): ThreadSnapshot | null {
  return applyThreadStateUpdate({ threads: [], threadsByProject: {}, snapshot }, updated, null).snapshot;
}

export function updateProjectThreadList(
  threadsByProject: Record<string, Thread[]>,
  updated: Thread,
): Record<string, Thread[]> {
  return applyThreadStateUpdate({ threads: [], threadsByProject, snapshot: null }, updated, null).threadsByProject;
}
