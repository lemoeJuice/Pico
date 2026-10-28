import { describe, expect, it } from 'vitest';
import type { Thread } from '../src/core/types.js';
import type { ThreadSnapshot } from '../src/contracts/runtime.js';
import { applyThreadStateUpdate } from '../src/web/thread-state.js';

function thread(id: string, projectId = 'project-a', archivedAt: string | null = null): Thread {
  return { id, projectId, archivedAt, deletedAt: null } as Thread;
}

function snapshot(value: Thread): ThreadSnapshot {
  return { thread: value } as ThreadSnapshot;
}

describe('applyThreadStateUpdate', () => {
  it('keeps selected, project, and snapshot Thread projections consistent', () => {
    const existing = thread('thread-a');
    const current = {
      threads: [existing],
      threadsByProject: { 'project-a': [existing] },
      snapshot: snapshot(existing),
    };
    const updated = { ...existing, title: 'Updated' };

    const next = applyThreadStateUpdate(current, updated, 'project-a');

    expect(next.threads).toEqual([updated]);
    expect(next.threadsByProject['project-a']).toEqual([updated]);
    expect(next.snapshot?.thread).toEqual(updated);
  });

  it('removes archived Threads from active projections and clears only their snapshot', () => {
    const archived = thread('thread-a');
    const other = thread('thread-b');
    const current = {
      threads: [archived, other],
      threadsByProject: { 'project-a': [archived, other] },
      snapshot: snapshot(archived),
    };

    const next = applyThreadStateUpdate(current, thread('thread-a', 'project-a', '2026-10-28'), 'project-a');

    expect(next.threads).toEqual([other]);
    expect(next.threadsByProject['project-a']).toEqual([other]);
    expect(next.snapshot).toBeNull();
    expect(
      applyThreadStateUpdate(
        { ...current, snapshot: snapshot(other) },
        thread('thread-a', 'project-a', 'archived'),
        'project-a',
      ).snapshot,
    ).toEqual(snapshot(other));
  });
});
