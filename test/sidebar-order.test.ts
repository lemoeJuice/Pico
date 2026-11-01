import { describe, expect, it } from 'vitest';
import type { Project, Thread } from '../src/core/types.js';
import { sortSidebarProjects, sortSidebarThreads } from '../src/web/sidebar-order.js';

const thread = (id: string, lastUserMessageAt: string | null, extra: Partial<Thread> = {}): Thread => ({
  id, projectId: null, executorId: 'e', executorKind: 'host', executorRemote: false, executorLabel: '',
  workspacePath: '', title: id, parentThreadId: null, createdByAgent: false, pauseRequested: false,
  pauseReason: null, createdAt: '2026-10-30T00:00:00Z', state: 'idle', lastUserMessageAt, ...extra,
});
const project = (id: string): Project => ({ id, name: id, workspacePath: '', createdAt: '2026-10-31T00:00:00Z' });

describe('sidebar ordering', () => {
  it('orders threads by user activity and puts threads without messages afterwards', () => {
    const input = [thread('empty', null), thread('old', '2026-10-01T00:00:00Z'), thread('new', '2026-10-02T00:00:00Z')];
    expect(sortSidebarThreads(input).map((item) => item.id)).toEqual(['new', 'old', 'empty']);
    expect(input[0]!.id).toBe('empty');
  });
  it('orders projects by their latest visible thread user message, including child threads', () => {
    const items = [project('empty'), project('a'), project('b')];
    const byProject = {
      a: [thread('a1', '2026-10-02T00:00:00Z'), thread('a2', '2026-10-04T00:00:00Z', { archivedAt: '2026-10-05' })],
      b: [thread('b1', '2026-10-03T00:00:00Z', { parentThreadId: 'root' })],
    };
    expect(sortSidebarProjects(items, byProject).map((item) => item.id)).toEqual(['b', 'a', 'empty']);
  });
});
