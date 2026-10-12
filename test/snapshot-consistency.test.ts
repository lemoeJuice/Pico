import { describe, expect, it } from 'vitest';
import { fetchStableSnapshot, snapshotForSelection } from '../src/web/snapshot-consistency.js';

describe('snapshot refresh consistency', () => {
  it('fetches again when live thread events arrive during a snapshot request', async () => {
    let version = 0;
    let requests = 0;
    const snapshot = await fetchStableSnapshot(
      async () => {
        requests += 1;
        if (requests === 1) {
          version += 1;
          return { assistantMessages: [] };
        }
        return { assistantMessages: ['latest reply'] };
      },
      () => version,
      () => true,
    );

    expect(requests).toBe(2);
    expect(snapshot).toEqual({ assistantMessages: ['latest reply'] });
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
});
