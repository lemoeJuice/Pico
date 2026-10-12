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
