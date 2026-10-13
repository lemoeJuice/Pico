import { describe, expect, it, vi } from 'vitest';
import {
  fetchStableSnapshot,
  isRetryableSnapshotError,
  snapshotForSelection,
  snapshotThreadIsSelected,
  updateSnapshotForThread,
} from '../src/web/snapshot-consistency.js';

describe('snapshot refresh consistency', () => {
  it('retries transient network and server failures with capped backoff', async () => {
    let requests = 0;
    const delays: number[] = [];
    const snapshot = await fetchStableSnapshot(
      async () => {
        requests += 1;
        if (requests === 1) throw new TypeError('network unavailable');
        if (requests < 4) throw Object.assign(new Error('temporary failure'), { status: 503 });
        return { records: ['latest'] };
      },
      () => 0,
      () => true,
      { initialDelayMs: 4, maxDelayMs: 10, wait: async (delay) => void delays.push(delay) },
    );

    expect(snapshot).toEqual({ records: ['latest'] });
    expect(requests).toBe(4);
    expect(delays).toEqual([4, 8, 10]);
  });

  it('stops retrying when the selected resource changes during backoff', async () => {
    let current = true;
    let requests = 0;
    const snapshot = await fetchStableSnapshot(
      async () => {
        requests += 1;
        throw new TypeError('network unavailable');
      },
      () => 0,
      () => current,
      {
        wait: async () => {
          current = false;
        },
      },
    );

    expect(snapshot).toBeNull();
    expect(requests).toBe(1);
  });

  it('does not retry permanent client errors', async () => {
    let requests = 0;
    const failure = Object.assign(new Error('not found'), { status: 404 });

    await expect(
      fetchStableSnapshot(
        async () => {
          requests += 1;
          throw failure;
        },
        () => 0,
        () => true,
        { wait: async () => undefined },
      ),
    ).rejects.toBe(failure);

    expect(requests).toBe(1);
    expect(isRetryableSnapshotError(new TypeError('offline'))).toBe(true);
    expect(isRetryableSnapshotError(Object.assign(new Error('unavailable'), { status: 503 }))).toBe(true);
    expect(isRetryableSnapshotError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false);
  });

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

  it('does not apply a late plugin response to the selected Thread snapshot', () => {
    const current = { thread: { id: 'thread-b' }, pluginState: 'current' };
    const update = vi.fn((snapshot: typeof current) => ({ ...snapshot, pluginState: 'updated' }));

    const unchanged = updateSnapshotForThread(current, 'thread-a', update);
    const changed = updateSnapshotForThread(current, 'thread-b', update);

    expect(unchanged).toBe(current);
    expect(update).toHaveBeenCalledTimes(1);
    expect(changed).toEqual({ thread: { id: 'thread-b' }, pluginState: 'updated' });
  });
});
