import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTAINER_RUNNER } from '../src/executor/container-runner.js';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload } from './helpers.js';
import { ToolCatalog } from '../src/executor/tools.js';
import { HostExecutor } from '../src/executor/executor.js';
import { ContainerExecutor } from '../src/executor/container-executor.js';
import { READ_FILE_LIMITS, SEARCH_FILE_LIMITS } from '../src/executor/tool-limits.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

describe('Executor execution identity and recovery', () => {
  it('applies the same bounded file and search output in the Container Runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-container-tool-limits-'));
    const executionDirectory = join(directory, 'executions');
    const workspace = join(directory, 'workspace');
    await mkdir(executionDirectory);
    await mkdir(workspace);
    const longLines = Array.from({ length: 30 }, () => `needle ${'x'.repeat(2_500)}`).join('\n');
    await writeFile(join(workspace, 'long-lines.txt'), longLines, 'utf8');
    await writeFile(join(workspace, 'oversized.txt'), `needle ${'z'.repeat(SEARCH_FILE_LIMITS.maxFileBytes)}`, 'utf8');
    try {
      const read = await executeRunner(
        'run',
        randomUUID().replaceAll('-', ''),
        'read_file',
        executionDirectory,
        workspace,
        JSON.stringify({ path: 'long-lines.txt' }),
      );
      expect(read.status).toBe('completed');
      expect(read.result).toMatchObject({
        contents: expect.stringMatching(/^needle /),
        truncated: true,
      });
      expect((read.result as { contents: string }).contents).toHaveLength(READ_FILE_LIMITS.maxCharacters);

      const search = await executeRunner(
        'run',
        randomUUID().replaceAll('-', ''),
        'search_files',
        executionDirectory,
        workspace,
        JSON.stringify({ pattern: 'needle' }),
      );
      expect(search.status).toBe('completed');
      const result = search.result as { matches: string[]; truncated: boolean };
      expect(result.matches.join('\n').length).toBeLessThanOrEqual(SEARCH_FILE_LIMITS.maxOutputCharacters);
      expect(result.matches.length).toBeLessThan(30);
      expect(result.matches[0]).toContain('[line truncated]');
      expect(result.truncated).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps Container file tools inside the selected workspace through symlinks',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-container-path-guard-'));
      const executionDirectory = join(directory, 'executions');
      const workspace = join(directory, 'workspace');
      const outside = join(directory, 'outside');
      await mkdir(executionDirectory);
      await mkdir(workspace);
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 'outside secret', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'));
      await symlink(outside, join(workspace, 'escape-dir'));
      const missingOutside = join(outside, 'not-created');
      await symlink(missingOutside, join(workspace, 'dangling-dir'));
      await writeFile(join(workspace, 'inside.txt'), 'inside workspace', 'utf8');
      await symlink(join(workspace, 'inside.txt'), join(workspace, 'inside-link.txt'));

      try {
        const blockedRead = await executeRunner(
          'run',
          randomUUID().replaceAll('-', ''),
          'read_file',
          executionDirectory,
          workspace,
          JSON.stringify({ path: 'escape.txt' }),
        );
        expect(blockedRead.status).toBe('failed');
        expect(blockedRead.error).toMatch(/outside the workspace/);

        const patch = ['*** Begin Patch', '*** Add File: escape-dir/new.txt', '+must not escape', '*** End Patch'].join(
          '\n',
        );
        const blockedPatch = await executeRunner(
          'run',
          randomUUID().replaceAll('-', ''),
          'apply_patch',
          executionDirectory,
          workspace,
          JSON.stringify({ patch }),
        );
        expect(blockedPatch.status).toBe('failed');
        expect(blockedPatch.error).toMatch(/outside the workspace/);
        await expect(readFile(join(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        const danglingPatch = [
          '*** Begin Patch',
          '*** Add File: dangling-dir/new.txt',
          '+must not escape',
          '*** End Patch',
        ].join('\n');
        const blockedDanglingPatch = await executeRunner(
          'run',
          randomUUID().replaceAll('-', ''),
          'apply_patch',
          executionDirectory,
          workspace,
          JSON.stringify({ patch: danglingPatch }),
        );
        expect(blockedDanglingPatch.status).toBe('failed');
        expect(blockedDanglingPatch.error).toMatch(/outside the workspace/);
        await expect(readFile(join(missingOutside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        const allowedRead = await executeRunner(
          'run',
          randomUUID().replaceAll('-', ''),
          'read_file',
          executionDirectory,
          workspace,
          JSON.stringify({ path: 'inside-link.txt' }),
        );
        expect(allowedRead).toMatchObject({ status: 'completed', result: { contents: 'inside workspace' } });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'deduplicates container runner submissions and returns a completed result to a racing Interrupt',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-container-runner-'));
      const executionDirectory = join(directory, 'executions');
      const workspace = join(directory, 'workspace');
      await mkdir(executionDirectory);
      await mkdir(workspace);
      const key = randomUUID().replaceAll('-', '');
      const firstPatch = ['*** Begin Patch', '*** Add File: original.txt', '+first submission', '*** End Patch'].join(
        '\n',
      );
      const duplicatePatch = [
        '*** Begin Patch',
        '*** Add File: duplicate.txt',
        '+duplicate side effect',
        '*** End Patch',
      ].join('\n');
      const pidFile = join(executionDirectory, `${key}.pid`);
      const command = spawn(
        process.execPath,
        ['-e', CONTAINER_RUNNER, 'run', key, 'apply_patch', executionDirectory, workspace],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const commandResult = captureRunner(command);
      try {
        await waitForFile(pidFile);
        const duplicate = await executeRunner(
          'run',
          key,
          'apply_patch',
          executionDirectory,
          workspace,
          JSON.stringify({ patch: duplicatePatch }),
        );
        expect(duplicate.status).toBe('running');
        expect((await executeRunner('status', key, undefined, executionDirectory, workspace)).status).toBe('running');

        command.stdin!.end(JSON.stringify({ patch: firstPatch }));
        const completed = await commandResult;
        expect(completed).toMatchObject({ status: 'completed', result: { changed: ['original.txt'] } });
        expect(await readFile(join(workspace, 'original.txt'), 'utf8')).toBe('first submission\n');
        await expect(readFile(join(workspace, 'duplicate.txt'), 'utf8')).rejects.toThrow();
        expect(await executeRunner('interrupt', key, undefined, executionDirectory, workspace)).toEqual(completed);
      } finally {
        if (command.exitCode === null) {
          command.stdin!.end(JSON.stringify({ patch: firstPatch }));
          await commandResult.catch(() => undefined);
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'does not treat a reused process ID as a live container execution',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-container-stale-pid-'));
      const executionDirectory = join(directory, 'executions');
      const workspace = join(directory, 'workspace');
      await mkdir(executionDirectory);
      await mkdir(workspace);
      const key = randomUUID().replaceAll('-', '');
      try {
        await writeFile(join(executionDirectory, `${key}.pid`), String(process.pid));
        expect((await executeRunner('status', key, undefined, executionDirectory, workspace)).status).toBe(
          'interrupted',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'interrupts a Container shell process group and records its terminal state',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-container-interrupt-'));
      const executionDirectory = join(directory, 'executions');
      const workspace = join(directory, 'workspace');
      await mkdir(executionDirectory);
      await mkdir(workspace);
      const key = randomUUID().replaceAll('-', '');
      const childPidFile = join(executionDirectory, `${key}.child.pid`);
      const command = spawn(
        process.execPath,
        ['-e', CONTAINER_RUNNER, 'run', key, 'shell', executionDirectory, workspace],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const commandResult = captureRunner(command);
      command.stdin!.end(JSON.stringify({ command: 'sleep 10', timeout_ms: 20_000 }));
      try {
        await waitForFile(childPidFile);
        const interrupt = await executeRunner('interrupt', key, undefined, executionDirectory, workspace);
        expect(['running', 'interrupted']).toContain(interrupt.status);
        const completed = await withTimeout(commandResult, 3_000);
        expect(completed.status).toBe('interrupted');
        expect((await executeRunner('status', key, undefined, executionDirectory, workspace)).status).toBe(
          'interrupted',
        );
      } finally {
        const childPid = Number(await readFile(childPidFile, 'utf8').catch(() => ''));
        if (Number.isSafeInteger(childPid) && childPid > 0) {
          try {
            process.kill(-childPid, 'SIGKILL');
          } catch {
            try {
              process.kill(childPid, 'SIGKILL');
            } catch {
              /* The shell process group already exited. */
            }
          }
        }
        if (command.exitCode === null && !command.stdin!.writableEnded) {
          command.stdin!.end(JSON.stringify({ command: 'sleep 10', timeout_ms: 20_000 }));
        }
        await commandResult.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps a detached shell running and interruptible after its Container Runner exits',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pico-container-orphan-'));
      const executionDirectory = join(directory, 'executions');
      const workspace = join(directory, 'workspace');
      await mkdir(executionDirectory);
      await mkdir(workspace);
      const key = randomUUID().replaceAll('-', '');
      const childPidFile = join(executionDirectory, `${key}.child.pid`);
      const command = spawn(
        process.execPath,
        ['-e', CONTAINER_RUNNER, 'run', key, 'shell', executionDirectory, workspace],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const commandResult = captureRunner(command);
      command.stdin!.end(JSON.stringify({ command: 'sleep 20; printf completed > completed.txt', timeout_ms: 30_000 }));
      let childPid = 0;
      let childStartTime: string | undefined;
      try {
        await waitForFile(childPidFile);
        const identity = JSON.parse(await readFile(childPidFile, 'utf8')) as { pid: number; startTime?: string };
        childPid = identity.pid;
        childStartTime = identity.startTime;
        command.kill('SIGKILL');
        await commandResult.catch(() => undefined);

        expect((await executeRunner('status', key, undefined, executionDirectory, workspace)).status).toBe('running');
        await executeRunner('interrupt', key, undefined, executionDirectory, workspace);
        await waitForRunnerStatus(key, executionDirectory, workspace, 'interrupted');
        await expect(readFile(join(workspace, 'completed.txt'), 'utf8')).rejects.toThrow();
      } finally {
        if (command.exitCode === null) {
          command.kill('SIGKILL');
          await commandResult.catch(() => undefined);
        }
        if (childPid > 0 && processGroupMatches(childPid, childStartTime)) {
          try {
            process.kill(-childPid, 'SIGKILL');
          } catch {
            /* The detached shell process group already exited. */
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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

  it('keeps a Container tool running after a lost submission response until missing state is confirmed', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('lost-ack-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const call = { id: 'lost-ack-call', name: 'read_file', arguments: { path: 'input.txt' } };
    env.store.commitModelStep({
      assistantRecordId: 'lost-ack-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'lost-ack-model:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'lost-ack-tool' }],
    });

    let containerPresent = false;
    const runner = async (args: string[]) => {
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args[0] === 'inspect') {
        if (containerPresent) return { stdout: '{}', stderr: '' };
        throw new Error('no such container');
      }
      if (args[0] === 'run') {
        containerPresent = true;
        return { stdout: 'container-id', stderr: '' };
      }
      if (args[0] === 'start') return { stdout: 'container-id', stderr: '' };
      if (args[0] === 'exec') {
        const mode = args[args.indexOf('-e') + 2];
        if (mode === 'run') throw new Error('unexpected EOF while reading Podman response');
        if (mode === 'status') return { stdout: JSON.stringify({ status: 'running' }), stderr: '' };
      }
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'read_file', description: 'test read', parameters: { type: 'object' } },
      execute: async () => ({ contents: 'unused' }),
    });
    const executor = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      expect((await executor.execute('lost-ack-tool', binding)).status).toBe('running');
      expect((await executor.status('lost-ack-tool', binding))?.status).toBe('running');

      containerPresent = false;
      const confirmedLost = await executor.status('lost-ack-tool', binding);
      expect(confirmedLost?.status).toBe('interrupted');
      expect(confirmedLost?.error).toMatch(/confirmed.*no longer exists/i);
    } finally {
      await env.cleanup();
    }
  });

  it('detaches Container polling on Runtime shutdown and resumes the same execution after restart', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('shutdown-container-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const call = { id: 'shutdown-container-call', name: 'read_file', arguments: { path: 'input.txt' } };
    env.store.commitModelStep({
      assistantRecordId: 'shutdown-container-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'shutdown-container-model:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'shutdown-container-tool' }],
    });

    let containerPresent = false;
    let runnerStatus: 'running' | 'completed' = 'running';
    let submissions = 0;
    let markStatusRequestStarted!: () => void;
    const statusRequestStarted = new Promise<void>((resolve) => {
      markStatusRequestStarted = resolve;
    });
    const runner = async (args: string[], _input?: string, signal?: AbortSignal) => {
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args[0] === 'inspect') {
        if (containerPresent) return { stdout: '{}', stderr: '' };
        throw new Error('no such container');
      }
      if (args[0] === 'run') {
        containerPresent = true;
        return { stdout: 'container-id', stderr: '' };
      }
      if (args[0] === 'start') return { stdout: 'container-id', stderr: '' };
      if (args[0] === 'exec') {
        const mode = args[args.indexOf('-e') + 2];
        if (mode === 'run') {
          submissions += 1;
          return { stdout: JSON.stringify({ status: 'running' }), stderr: '' };
        }
        if (mode === 'status' && runnerStatus === 'completed') {
          return { stdout: JSON.stringify({ status: 'completed', result: { contents: 'recovered' } }), stderr: '' };
        }
        if (mode === 'status') {
          markStatusRequestStarted();
          return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Detached local status request', 'AbortError')),
              { once: true },
            );
          });
        }
      }
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'read_file', description: 'test read', parameters: { type: 'object' } },
      execute: async () => ({ contents: 'unused' }),
    });
    const binding = env.store.executorForThread(thread.id)!;
    const beforeRestart = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
    const executionPromise = beforeRestart.execute('shutdown-container-tool', binding);
    try {
      await statusRequestStarted;
      await beforeRestart.shutdown();
      expect((await executionPromise).status).toBe('running');
      expect(env.store.getExecution('shutdown-container-tool')?.status).toBe('running');

      runnerStatus = 'completed';
      const afterRestart = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
      try {
        const resumed = await afterRestart.execute('shutdown-container-tool', binding);
        expect(resumed).toMatchObject({ status: 'completed', result: { contents: 'recovered' } });
        expect(submissions).toBe(1);
      } finally {
        await afterRestart.shutdown();
      }
    } finally {
      await beforeRestart.shutdown();
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

  it('starts shared Container Batch tools in parallel after provisioning one Thread container', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('container-batch-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const calls = [
      { id: 'container-read-call', name: 'read_file', arguments: { path: 'a.txt' } },
      { id: 'container-search-call', name: 'search_files', arguments: { pattern: 'marker' } },
    ];
    env.store.commitModelStep({
      assistantRecordId: 'container-batch-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'container-batch-model:batch', toolCalls: calls }),
      toolCalls: [
        { call: calls[0]!, executionId: 'container-read-execution' },
        { call: calls[1]!, executionId: 'container-search-execution' },
      ],
    });

    let containerCreated = false;
    let containerStarts = 0;
    let activeToolCalls = 0;
    let maxConcurrentToolCalls = 0;
    const startedToolCalls: string[] = [];
    let releaseTools!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    const runner = async (args: string[]) => {
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args[0] === 'inspect') {
        if (containerCreated) return { stdout: '{}', stderr: '' };
        throw new Error('no such container');
      }
      if (args[0] === 'run') {
        if (containerCreated) throw new Error('container name is already in use');
        containerCreated = true;
        containerStarts += 1;
        return { stdout: 'container-id', stderr: '' };
      }
      if (args[0] === 'start') return { stdout: 'container-id', stderr: '' };
      if (args[0] === 'exec') {
        const toolName = args.at(-1) ?? 'unknown';
        startedToolCalls.push(toolName);
        activeToolCalls += 1;
        maxConcurrentToolCalls = Math.max(maxConcurrentToolCalls, activeToolCalls);
        await toolGate;
        activeToolCalls -= 1;
        return { stdout: JSON.stringify({ status: 'completed', result: { toolName } }), stderr: '' };
      }
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    for (const name of ['read_file', 'search_files']) {
      catalog.register({
        owner: 'test',
        source: 'executor',
        definition: { name, description: `test ${name}`, parameters: { type: 'object' } },
        execute: async () => ({ ok: true }),
      });
    }
    const executor = new ContainerExecutor(env.store, catalog, undefined, undefined, runner);
    const binding = env.store.executorForThread(thread.id)!;
    let executions: Promise<PromiseSettledResult<Awaited<ReturnType<typeof executor.execute>>>[]> | undefined;
    try {
      executions = Promise.allSettled([
        executor.execute('container-read-execution', binding),
        executor.execute('container-search-execution', binding),
      ]);
      await until(() => startedToolCalls.length === 2);
      expect(containerStarts).toBe(1);
      expect(maxConcurrentToolCalls).toBe(2);
      expect(startedToolCalls.sort()).toEqual(['read_file', 'search_files']);
      releaseTools();
      const results = await executions;
      expect(results.map((result) => (result.status === 'fulfilled' ? result.value.status : 'rejected'))).toEqual([
        'completed',
        'completed',
      ]);
    } finally {
      releaseTools();
      await executions;
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

interface RunnerResponse {
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: unknown;
  error?: string;
}

function captureRunner(command: ChildProcess): Promise<RunnerResponse> {
  let stdout = '';
  let stderr = '';
  command.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  command.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    command.once('error', reject);
    command.once('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `Container runner exited with code ${code ?? 1}`));
      try {
        resolve(JSON.parse(stdout) as RunnerResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function executeRunner(
  mode: 'run' | 'status' | 'interrupt',
  key: string,
  toolName: string | undefined,
  executionDirectory: string,
  workspace: string,
  input?: string,
): Promise<RunnerResponse> {
  const command = spawn(
    process.execPath,
    ['-e', CONTAINER_RUNNER, mode, key, toolName ?? '', executionDirectory, workspace],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const result = captureRunner(command);
  command.stdin!.end(input);
  return result;
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`File did not appear before timeout: ${path}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForRunnerStatus(
  key: string,
  executionDirectory: string,
  workspace: string,
  target: RunnerResponse['status'],
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await executeRunner('status', key, undefined, executionDirectory, workspace);
    if (current.status === target) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Container Runner did not report ${target} before timeout`);
}

function processGroupMatches(pid: number, startTime?: string): boolean {
  if (!startTime) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return Number(fields[2]) === pid && fields[19] === startTime;
  } catch {
    return false;
  }
}
