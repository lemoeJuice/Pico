import type { Project, Thread } from '../core/types.js';

export const SIDEBAR_PAGE_SIZE = 10;

function compareActivity(a: { message: string | null; createdAt: string; id: string }, b: typeof a): number {
  if (a.message && b.message) return b.message.localeCompare(a.message) || a.id.localeCompare(b.id);
  if (a.message || b.message) return a.message ? -1 : 1;
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** Threads without a user message follow active threads, newest first. */
export function sortSidebarThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => compareActivity(
    { message: a.lastUserMessageAt ?? null, createdAt: a.createdAt, id: a.id },
    { message: b.lastUserMessageAt ?? null, createdAt: b.createdAt, id: b.id },
  ));
}

export function sortSidebarProjects(projects: Project[], threadsByProject: Record<string, Thread[]>): Project[] {
  const activity = (project: Project) => ({
    id: project.id,
    createdAt: project.createdAt,
    message: (threadsByProject[project.id] ?? [])
      .filter((thread) => !thread.archivedAt && !thread.deletedAt)
      .reduce<string | null>((latest, thread) =>
        thread.lastUserMessageAt && (!latest || thread.lastUserMessageAt > latest) ? thread.lastUserMessageAt : latest, null),
  });
  return [...projects].sort((a, b) => compareActivity(activity(a), activity(b)));
}
