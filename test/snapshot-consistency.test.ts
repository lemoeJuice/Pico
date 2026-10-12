import { describe, expect, it, vi } from 'vitest';
import {
  fetchStableSnapshot,
  snapshotForSelection,
  snapshotThreadIsSelected,
  updateSnapshotForThread,
} from '../src/web/snapshot-consistency.js';

describe('snapshot refresh consistency', () => {
  it('refreshes a Project thread list when creation races the request', async () => {
    let version = 0;
    let requests = 0;
    const threads = await fetchStableSnapshot(
      async () => {
        requests += 1;
        if (requests === 1) {
          version += 1;
          return [{ id: 'main', projectId: 'project-a' }];
        }
        return [
          { id: 'new-thread', projectId: 'project-a' },
          { id: 'main', projectId: 'project-a' },
        ];
      },
      () => version,
      () => true,
    );

    expect(requests).toBe(2);
    expect(threads).toEqual([
      { id: 'new-thread', projectId: 'project-a' },
      { id: 'main', projectId: 'project-a' },
    ]);
  });

  it('discards a snapshot when its Thread is no longer selected', async () => {
    let selected = true;
    const snapshot = await fetchStableSnapshot(
      async () => {
        selected = false;
        return { assistantMessages: ['stale thread'] };
      },
      () => 0,
      () => selected,
    );

    expect(snapshot).toBeNull();
  });

  it('never exposes a snapshot from a different Thread or Project selection', () => {
    const snapshot = { thread: { id: 'thread-a', projectId: 'project-a' }, records: ['old conversation'] };

    expect(snapshotForSelection(snapshot, 'thread-b', 'project-a')).toBeNull();
    expect(snapshotForSelection(snapshot, 'thread-a', 'project-b')).toBeNull();
    expect(snapshotForSelection(snapshot, 'thread-a', 'project-a')).toBe(snapshot);
  });

  it('does not start a background refresh for a Thread that is no longer selected', () => {
    expect(snapshotThreadIsSelected('thread-a', 'thread-b')).toBe(false);
    expect(snapshotThreadIsSelected('thread-b', 'thread-b')).toBe(true);
  });

  it('does not apply a late approval response to the selected Thread snapshot', () => {
    const current = { thread: { id: 'thread-b' }, approvals: [{ executionId: 'approval-b' }] };
    const update = vi.fn((snapshot: typeof current) => ({ ...snapshot, approvals: [] }));

    const unchanged = updateSnapshotForThread(current, 'thread-a', update);
    const changed = updateSnapshotForThread(current, 'thread-b', update);

    expect(unchanged).toBe(current);
    expect(update).toHaveBeenCalledTimes(1);
    expect(changed).toEqual({ thread: { id: 'thread-b' }, approvals: [] });
  });
});
