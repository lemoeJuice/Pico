import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PicoStore } from '../src/core/store.js';
import type { ThreadModelSelection } from '../src/core/types.js';
import { collaborationPlugin } from '../src/plugins/collaboration.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response } from './helpers.js';

describe('collaboration Runtime persistence', () => {
  it('reuses the persisted child and its selection when a spawn is redelivered after view reconstruction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-collaboration-restart-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    const model = new FakeModel(() => response('No provider request is needed for spawn recovery.'));
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model,
      plugins: [collaborationPlugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });

    try {
      await runtime.initialize();
      const project = await runtime.createProject('Spawn recovery', workspace);
      const parent = runtime.createThread(project.id, 'runtime', 'Parent');
      const originalSelection: ThreadModelSelection = {
        provider: 'openai-compatible',
        connectionId: 'default',
        model: 'parent-model-v1',
        parameters: { temperature: 0.4, options: {} },
      };
      runtime.updateThreadModelSelection(parent.id, originalSelection);

      const firstTool = runtime.tools.get('spawn_thread');
      if (!firstTool) throw new Error('spawn_thread was not registered');
      const first = (await firstTool.execute(
        { prompt: 'Inspect the durable child boundary', title: 'Durable child' },
        {
          thread: parent,
          executionId: 'stable-spawn-execution',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string; initialMessageDelivered: boolean };
      expect(first.initialMessageDelivered).toBe(true);
      expect(runtime.threadModelSelection(first.threadId)).toEqual(originalSelection);
      await runtime.drain();
      await runtime.shutdown();
      store.close();

      store = new PicoStore(databasePath);
      store.rebuildWorkflowViews();
      runtime = new PicoRuntime(store, {
        model,
        plugins: [collaborationPlugin],
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      const updatedParentSelection: ThreadModelSelection = {
        ...originalSelection,
        model: 'parent-model-v2',
        parameters: { temperature: 0.1, options: {} },
      };
      runtime.updateThreadModelSelection(parent.id, updatedParentSelection);

      const retryTool = runtime.tools.get('spawn_thread');
      if (!retryTool) throw new Error('spawn_thread was not registered after restart');
      const retry = (await retryTool.execute(
        { prompt: 'Inspect the durable child boundary', title: 'Durable child' },
        {
          thread: runtime.getThread(parent.id)!,
          executionId: 'stable-spawn-execution',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string; initialMessageDelivered: boolean };
      await runtime.drain();

      expect(retry.threadId).toBe(first.threadId);
      expect(retry.initialMessageDelivered).toBe(false);
      expect(runtime.listThreads(project.id).filter((thread) => thread.parentThreadId === parent.id)).toHaveLength(1);
      expect(runtime.threadModelSelection(retry.threadId)).toEqual(originalSelection);
      expect(runtime.threadModelSelection(parent.id)).toEqual(updatedParentSelection);
      expect(store.listRecords(retry.threadId).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(model.calls).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
