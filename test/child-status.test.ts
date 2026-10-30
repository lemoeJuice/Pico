import { describe, expect, it } from 'vitest';
import { collaborationPlugin } from '../src/plugins/collaboration.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

describe('child Thread status', () => {
  it('persists a model failure, queues one notice for a paused parent, and clears the state on continue', async () => {
    let fail = true;
    const env = await setupRuntime(
      new FakeModel(() => {
        if (fail) throw new Error('synthetic model failure');
        return response('Finished.');
      }),
      { plugins: [collaborationPlugin] },
    );
    try {
      const parent = env.createThread('runtime', 'Parent');
      env.runtime.pause(parent.id);
      const spawn = env.runtime.tools.get('spawn_thread')!;
      const child = (await spawn.execute(
        { prompt: 'Do work' },
        {
          thread: parent,
          executionId: 'status-child',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      await env.runtime.drain();
      expect(env.runtime.getThread(child.threadId)?.state).toBe('model_error');
      expect(env.runtime.getThread(parent.id)?.state).toBe('paused');
      expect(
        env.store
          .listRecords(parent.id)
          .filter((record) => record.kind === 'message' && String(record.id).includes('child-status:model-error:')),
      ).toHaveLength(1);
      env.store.rebuildWorkflowViews();
      expect(env.runtime.getThread(child.threadId)?.state).toBe('model_error');
      fail = false;
      env.runtime.continue(child.threadId);
      await env.runtime.drain();
      expect(env.runtime.getThread(child.threadId)?.state).toBe('idle');
      expect(env.runtime.getThread(child.threadId)?.pauseCode).toBeNull();
    } finally {
      await env.cleanup();
    }
  });
});
