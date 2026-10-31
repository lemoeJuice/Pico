import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PicoStore } from '../../../core/store.js';
import { collaborationPlugin } from '../../../plugins/collaboration.js';
import { PicoRuntime } from '../../../runtime/runtime.js';
import { FakeModel, response, setupTestCatalog } from '../../../../test/helpers.js';

describe('collaboration Runtime persistence', () => {
  it('inherits a Container parent Executor by default for a child Thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-collaboration-container-inherit-'));
    const store = new PicoStore(join(directory, 'runtime.sqlite'));
    const runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('Container inheritance is complete.')),
      plugins: [collaborationPlugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });

    try {
      await runtime.initialize();
      const parent = runtime.createIndependentThread('container', 'Container parent');
      const spawn = runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const result = (await spawn.execute(
        { prompt: 'Continue in the inherited Container' },
        {
          thread: parent,
          executionId: 'container-inherit-child',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const child = runtime.getThread(result.threadId);

      expect(child).toMatchObject({
        executorKind: 'container',
        executorId: parent.executorId,
        projectId: parent.projectId,
        parentThreadId: parent.id,
      });
      expect(store.executorForThread(child!.id)?.id).toBe(store.executorForThread(parent.id)?.id);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates an independent Container Executor for an explicit Container child and applies its tool override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-collaboration-container-explicit-'));
    const store = new PicoStore(join(directory, 'runtime.sqlite'));
    const runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('Explicit Container selection is complete.')),
      plugins: [collaborationPlugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });

    try {
      await runtime.initialize();
      const parent = runtime.createIndependentThread('container', 'Container parent');
      await runtime.setThreadToolEnabled(parent.id, 'spawn_thread', false);
      const spawn = runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const result = (await spawn.execute(
        {
          prompt: 'Use a separate Container Executor',
          executor: 'container',
          tool_settings: [{ name: 'spawn_thread', enabled: true }],
        },
        {
          thread: parent,
          executionId: 'container-explicit-child',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const child = runtime.getThread(result.threadId);

      expect(child).toMatchObject({
        executorKind: 'container',
        projectId: parent.projectId,
        parentThreadId: parent.id,
      });
      expect(child?.executorId).not.toBe(parent.executorId);
      expect(store.executorForThread(child!.id)?.id).not.toBe(store.executorForThread(parent.id)?.id);
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

  it('inherits the same Container Executor through a grandchild Thread by default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-collaboration-container-grandchild-'));
    const store = new PicoStore(join(directory, 'runtime.sqlite'));
    const runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('Container inheritance is complete.')),
      plugins: [collaborationPlugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });

    try {
      await runtime.initialize();
      const parent = runtime.createIndependentThread('container', 'Container root');
      const spawn = runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const childResult = (await spawn.execute(
        { prompt: 'Continue in the inherited Container', title: 'Container child' },
        {
          thread: parent,
          executionId: 'container-grandchild-child',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const child = runtime.getThread(childResult.threadId)!;
      const grandchildResult = (await spawn.execute(
        { prompt: 'Continue in the inherited Container', title: 'Container grandchild' },
        {
          thread: child,
          executionId: 'container-grandchild-grandchild',
          workspacePath: child.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const grandchild = runtime.getThread(grandchildResult.threadId);

      expect(child.parentThreadId).toBe(parent.id);
      expect(grandchild).toMatchObject({
        executorKind: 'container',
        executorId: parent.executorId,
        parentThreadId: child.id,
        projectId: parent.projectId,
      });
      expect(store.executorForThread(grandchild!.id)?.id).toBe(store.executorForThread(parent.id)?.id);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
