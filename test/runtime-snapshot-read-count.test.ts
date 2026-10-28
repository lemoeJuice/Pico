import { afterEach, describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';

describe('Runtime snapshot canonical reads', () => {
  let store: PicoStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('uses one full canonical read while building a paged snapshot', () => {
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

    expect(snapshot?.records).toHaveLength(100);
    expect(snapshot?.hasEarlierRecords).toBe(true);
    expect(listRecords).toHaveBeenCalledTimes(1);
    expect(listRecords).toHaveBeenCalledWith(thread.id);
  });
});
