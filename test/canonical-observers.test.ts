import { describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import { createToolCatalog } from '../src/executor/tools.js';
import { CommandRegistry, PluginHost } from '../src/plugins/host.js';

function setup() {
  const store = new PicoStore(':memory:');
  const project = store.createProject('Logger', '/tmp');
  const thread = store.createThread(project.id, 'host', 'Facts');
  return { store, thread };
}

describe('committed canonical observations', () => {
  it('publishes only committed records and discards rolled-back savepoints', () => {
    const { store, thread } = setup();
    const received: string[] = [];
    store.subscribeCanonical((record) => received.push(record.id));
    store.transaction(() => {
      store.appendMessage(thread.id, 'first', { role: 'user', source: 'user', content: 'First' });
      expect(received).toEqual([]);
      expect(() =>
        store.transaction(() => {
          store.appendPluginRecord(thread.id, 'example', { action: 'discarded' }, 'discarded');
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      store.appendPluginRecord(thread.id, 'example', { action: 'kept' }, 'kept');
    });
    expect(received).toEqual(['first', 'kept']);
    expect(store.readCanonical(thread.id, 1, 1).map((record) => record.id)).toEqual(['kept']);
    store.appendMessage(thread.id, 'first', { role: 'user', source: 'user', content: 'First' });
    expect(received).toHaveLength(2);
    store.close();
  });

  it('isolates observers from stored facts and other observers', () => {
    const { store, thread } = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const received: string[] = [];
    store.subscribeCanonical((record) => {
      record.payload.content = 'mutated';
      throw new Error('observer');
    });
    store.subscribeCanonical((record) => received.push(String(record.payload.content)));
    store.appendMessage(thread.id, 'message', { role: 'user', source: 'user', content: 'original' });
    expect(received).toEqual(['original']);
    expect(store.readCanonical(thread.id)[0]?.payload.content).toBe('original');
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    store.close();
  });

  it('exposes all fact kinds to plugins and disposes subscriptions on shutdown', async () => {
    const { store, thread } = setup();
    const host = new PluginHost(
      store,
      createToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      '/tmp/no-pico-plugins',
    );
    const observed: string[] = [];
    let read: (() => string[]) | undefined;
    await host.load([
      {
        id: 'example.reader',
        name: 'Reader',
        version: '1',
        activate(context) {
          context.canonical.subscribe(thread.id, (record) => observed.push(record.id));
          read = () => context.canonical.read(thread.id).map((record) => record.kind);
        },
      },
    ]);
    store.appendMessage(thread.id, 'user', { role: 'user', source: 'user', content: 'Hello' });
    store.appendPluginRecord(thread.id, 'other.plugin', { action: 'event' }, 'other');
    expect(read?.()).toEqual(['message', 'plugin']);
    await host.shutdown();
    store.appendMessage(thread.id, 'after', { role: 'user', source: 'user', content: 'After' });
    expect(observed).toEqual(['user', 'other']);
    store.close();
  });
});
