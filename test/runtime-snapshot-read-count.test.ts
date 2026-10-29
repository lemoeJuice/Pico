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

    expect(snapshot?.records).toHaveLength(20);
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

  it('returns a bounded first page without materializing full history or inventing context usage', () => {
    store = new PicoStore(':memory:');
    const project = store.createProject('Initial snapshot project', '/workspace');
    const thread = store.createThread(project.id, 'runtime', 'Initial snapshot Thread');
    for (let index = 1; index <= 45; index += 1) {
      store.appendMessage(thread.id, `initial-${index}`, {
        role: 'user',
        source: 'user',
        content: `Message ${index}`,
      });
    }
    const listRecords = vi.spyOn(store, 'listRecords');
    const runtime = new PicoRuntime(store);

    const result = runtime.getInitialSnapshot(thread.id);

    expect(result?.mode).toBe('initial');
    if (result?.mode === 'initial') {
      expect(result.snapshot.records).toHaveLength(20);
      expect(result.snapshot.records[0]?.id).toBe('initial-26');
      expect(result.snapshot.contextUsage).toBeNull();
      expect(result.snapshot.projectionStatus).toBe('not_loaded');
    }
    expect(listRecords).not.toHaveBeenCalled();
  });

  it.each(['context-rewound', 'context-restored'])('uses the full projection for %s Threads', (action) => {
    store = new PicoStore(':memory:');
    const project = store.createProject('Branch fallback project', '/workspace');
    const thread = store.createThread(project.id, 'runtime', 'Branch Thread');
    store.appendMessage(thread.id, 'branch-message', { role: 'user', source: 'user', content: 'Recent' });
    store.appendCanonical(thread.id, 'branch-marker', 'plugin', {
      pluginId: 'pico.runtime',
      action,
      version: 1,
    } as never);
    const runtime = new PicoRuntime(store);
    const pageRead = vi.spyOn(store, 'listRecordPage');

    const result = runtime.getInitialSnapshot(thread.id);

    expect(result?.mode).toBe('complete');
    if (result?.mode === 'complete') {
      expect(result.snapshot).toHaveProperty('contextUsage');
      expect(result.snapshot).not.toHaveProperty('projectionStatus');
    }
    expect(pageRead).toHaveBeenLastCalledWith(thread.id, undefined, 20, false);
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
