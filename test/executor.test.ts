import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload, setToolPolicy } from './helpers.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { HostExecutor } from '../src/executor/executor.js';
import { ContainerExecutor } from '../src/executor/container-executor.js';
import { EXECUTOR_PROTOCOL_VERSION } from '../src/executor/remote-protocol.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

interface MockRemoteExecution {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: unknown;
  error?: string;
  controller?: AbortController;
}

function createMockContainerAgent(
  workspace: string,
  catalog: ToolCatalog,
  podman: (args: string[], input?: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>,
): {
  runner: (args: string[], input?: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
  executions: Map<string, MockRemoteExecution>;
  getSubmissionCount: () => number;
  loseExecutions: boolean;
  completeExecution: (id: string, result: unknown) => void;
  loseNextSubmissionAck: boolean;
  close: () => void;
} {
  const executions = new Map<string, MockRemoteExecution>();
  let exposedPort: number | null = null;
  let accessToken: string | null = null;
  let serviceReady = false;
  let containerCreated = false;
  let submissionCount = 0;
  let loseExecutions = false;
  let loseNextSubmissionAck = false;
  const originalFetch = globalThis.fetch;

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    if (!exposedPort || Number(requestUrl.port) !== exposedPort) return originalFetch(input, init);
    if (!serviceReady) return json({ error: 'Container Executor is not ready.' }, 503);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (!accessToken || headers.get('authorization') !== `Bearer ${accessToken}`) {
      return json({ error: 'Remote Executor bearer token required.' }, 401);
    }

    if (requestUrl.pathname === '/api/info' && (init?.method ?? 'GET') === 'GET') {
      return json({
        protocolVersion: EXECUTOR_PROTOCOL_VERSION,
        executorVersion: '0.2.0',
        updateSupported: false,
        name: 'Mock Container Executor',
        kind: 'executor',
        workspaceRoot: '/workspace',
        tools: catalog.listBySource('executor').map((tool) => tool.definition),
      });
    }

    const executionMatch = /^\/api\/executions\/([^/]+)(?:\/(interrupt))?$/.exec(requestUrl.pathname);
    if (!executionMatch) return json({ error: 'Not found.' }, 404);
    const id = decodeURIComponent(executionMatch[1]!);
    const isInterrupt = executionMatch[2] === 'interrupt';
    const method = init?.method ?? 'GET';

    if (isInterrupt && method === 'POST') {
      const execution = executions.get(id);
      if (!execution) return json({ error: 'Execution not found.' }, 404);
      execution.controller?.abort();
      execution.status = 'interrupted';
      execution.error = 'Execution interrupted.';
      return json(execution);
    }
    if (method === 'GET') {
      if (loseExecutions || !executions.has(id)) return json({ error: 'Execution not found.' }, 404);
      return json(executions.get(id));
    }
    if (method !== 'POST' || isInterrupt) return json({ error: 'Method not allowed.' }, 405);

    let requestBody: Record<string, unknown>;
    try {
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      return json({ error: 'Invalid JSON body.' }, 400);
    }
    const toolName = requestBody.toolName;
    const args = requestBody.arguments;
    if (typeof toolName !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return json({ error: 'Invalid execution request.' }, 400);
    }
    const existing = executions.get(id);
    if (existing) return json(existing);
    const tool = catalog.get(toolName);
    if (!tool || tool.source !== 'executor') return json({ error: `Unknown Executor tool: ${toolName}` }, 400);

    submissionCount += 1;
    const execution: MockRemoteExecution = { id, status: 'running', controller: new AbortController() };
    executions.set(id, execution);
    void Promise.resolve()
      .then(() =>
        tool.execute(args as Record<string, unknown>, {
          workspacePath: workspace,
          executionId: id,
          signal: execution.controller!.signal,
        }),
      )
      .then((result) => {
        if (execution.status === 'running') {
          execution.status = 'completed';
          execution.result = result;
        }
      })
      .catch((error: unknown) => {
        if (execution.status === 'running') {
          execution.status = execution.controller?.signal.aborted ? 'interrupted' : 'failed';
          execution.error = error instanceof Error ? error.message : String(error);
        }
      });
    if (loseNextSubmissionAck) {
      loseNextSubmissionAck = false;
      return json({ error: 'Submission response was lost.' }, 500);
    }
    return json(execution, 202);
  };

  return {
    runner: async (args, input, signal) => {
      if (args.includes('container') && args.includes('inspect')) {
        if (!containerCreated) throw new Error('no such container');
        return { stdout: 'true', stderr: '' };
      }
      if (args.includes('run')) {
        const published = args[args.indexOf('-p') + 1];
        const match = published && /^127\.0\.0\.1:(\d+):4174$/.exec(published);
        if (match) exposedPort = Number(match[1]);
      }
      if (args.includes('exec')) {
        if (!args.includes('-d')) return { stdout: '', stderr: '' };
        const token = args.find((argument) => argument.startsWith('PICO_EXECUTOR_TOKEN='));
        accessToken = token?.slice('PICO_EXECUTOR_TOKEN='.length) ?? null;
        serviceReady = Boolean(exposedPort && accessToken);
        return { stdout: '', stderr: '' };
      }
      const result = await podman(args, input, signal);
      if (args.includes('run')) containerCreated = true;
      return result;
    },
    executions,
    getSubmissionCount: () => submissionCount,
    get loseExecutions() {
      return loseExecutions;
    },
    set loseExecutions(value: boolean) {
      loseExecutions = value;
    },
    get loseNextSubmissionAck() {
      return loseNextSubmissionAck;
    },
    set loseNextSubmissionAck(value: boolean) {
      loseNextSubmissionAck = value;
    },
    completeExecution(id, result) {
      const execution = executions.get(id);
      if (execution) {
        execution.status = 'completed';
        execution.result = result;
      }
    },
    close() {
      for (const execution of executions.values()) execution.controller?.abort();
      globalThis.fetch = originalFetch;
    },
  };
}

describe('Executor execution identity and recovery', () => {
  it('treats concurrent and repeated Host Executor submissions with one ID as one execution', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    const directory = await mkdtemp(join(tmpdir(), 'pico-host-dedupe-'));
    const pluginDirectory = join(directory, 'executor-plugins');
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'side-effect.mjs'),
      `export default {
        id: 'test.side-effect', name: 'Side effect test tool', version: '1',
        activateExecutor({ tools }) {
          tools.register({ name: 'side_effect', description: 'Count executions in the workspace.', parameters: { type: 'object' } }, async (_args, context) => {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            const file = path.join(context.workspacePath, 'side-effect-count.txt');
            const count = Number(await fs.readFile(file, 'utf8').catch(() => '0')) + 1;
            await fs.writeFile(file, String(count));
            return { changed: true };
          });
        }
      };`,
    );
    const previousDatabasePath = process.env.PICO_DB_PATH;
    process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
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
      toolCalls: [{ call: { id: 'stable-call', name: 'side_effect', arguments: {} }, executionId: randomUUID() }],
    });
    const executionId = env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')!.id;
    const executor = new HostExecutor(env.store, undefined, pluginDirectory);
    const binding = env.store.executorForThread(thread.id)!;
    try {
      const one = executor.execute(executionId, binding);
      const two = executor.execute(executionId, binding);
      await until(() => existsSync(join(env.workspace, 'side-effect-count.txt')));
      const [first, second] = await Promise.all([one, two]);
      const retry = await executor.execute(executionId, binding);
      expect(first.status).toBe('completed');
      expect(second.status).toBe('completed');
      expect(retry.status).toBe('completed');
      expect(await readFile(join(env.workspace, 'side-effect-count.txt'), 'utf8')).toBe('1');
    } finally {
      await executor.shutdown();
      if (previousDatabasePath === undefined) delete process.env.PICO_DB_PATH;
      else process.env.PICO_DB_PATH = previousDatabasePath;
      await env.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for active Host tool invocations to settle during shutdown', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    const directory = await mkdtemp(join(tmpdir(), 'pico-host-shutdown-'));
    const pluginDirectory = join(directory, 'executor-plugins');
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'wait-for-abort.mjs'),
      `export default {
        id: 'test.wait-for-abort', name: 'Wait for abort test tool', version: '1',
        activateExecutor({ tools }) {
          tools.register({ name: 'wait_for_abort', description: 'Wait until shutdown aborts the tool.', parameters: { type: 'object' } }, async (_args, context) => {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            await fs.writeFile(path.join(context.workspacePath, 'tool-started.txt'), 'started');
            return new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 60_000);
              context.signal.addEventListener('abort', async () => {
                clearTimeout(timer);
                await fs.writeFile(path.join(context.workspacePath, 'tool-aborted.txt'), 'aborted');
                setTimeout(() => reject(new DOMException('Execution interrupted', 'AbortError')), 100);
              }, { once: true });
            });
          });
        }
      };`,
    );
    const previousDatabasePath = process.env.PICO_DB_PATH;
    process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
    const modelExecution = env.store.createModelExecution('shutdown-model', thread.id, 0);
    const shutdownExecutionId = randomUUID();
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
        { call: { id: 'shutdown-call', name: 'wait_for_abort', arguments: {} }, executionId: shutdownExecutionId },
      ],
    });
    const executor = new HostExecutor(env.store, undefined, pluginDirectory);
    const binding = env.store.executorForThread(thread.id)!;
    let execution: Promise<Awaited<ReturnType<typeof executor.execute>>> | undefined;
    try {
      execution = executor.execute(shutdownExecutionId, binding);
      await until(() => existsSync(join(env.workspace, 'tool-started.txt')));
      let shutdownSettled = false;
      const shutdown = executor.shutdown().then(() => {
        shutdownSettled = true;
      });
      await until(() => existsSync(join(env.workspace, 'tool-aborted.txt')));
      expect(shutdownSettled).toBe(false);
      await shutdown;
      // Shutdown stops the Host process, but the Runtime keeps its last confirmed state.
      expect((await execution).status).toBe('running');
      expect(shutdownSettled).toBe(true);
    } finally {
      await executor.shutdown();
      if (previousDatabasePath === undefined) delete process.env.PICO_DB_PATH;
      else process.env.PICO_DB_PATH = previousDatabasePath;
      await env.cleanup();
      await rm(directory, { recursive: true, force: true });
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
        {
          call: { id: 'lost-call', name: 'read_file', arguments: { path: 'input.txt' } },
          executionId: lostToolId,
          source: 'executor',
        },
      ],
    });
    store.transitionExecution(lostToolId, 'running');
    store.setPluginState('pico.permissions', 'approvals', {
      [lostToolId]: {
        executionId: lostToolId,
        threadId: thread.id,
        toolName: 'read_file',
        arguments: { path: 'input.txt' },
        status: 'allowed',
        createdAt: new Date().toISOString(),
      },
    });
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
    runtime.updateModelSettings({ model: 'test-model' });
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
    const executor = new ContainerExecutor(env.store, undefined, undefined, disconnected);
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

  it('keeps Container setup retryable when the image registry drops the pull response', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('registry-eof-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const call = { id: 'registry-eof-call', name: 'shell', arguments: { command: 'true' } };
    env.store.commitModelStep({
      assistantRecordId: 'registry-eof-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'registry-eof-model:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'registry-eof-tool' }],
    });

    let registryAvailable = false;
    let containerSetupAttempts = 0;
    const podman = async (args: string[]) => {
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) throw new Error('no such container');
      if (args.includes('run')) {
        containerSetupAttempts += 1;
        if (!registryAvailable) {
          throw new Error(
            'copying system image from manifest: Get "https://cdn.example.test/v2/blob?Expires=123&Signature=temporary-secret&Key-Pair-Id=key-1": EOF',
          );
        }
        return { stdout: 'container-id', stderr: '' };
      }
      if (args.includes('exec')) {
        return {
          stdout: JSON.stringify({ status: 'completed', result: { exitCode: 0, stdout: '', stderr: '' } }),
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
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const firstAttempt = await executor.execute('registry-eof-tool', binding).then(
        () => null,
        (error: unknown) => error,
      );
      expect(firstAttempt).toBeInstanceOf(Error);
      if (!(firstAttempt instanceof Error)) throw new Error('Expected the first Container setup attempt to fail.');
      expect(firstAttempt.message).toContain('https://cdn.example.test/v2/blob?<redacted>');
      expect(firstAttempt.message).toContain('EOF');
      expect(firstAttempt.message).not.toContain('temporary-secret');
      const retryableExecution = env.store.getExecution('registry-eof-tool');
      expect(retryableExecution?.status).toBe('pending');

      registryAvailable = true;
      expect((await executor.execute('registry-eof-tool', binding)).status).toBe('completed');
      expect(env.store.getExecution('registry-eof-tool')?.error).toBeNull();
      expect(containerSetupAttempts).toBe(2);
    } finally {
      await executor.shutdown();
      mockAgent.close();
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

    const podman = async (args: string[]) => {
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) return { stdout: 'true', stderr: '' };
      if (args.includes('run')) return { stdout: 'container-id', stderr: '' };
      if (args.includes('start')) return { stdout: 'container-id', stderr: '' };
      if (args.includes('exec')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'read_file', description: 'test read', parameters: { type: 'object' } },
      execute: async (_args, context) =>
        new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Execution interrupted', 'AbortError')),
            { once: true },
          );
        }),
    });
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
    mockAgent.loseNextSubmissionAck = true;
    let execution: Promise<Awaited<ReturnType<typeof executor.execute>>> | undefined;
    try {
      const binding = env.store.executorForThread(thread.id)!;
      execution = executor.execute('lost-ack-tool', binding);
      await until(() => env.store.getExecution('lost-ack-tool')?.status === 'running');
      expect((await executor.status('lost-ack-tool', binding))?.status).toBe('running');
      expect(mockAgent.getSubmissionCount()).toBe(1);

      await executor.shutdown();
      expect((await execution).status).toBe('running');
      mockAgent.loseExecutions = true;
      const confirmedLost = await executor.status('lost-ack-tool', binding);
      expect(confirmedLost?.status).toBe('interrupted');
      expect(confirmedLost?.error).toMatch(/confirmed.*no longer in its durable ledger/i);
    } finally {
      await executor.shutdown();
      mockAgent.close();
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
    const podman = async (args: string[]) => {
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) {
        if (containerPresent) return { stdout: '{}', stderr: '' };
        throw new Error('no such container');
      }
      if (args.includes('run')) {
        containerPresent = true;
        return { stdout: 'container-id', stderr: '' };
      }
      if (args.includes('start')) return { stdout: 'container-id', stderr: '' };
      if (args.includes('exec')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let releaseTool!: (result: { contents: string }) => void;
    const toolResult = new Promise<{ contents: string }>((resolve) => {
      releaseTool = resolve;
    });
    let submissions = 0;
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'read_file', description: 'test read', parameters: { type: 'object' } },
      execute: async () => {
        submissions += 1;
        markToolStarted();
        return toolResult;
      },
    });
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const binding = env.store.executorForThread(thread.id)!;
    const beforeRestart = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
    const executionPromise = beforeRestart.execute('shutdown-container-tool', binding);
    try {
      await toolStarted;
      await beforeRestart.shutdown();
      expect((await executionPromise).status).toBe('running');
      expect(env.store.getExecution('shutdown-container-tool')?.status).toBe('running');

      mockAgent.completeExecution('shutdown-container-tool', { contents: 'recovered' });
      const afterRestart = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
      try {
        const resumed = await afterRestart.execute('shutdown-container-tool', binding);
        expect(resumed).toMatchObject({ status: 'completed', result: { contents: 'recovered' } });
        expect(submissions).toBe(1);
      } finally {
        await afterRestart.shutdown();
      }
    } finally {
      releaseTool({ contents: 'unused' });
      await beforeRestart.shutdown();
      mockAgent.close();
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
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) throw new Error('no such container');
      if (args.includes('run')) {
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
    const executor = new ContainerExecutor(env.store, undefined, undefined, runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const execution = executor.execute('preparing-tool', binding);
      await runStarted;
      const interrupted = await executor.interrupt('preparing-tool', binding);
      expect(observedAbort).toBe(true);
      expect(interrupted?.status).toBe('interrupted');
      expect((await execution).status).toBe('interrupted');
      expect(env.store.getExecution('preparing-tool')?.status).toBe('interrupted');
      expect(calls.some((args) => args.includes('exec'))).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('replaces an aborted shared Container setup for a new waiter', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const modelExecution = env.store.createModelExecution('setup-retry-model', thread.id, 0);
    env.store.transitionExecution(modelExecution.id, 'running');
    const firstCall = { id: 'setup-retry-first-call', name: 'shell', arguments: { command: 'true' } };
    const secondCall = { id: 'setup-retry-second-call', name: 'shell', arguments: { command: 'true' } };
    env.store.commitModelStep({
      assistantRecordId: 'setup-retry-model:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'setup-retry-model:batch', toolCalls: [firstCall, secondCall] }),
      toolCalls: [
        { call: firstCall, executionId: 'setup-retry-first-tool' },
        { call: secondCall, executionId: 'setup-retry-second-tool' },
      ],
    });

    let runCalls = 0;
    let markFirstRunStarted!: () => void;
    const firstRunStarted = new Promise<void>((resolve) => {
      markFirstRunStarted = resolve;
    });
    const podman = async (args: string[], _input?: string, signal?: AbortSignal) => {
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) throw new Error('no such container');
      if (args.includes('run')) {
        runCalls += 1;
        if (runCalls === 1) {
          markFirstRunStarted();
          return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
            const onAbort = (): void => {
              signal?.removeEventListener('abort', onAbort);
              setTimeout(() => reject(new DOMException('Podman setup interrupted.', 'AbortError')), 150);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return { stdout: 'container-id', stderr: '' };
      }
      if (args.includes('exec')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'shell', description: 'test shell', parameters: { type: 'object' } },
      execute: async () => ({ exitCode: 0 }),
    });
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const firstExecution = executor.execute('setup-retry-first-tool', binding);
      await firstRunStarted;
      expect((await executor.interrupt('setup-retry-first-tool', binding))?.status).toBe('interrupted');

      const secondExecution = await executor.execute('setup-retry-second-tool', binding);
      expect(secondExecution.status).toBe('completed');
      expect(runCalls).toBe(2);
      expect((await firstExecution).status).toBe('interrupted');
    } finally {
      await executor.shutdown();
      mockAgent.close();
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
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) throw new Error('no such container');
      if (args.includes('run')) {
        selectedImage = args[args.length - 3];
        return { stdout: 'container-id', stderr: '' };
      }
      if (args.includes('exec')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    catalog.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'shell', description: 'test shell', parameters: { type: 'object' } },
      execute: async () => ({ exitCode: 0 }),
    });
    const mockAgent = createMockContainerAgent(env.workspace, catalog, runner);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      const result = await executor.execute('image-tool', binding);
      expect(result.status).toBe('completed');
      expect(selectedImage).toBe('registry.example.test/pico/node:22');
    } finally {
      if (previousImage === undefined) delete process.env.PICO_CONTAINER_IMAGE;
      else process.env.PICO_CONTAINER_IMAGE = previousImage;
      await executor.shutdown();
      mockAgent.close();
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
      if (args.includes('info')) return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) {
        if (containerCreated) return { stdout: '{}', stderr: '' };
        throw new Error('no such container');
      }
      if (args.includes('run')) {
        if (containerCreated) throw new Error('container name is already in use');
        containerCreated = true;
        containerStarts += 1;
        return { stdout: 'container-id', stderr: '' };
      }
      if (args.includes('start')) return { stdout: 'container-id', stderr: '' };
      if (args.includes('exec')) return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const catalog = new ToolCatalog();
    for (const name of ['read_file', 'search_files']) {
      catalog.register({
        owner: 'test',
        source: 'executor',
        definition: { name, description: `test ${name}`, parameters: { type: 'object' } },
        execute: async () => {
          startedToolCalls.push(name);
          activeToolCalls += 1;
          maxConcurrentToolCalls = Math.max(maxConcurrentToolCalls, activeToolCalls);
          await toolGate;
          activeToolCalls -= 1;
          return { toolName: name };
        },
      });
    }
    const mockAgent = createMockContainerAgent(env.workspace, catalog, runner);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner);
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
      await executor.shutdown();
      mockAgent.close();
      await env.cleanup();
    }
  });

  it('retries Btrfs overlay storage with the discovered fuse-overlayfs helper', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const calls: string[][] = [];
    const podman = async (args: string[]) => {
      calls.push(args);
      if (args.includes('info') && !args.includes('--storage-opt')) {
        throw new Error(
          'kernel does not support overlay fs: \'overlay\' is not supported over btrfs at "/storage/overlay"',
        );
      }
      return { stdout: '5.0.0', stderr: '' };
    };
    const catalog = new ToolCatalog();
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const executor = new ContainerExecutor(
      env.store,
      undefined,
      undefined,
      mockAgent.runner,
      '/usr/bin/fuse-overlayfs',
    );
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await executor.checkConnection(binding);
      await executor.checkConnection(binding);
      expect(calls.filter((args) => args.includes('info'))).toEqual([
        ['info', '--format', '{{.Version.Version}}'],
        ['--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs', 'info', '--format', '{{.Version.Version}}'],
        ['--storage-opt', 'overlay.mount_program=/usr/bin/fuse-overlayfs', 'info', '--format', '{{.Version.Version}}'],
      ]);
    } finally {
      await executor.shutdown();
      mockAgent.close();
      await env.cleanup();
    }
  });

  it('uses an isolated persistent VFS store when no fuse-overlayfs helper is available', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('container');
    const calls: string[][] = [];
    const podman = async (args: string[]) => {
      calls.push(args);
      if (args.includes('info') && !args.includes('--storage-driver'))
        throw new Error("'overlay' is not supported over btrfs");
      return { stdout: '5.0.0', stderr: '' };
    };
    const vfsRoot = '/tmp/pico-test-vfs-root';
    const catalog = new ToolCatalog();
    const mockAgent = createMockContainerAgent(env.workspace, catalog, podman);
    const executor = new ContainerExecutor(env.store, undefined, undefined, mockAgent.runner, '', vfsRoot);
    try {
      const binding = env.store.executorForThread(thread.id)!;
      await executor.checkConnection(binding);
      await executor.checkConnection(binding);
      expect(calls.filter((args) => args.includes('info'))).toEqual([
        ['info', '--format', '{{.Version.Version}}'],
        ['--root', vfsRoot, '--storage-driver', 'vfs', 'info', '--format', '{{.Version.Version}}'],
        ['--root', vfsRoot, '--storage-driver', 'vfs', 'info', '--format', '{{.Version.Version}}'],
      ]);
    } finally {
      await executor.shutdown();
      mockAgent.close();
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
      setToolPolicy(env.store, thread.id, 'shell', 'allow');
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
