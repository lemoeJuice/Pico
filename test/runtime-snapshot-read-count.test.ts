import { afterEach, describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';

describe('Runtime snapshot canonical reads', () => {
  let store: PicoStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('reuses full-history analysis while paging an unchanged Thread', () => {
    store = new PicoStore(':memory:');
    const project = store.createProject('Read count project', '/workspace');
    const thread = store.createThread(project.id, 'runtime', 'Read count Thread');
    for (let index = 1; index <= 120; index += 1) {
      store.appendMessage(thread.id, `message-${index}`, {
        role: 'user',
        source: 'user',
        content: `Message ${index}`,
      });
    }
    const listRecords = vi.spyOn(store, 'listRecords');
    const runtime = new PicoRuntime(store);

    const snapshot = runtime.getSnapshot(thread.id);
    const earlier = runtime.getSnapshot(thread.id, snapshot!.records[0]!.seq);

    expect(snapshot?.records).toHaveLength(100);
    expect(snapshot?.hasEarlierRecords).toBe(true);
    expect(earlier?.records).toHaveLength(20);
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(listRecords).toHaveBeenCalledWith(thread.id);

    store.appendMessage(thread.id, 'new-message', {
      role: 'user',
      source: 'user',
      content: 'New message invalidates cached history analysis',
    });
    runtime.getSnapshot(thread.id);
    expect(listRecords).toHaveBeenCalledTimes(2);
  });

  it('recomputes context usage when a child Thread parent changes', () => {
    store = new PicoStore(':memory:');
    const project = store.createProject('Parent key project', '/workspace');
    const parent = store.createThread(project.id, 'runtime', 'Parent');
    const otherParent = store.createThread(project.id, 'runtime', 'Other parent');
    const child = store.createThread(project.id, 'runtime', 'Child', { parentThreadId: parent.id });
    store.appendMessage(child.id, 'child-message', {
      role: 'user',
      source: 'child',
      senderThreadId: parent.id,
      content: 'A message from the parent',
    });
    const runtime = new PicoRuntime(store);

    const withParent = runtime.getSnapshot(child.id)?.contextUsage;
    store.db.prepare('UPDATE threads SET parent_thread_id = ? WHERE id = ?').run(otherParent.id, child.id);
    const withOtherParent = runtime.getSnapshot(child.id)?.contextUsage;

    expect(withParent).not.toEqual(withOtherParent);
  });

  it('does not retain a single history above the per-Thread cache budget', () => {
    store = new PicoStore(':memory:');
    const project = store.createProject('Cache budget project', '/workspace');
    const thread = store.createThread(project.id, 'runtime', 'Large Thread');
    store.appendMessage(thread.id, 'large-message', {
      role: 'user',
      source: 'user',
      content: 'x'.repeat(2_200_000),
    });
    const listRecords = vi.spyOn(store, 'listRecords');
    const runtime = new PicoRuntime(store);

    runtime.getSnapshot(thread.id);
    runtime.getSnapshot(thread.id);

    expect(listRecords).toHaveBeenCalledTimes(2);
  });
});
