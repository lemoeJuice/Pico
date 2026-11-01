import { describe, expect, it } from 'vitest';
import type { Thread } from '../src/core/types.js';
import type { ThreadSnapshot } from '../src/contracts/runtime.js';
import { applyThreadStateUpdate, updateThreadList } from '../src/web/thread-state.js';

function thread(id: string, projectId: string | null = 'project-a', archivedAt: string | null = null): Thread {
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

  it('preserves activity from list responses when state events omit it', () => {
    const existing = { ...thread('thread-a'), lastUserMessageAt: '2026-10-30T12:00:00Z' };
    const next = applyThreadStateUpdate(
      { threads: [existing], threadsByProject: { 'project-a': [existing] }, snapshot: null },
      { ...thread('thread-a'), state: 'running' }, 'project-a',
    );
    expect(next.threads[0]?.lastUserMessageAt).toBe(existing.lastUserMessageAt);
    expect(next.threadsByProject['project-a']?.[0]?.lastUserMessageAt).toBe(existing.lastUserMessageAt);
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

  it('moves a selected independent Thread into its Project projection and updates its snapshot', () => {
    const standalone = thread('thread-a', null);
    const current = { threads: [standalone], threadsByProject: {}, snapshot: snapshot(standalone) };
    const moved = thread('thread-a', 'project-b');

    const next = applyThreadStateUpdate(current, moved, null);

    expect(next.threads).toEqual([]);
    expect(next.threadsByProject['project-b']).toEqual([moved]);
    expect(next.snapshot?.thread).toEqual(moved);
  });

  it('adds every moved subtree row to the new Project list', () => {
    const root = thread('root', null);
    const child = { ...thread('child', null), parentThreadId: 'root' };
    const current = { threads: [root, child], threadsByProject: {}, snapshot: snapshot(root) };
    const movedRoot = thread('root', 'project-b');
    const movedChild = { ...thread('child', 'project-b'), parentThreadId: 'root' };

    const next = applyThreadStateUpdate(current, movedRoot, null);
    const withChild = applyThreadStateUpdate(next, movedChild, null);

    expect(withChild.threads).toEqual([]);
    expect(withChild.threadsByProject['project-b']?.map((item) => item.id)).toEqual(['child', 'root']);
  });

  it('removes a converted Thread from the currently selected navigation list', () => {
    const standalone = thread('thread-a', null);
    expect(updateThreadList([standalone], thread('thread-a', 'project-a'), null)).toEqual([]);
    const projectThread = thread('thread-b', 'project-a');
    expect(updateThreadList([projectThread], thread('thread-b', 'project-a'), 'project-b')).toEqual([]);
  });
});
