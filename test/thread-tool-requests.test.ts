import { describe, expect, it } from 'vitest';
import { ThreadToolRequestGuard } from '../src/web/thread-tool-requests.js';

describe('ThreadToolRequestGuard', () => {
  it('ignores a late success after switching Threads, including switching back', () => {
    const guard = new ThreadToolRequestGuard();
    const oldRequest = guard.begin('thread-a');
    guard.invalidateAll();
    const newRequest = guard.begin('thread-b');
    guard.invalidateAll();
    const returnedSelection = guard.begin('thread-a');

    expect(guard.isCurrent(oldRequest, 'thread-a')).toBe(false);
    expect(guard.isCurrent(newRequest, 'thread-b')).toBe(false);
    expect(guard.isCurrent(returnedSelection, 'thread-a')).toBe(true);
  });

  it('ignores a late failure after switching Threads', () => {
    const guard = new ThreadToolRequestGuard();
    const staleRequest = guard.begin('thread-a');
    guard.invalidateAll();
    guard.begin('thread-b');
    const errors: string[] = [];
    if (guard.isCurrent(staleRequest, 'thread-a')) errors.push('stale failure');

    expect(errors).toEqual([]);
  });

  it('allows only the most recent request for the selected Thread to update state', () => {
    const guard = new ThreadToolRequestGuard();
    const first = guard.begin('thread-a');
    const second = guard.begin('thread-a');
    const applied: string[] = [];
    if (guard.isCurrent(first, 'thread-a')) applied.push('first');
    if (guard.isCurrent(second, 'thread-a')) applied.push('second');

    expect(applied).toEqual(['second']);
    expect(guard.isCurrent(second, 'thread-b')).toBe(false);
  });

  it('lets a newer mutation supersede an older load on the same Thread', () => {
    const guard = new ThreadToolRequestGuard();
    const oldLoad = guard.begin('thread-a');
    const mutation = guard.begin('thread-a');
    const applied: string[] = [];
    if (guard.isCurrent(oldLoad, 'thread-a')) applied.push('load result');
    if (guard.isCurrent(mutation, 'thread-a')) applied.push('mutation result');

    expect(applied).toEqual(['mutation result']);
  });

  it('lets a WebSocket refresh supersede an older mutation on the same Thread', () => {
    const guard = new ThreadToolRequestGuard();
    const oldMutation = guard.begin('thread-a');
    const websocketLoad = guard.begin('thread-a');
    const applied: string[] = [];
    if (guard.isCurrent(oldMutation, 'thread-a')) applied.push('mutation result');
    if (guard.isCurrent(websocketLoad, 'thread-a')) applied.push('load result');

    expect(applied).toEqual(['load result']);
  });
});
