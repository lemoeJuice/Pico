import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PicoStore } from '../../../core/store.js';
import { collaborationPlugin } from '../../../plugins/collaboration.js';
import { PicoRuntime } from '../../../runtime/runtime.js';
import { FakeModel, response, setupTestCatalog } from '../../../../test/helpers.js';

describe('collaboration Runtime persistence', () => {
  it('uses target executor tool defaults when a child crosses executor types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-collaboration-executor-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const store = new PicoStore(join(directory, 'runtime.sqlite'));
    const runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('Executor selection is complete.')),
      plugins: [collaborationPlugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });

    try {
      await runtime.initialize();
      const project = await runtime.createProject('Executor selection', workspace);
      const parent = runtime.createThread(project.id, 'runtime', 'Parent');
      await runtime.setThreadToolEnabled(parent.id, 'spawn_thread', false);
      const spawn = runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const result = (await spawn.execute(
        { prompt: 'Use the Container executor', executor: 'container' },
        {
          thread: parent,
          executionId: 'container-child-spawn',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string; executor: string };
      const child = runtime.getThread(result.threadId);

      expect(child?.executorKind).toBe('container');
      expect(result.executor).toContain('Container');
      expect((await runtime.listThreadTools(parent.id)).find((tool) => tool.name === 'spawn_thread')?.enabled).toBe(
        false,
      );
      expect((await runtime.listThreadTools(child!.id)).find((tool) => tool.name === 'spawn_thread')?.enabled).toBe(
        true,
      );
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      const catalog = await setupTestCatalog(runtime, ['parent-model-v1', 'parent-model-v2']);
      const originalSelection = runtime.updateThreadModelSelection(parent.id, {
        ...catalog.select('parent-model-v1'),
        parameters: { temperature: 0.4, options: {} },
      });

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
      const reloadedCatalog = await setupTestCatalog(runtime, ['parent-model-v1', 'parent-model-v2']);
      const updatedParentSelection = runtime.updateThreadModelSelection(parent.id, {
        ...reloadedCatalog.select('parent-model-v2'),
        parameters: { temperature: 0.1, options: {} },
      });

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
