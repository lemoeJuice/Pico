import { describe, expect, it } from 'vitest';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';

describe('Runtime model draft recovery', () => {
  it('publishes UTF-16 offsets and serves an active draft until the execution settles', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const model = new FakeModel(async (_prompt, _call, _signal, onText) => {
      onText('A😀');
      started.resolve();
      await finish.promise;
      return response('complete');
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = env.runtime.subscribe((event) => events.push(event));
    try {
      await env.runtime.submit(thread.id, 'draft-read-message', 'Write');
      await started.promise;
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toBeDefined();
      expect(events.find((event) => event.type === 'model.delta')).toMatchObject({ delta: 'A😀', offset: 0 });
      expect(env.runtime.readModelDraft('wrong-thread', execution!.id, 0)).toEqual({ status: 'unavailable' });
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 1)).toMatchObject({
        status: 'available',
        text: '😀',
        fromOffset: 1,
        nextOffset: 3,
      });

      finish.resolve();
      await env.runtime.drain();
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0)).toEqual({ status: 'unavailable' });
    } finally {
      finish.resolve();
      unsubscribe();
      await env.cleanup();
    }
  });

  it('makes an interrupted draft unavailable immediately', async () => {
    const started = deferred<void>();
    const model = new FakeModel((_prompt, _call, signal, onText) => {
      onText('partial');
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'draft-interrupt-message', 'Write');
      await started.promise;
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toBeDefined();
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0).status).toBe('available');

      await env.runtime.interrupt(thread.id);
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0)).toEqual({ status: 'unavailable' });
    } finally {
      await env.cleanup();
    }
  });

  it('releases failed drafts after preserving only the durable failure outcome', async () => {
    const model = new FakeModel((_prompt, _call, _signal, onText) => {
      onText('partial failure');
      throw new Error('provider disconnected');
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'draft-failure-message', 'Write');
      await env.runtime.drain();
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution?.status).toBe('failed');
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0)).toEqual({ status: 'unavailable' });
    } finally {
      await env.cleanup();
    }
  });

  it('clears active draft buffers as Runtime shutdown begins', async () => {
    const started = deferred<void>();
    const model = new FakeModel((_prompt, _call, signal, onText) => {
      onText('shutdown draft');
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'draft-shutdown-message', 'Write');
      await started.promise;
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'model');
      expect(execution).toBeDefined();
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0).status).toBe('available');

      await env.runtime.shutdown();
      expect(env.runtime.readModelDraft(thread.id, execution!.id, 0)).toEqual({ status: 'unavailable' });
    } finally {
      await env.cleanup();
    }
  });
});
