import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload } from './helpers.js';
import { ToolCatalog } from '../src/executor/tools.js';
import { HostExecutor } from '../src/executor/executor.js';
import { ContainerExecutor } from '../src/executor/container-executor.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

describe('Executor execution identity and recovery', () => {
  it('treats concurrent and repeated Host Executor submissions with one ID as one execution', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    let invocationCount = 0;
    let release!: (value: unknown) => void;
    const wait = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'side_effect', description: 'count once', parameters: { type: 'object' } },
      execute: async () => {
        invocationCount += 1;
        return wait;
      },
    });
    const modelExecution = env.store.createModelExecution('prepare-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    env.store.commitModelStep({
      assistantRecordId: 'prepare-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({
        batchId: 'prepare-model:batch',
        toolCalls: [{ id: 'stable-call', name: 'side_effect', arguments: {} }],
      }),
      toolCalls: [
        { call: { id: 'stable-call', name: 'side_effect', arguments: {} }, executionId: 'stable-execution-id' },
      ],
    });
    const executor = new HostExecutor(env.store, catalog);
    const binding = env.store.executorForThread(thread.id)!;
    try {
      const one = executor.execute('stable-execution-id', binding);
      const two = executor.execute('stable-execution-id', binding);
      await until(() => invocationCount === 1);
      expect(invocationCount).toBe(1);
      release({ changed: true });
      const [first, second] = await Promise.all([one, two]);
      const retry = await executor.execute('stable-execution-id', binding);
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(retry.status).toBe('completed');
      expect(invocationCount).toBe(1);
    } finally {
      release({ cleanup: true });
      await env.cleanup();
    }
  });

  it('waits for active Host tool invocations to settle during shutdown', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'wait_for_abort', description: 'wait for shutdown', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        markStarted();
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              markAborted();
              setTimeout(() => reject(new DOMException('Execution interrupted', 'AbortError')), 30);
            },
            { once: true },
          );
        });
      },
    });
    const modelExecution = env.store.createModelExecution('shutdown-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    env.store.commitModelStep({
      assistantRecordId: 'shutdown-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({
        batchId: 'shutdown-model:batch',
        toolCalls: [{ id: 'shutdown-call', name: 'wait_for_abort', arguments: {} }],
      }),
      toolCalls: [
        { call: { id: 'shutdown-call', name: 'wait_for_abort', arguments: {} }, executionId: 'shutdown-execution' },
      ],
    });
    const executor = new HostExecutor(env.store, catalog);
    const binding = env.store.executorForThread(thread.id)!;
    try {
      const execution = executor.execute('shutdown-execution', binding);
      await started;
      let shutdownSettled = false;
      const shutdown = executor.shutdown().then(() => {
        shutdownSettled = true;
      });
      await aborted;
      expect(shutdownSettled).toBe(false);
      await shutdown;
      expect((await execution).status).toBe('interrupted');
      expect(shutdownSettled).toBe(true);
    } finally {
      await executor.shutdown();
      await env.cleanup();
    }
  });

  it('recovers durable work and interrupts a Host tool only after the Executor confirms it was lost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-recovery-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let store = new PicoStore(databasePath);
    const project = store.createProject('Recovery', workspace);
    const thread = store.createThread(project.id, 'host');
    const lostToolId = `${thread.id}:tool-model:lost-call`;
    const strandedModel = store.createModelExecution('stranded-model', thread.id, 0);
    store.transitionExecution(strandedModel.id, 'running');
    const preparingModel = store.createModelExecution('tool-model', thread.id, 0);
    store.transitionExecution(preparingModel.id, 'running');
    store.commitModelStep({
      assistantRecordId: 'tool-model:assistant',
      modelExecutionId: preparingModel.id,
      threadId: thread.id,
      payload: assistantPayload({
        batchId: 'tool-model:batch',
        toolCalls: [{ id: 'lost-call', name: 'read_file', arguments: { path: 'input.txt' } }],
      }),
      toolCalls: [
        { call: { id: 'lost-call', name: 'read_file', arguments: { path: 'input.txt' } }, executionId: lostToolId },
      ],
    });
    store.transitionExecution(lostToolId, 'running');
    store.createApproval(lostToolId);
    store.resolveApproval(lostToolId, true);
    store.close();

    store = new PicoStore(databasePath);
    const runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('unused')),
      pluginDirectory: join(directory, 'plugins'),
    });
    await runtime.initialize();
    try {
      await runtime.drain();
      expect(store.getExecution('stranded-model')?.status).toBe('interrupted');
      expect(store.getExecution(lostToolId)?.error).toMatch(/confirmed/i);
      expect(store.getExecution(lostToolId)?.status).toBe('interrupted');
      expect(
        store
          .listRecords(thread.id)
          .some((record) => record.kind === 'tool_result' && record.id === `${lostToolId}:result`),
      ).toBe(true);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('repairs a missing canonical Tool result from a completed durable execution after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-result-recovery-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'observed.txt'), 'captured before restart');
    const databasePath = join(directory, 'runtime.sqlite');
    const storeBeforeRestart = new PicoStore(databasePath);
    const project = storeBeforeRestart.createProject('Result recovery', workspace);
    const thread = storeBeforeRestart.createThread(project.id, 'host');
    const toolExecutionId = `${thread.id}:durable-step:durable-call`;
    const call = { id: 'durable-call', name: 'read_file', arguments: { path: 'observed.txt' } };
    const modelExecution = storeBeforeRestart.createModelExecution('durable-step', thread.id, 0);
    storeBeforeRestart.transitionExecution(modelExecution.id, 'running');
    storeBeforeRestart.commitModelStep({
      assistantRecordId: 'durable-step:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'durable-step:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: toolExecutionId }],
    });
    storeBeforeRestart.transitionExecution(toolExecutionId, 'running');
    storeBeforeRestart.transitionExecution(toolExecutionId, 'completed', {
      result: { path: 'observed.txt', contents: 'captured before restart', truncated: false },
    });
    expect(storeBeforeRestart.hasToolResult(toolExecutionId)).toBe(false);
    storeBeforeRestart.close();
    await writeFile(join(workspace, 'observed.txt'), 'changed after restart');

    let repeatedToolInvocations = 0;
    const model = new FakeModel(() => response('Recovered result acknowledged.'));
    const store = new PicoStore(databasePath);
    const runtime = new PicoRuntime(store, { model, pluginDirectory: join(directory, 'empty-plugins') });
    runtime.tools.replace({
      owner: 'recovery-test',
      source: 'executor',
      definition: { name: 'read_file', description: 'recovery spy', parameters: { type: 'object' } },
      execute: async () => {
        repeatedToolInvocations += 1;
        return { contents: 'changed after restart' };
      },
    });
    await runtime.initialize();
    try {
      await runtime.drain();
      const results = store
        .listRecords(thread.id)
        .filter((record) => record.kind === 'tool_result' && record.id === `${toolExecutionId}:result`);
      expect(results).toHaveLength(1);
      expect((results[0]?.payload as { result: unknown }).result).toEqual({
        path: 'observed.txt',
        contents: 'captured before restart',
        truncated: false,
      });
      expect(store.getExecution(toolExecutionId)?.status).toBe('completed');
      expect(repeatedToolInvocations).toBe(0);
      expect(model.calls).toBe(1);
      expect(model.prompts[0]?.turns.find((turn) => turn.kind === 'tool_result')?.content).toContain(
        'captured before restart',
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a Container tool running when Executor status is unreachable', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('offline-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    env.store.commitModelStep({
      assistantRecordId: 'offline-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({
        batchId: 'offline-model:batch',
        toolCalls: [{ id: 'offline-call', name: 'read_file', arguments: { path: 'input.txt' } }],
      }),
      toolCalls: [
        {
          call: { id: 'offline-call', name: 'read_file', arguments: { path: 'input.txt' } },
          executionId: 'offline-tool',
        },
      ],
    });
    env.store.transitionExecution('offline-tool', 'running');
    const disconnected = async () => {
      throw new Error('Cannot connect to Executor: connection refused');
    };
    const executor = new ContainerExecutor(env.store, new ToolCatalog(), undefined, undefined, disconnected);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await expect(executor.status('offline-tool', binding)).rejects.toThrow(/connection refused/);
      expect(env.store.getExecution('offline-tool')?.status).toBe('running');
      env.runtime.pause(thread.id);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(env.store.getExecution('offline-tool')?.status).toBe('running');
    } finally {
      await env.cleanup();
    }
  });

  it('Interrupt cancels Container Executor preparation before the tool starts', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('preparing-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const call = { id: 'preparing-call', name: 'shell', arguments: { command: 'true' } };
    env.store.commitModelStep({
      assistantRecordId: 'preparing-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'preparing-model:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'preparing-tool' }],
    });

    let markRunStarted!: () => void;
    let observedAbort = false;
    const runStarted = new Promise<void>((resolve) => {
      markRunStarted = resolve;
    });
    const calls: string[][] = [];
    const runner = async (args: string[], _input?: string, signal?: AbortSignal) => {
      calls.push(args);
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args[0] === 'inspect') throw new Error('no such container');
      if (args[0] === 'run') {
        markRunStarted();
        return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              setTimeout(() => reject(new DOMException('Execution interrupted', 'AbortError')), 5);
            },
            { once: true },
          );
        });
      }
      if (args[0] === 'rm') return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'shell', description: 'test shell', parameters: { type: 'object' } },
      execute: async () => ({ exitCode: 0 }),
    });
    const executor = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const execution = executor.execute('preparing-tool', binding);
      await runStarted;
      const interrupted = await executor.interrupt('preparing-tool', binding);
      expect(observedAbort).toBe(true);
      expect(interrupted?.status).toBe('interrupted');
      expect((await execution).status).toBe('interrupted');
      expect(env.store.getExecution('preparing-tool')?.status).toBe('interrupted');
      expect(calls.some((args) => args[0] === 'exec')).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('uses PICO_CONTAINER_IMAGE for Container Executor provisioning', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const previousImage = process.env.PICO_CONTAINER_IMAGE;
    process.env.PICO_CONTAINER_IMAGE = 'registry.example.test/pico/node:22';
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('image-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const call = { id: 'image-call', name: 'shell', arguments: { command: 'true' } };
    env.store.commitModelStep({
      assistantRecordId: 'image-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'image-model:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'image-tool' }],
    });

    let selectedImage: string | undefined;
    const runner = async (args: string[]) => {
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args[0] === 'inspect') throw new Error('no such container');
      if (args[0] === 'run') {
        selectedImage = args[args.indexOf('--workdir') + 2];
        return { stdout: 'container-id', stderr: '' };
      }
      if (args[0] === 'exec') {
        return {
          stdout: JSON.stringify({ status: 'completed', result: { exitCode: 0, stdout: 'ok', stderr: '' } }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'shell', description: 'test shell', parameters: { type: 'object' } },
      execute: async () => ({ exitCode: 0 }),
    });
    const executor = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const result = await executor.execute('image-tool', binding);
      expect(result.status).toBe('completed');
      expect(selectedImage).toBe('registry.example.test/pico/node:22');
    } finally {
      if (previousImage === undefined) delete process.env.PICO_CONTAINER_IMAGE;
      else process.env.PICO_CONTAINER_IMAGE = previousImage;
      await env.cleanup();
    }
  });

  it('retries Btrfs overlay storage with the discovered fuse-overlayfs helper', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (!args.includes('--storage-opt')) {
        throw new Error(
          'kernel does not support overlay fs: \'overlay\' is not supported over btrfs at "/storage/overlay"',
        );
      }
      return { stdout: '5.0.0', stderr: '' };
    };
    const executor = new ContainerExecutor(
      env.store,
      new ToolCatalog(),
      undefined,
      undefined,
      runner,
      '/usr/bin/fuse-overlayfs',
    );
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await executor.checkConnection(binding);
      await executor.checkConnection(binding);
      expect(calls).toEqual([
        ['info', '--format', '{{.Version.Version}}'],
        ['--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs', 'info', '--format', '{{.Version.Version}}'],
        ['--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs', 'info', '--format', '{{.Version.Version}}'],
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('uses an isolated persistent VFS store when no fuse-overlayfs helper is available', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (!args.includes('--storage-driver')) throw new Error("'overlay' is not supported over btrfs");
      return { stdout: '5.0.0', stderr: '' };
    };
    const vfsRoot = '/tmp/pico-test-vfs-root';
    const executor = new ContainerExecutor(env.store, new ToolCatalog(), undefined, undefined, runner, '', vfsRoot);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await executor.checkConnection(binding);
      await executor.checkConnection(binding);
      expect(calls).toEqual([
        ['info', '--format', '{{.Version.Version}}'],
        ['--root', vfsRoot, '--storage-driver', 'vfs', 'info', '--format', '{{.Version.Version}}'],
        ['--root', vfsRoot, '--storage-driver', 'vfs', 'info', '--format', '{{.Version.Version}}'],
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('preserves the Btrfs error when isolated VFS storage also fails', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const runner = async (args: string[]) => {
      if (args.includes('--storage-driver')) throw new Error('permission denied creating VFS storage');
      throw new Error("'overlay' is not supported over btrfs");
    };
    const executor = new ContainerExecutor(
      env.store,
      new ToolCatalog(),
      undefined,
      undefined,
      runner,
      '',
      '/tmp/pico-test-vfs-root',
    );
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await expect(executor.checkConnection(binding)).rejects.toThrow(
        /overlay.*not supported over btrfs[\s\S]*permission denied creating VFS storage/,
      );
    } finally {
      await env.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'Pause leaves a Host shell running; Interrupt waits for the process group to stop',
    async () => {
      const model = new FakeModel((_prompt, callNumber) =>
        callNumber === 1
          ? response('', [
              {
                id: 'shell-call',
                name: 'shell',
                arguments: { command: "trap '' TERM; while :; do sleep 0.05; done", timeout_ms: 20_000 },
              },
            ])
          : response('Stopped safely.'),
      );
      const env = await setupRuntime(model);
      const thread = env.createThread('host');
      env.runtime.setToolPermission(thread.id, 'shell', 'allow');
      try {
        await env.runtime.submit(thread.id, 'shell-control-message', 'Run a long task');
        await until(() =>
          env.store
            .listExecutions(thread.id)
            .some((execution) => execution.toolName === 'shell' && execution.status === 'running'),
        );
        const shell = env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'shell')!;
        env.runtime.pause(thread.id);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        expect(env.store.getExecution(shell.id)?.status).toBe('running');

        let interruptSettled = false;
        const interrupt = env.runtime.interrupt(thread.id).then(() => {
          interruptSettled = true;
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        expect(interruptSettled).toBe(false);
        expect(env.store.getExecution(shell.id)?.status).toBe('running');

        await interrupt;
        await env.runtime.drain();
        expect(env.store.getExecution(shell.id)?.status).toBe('interrupted');
        expect(env.store.hasToolResult(shell.id)).toBe(true);
        expect(model.calls).toBe(1);
      } finally {
        await env.cleanup();
      }
    },
  );
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
