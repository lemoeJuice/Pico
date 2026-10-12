import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AssistantPayload, Execution } from '../src/core/types.js';
import { PicoStore } from '../src/core/store.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import type { ModelResponse } from '../src/runtime/model.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import type { ModelStageInput, ProjectionInput, StepInput, ToolBatchInput } from '../src/runtime/stages.js';
import { threadCanBeInterrupted } from '../src/web/thread-controls.js';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';

describe('durable Thread runtime invariants', () => {
  it('deduplicates Messages by ID and starts an idle Thread once', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      const first = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      const retry = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      await env.runtime.drain();

      expect(first.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });

  it('closes with a pending approval intact and restores it after Runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-approval-restart-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'input.txt'), 'durable approval', 'utf8');
    const databasePath = join(directory, 'runtime.sqlite');
    let modelCalls = 0;
    const createModel = (): FakeModel =>
      new FakeModel(() => {
        modelCalls += 1;
        return modelCalls === 1
          ? response('', [{ id: 'approval-read', name: 'read_file', arguments: { path: 'input.txt' } }])
          : response('The file was read after restart.');
      });
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, { model: createModel(), pluginDirectory: join(directory, 'empty-plugins') });
    await runtime.initialize();
    const project = await runtime.createProject('Approval recovery', workspace);
    const thread = runtime.createThread(project.id, 'host');
    try {
      await runtime.submit(thread.id, 'approval-restart-message', 'Read the input file.');
      await until(() => store.listApprovals(thread.id).some((approval) => approval.status === 'pending'));
      const approval = store.listApprovals(thread.id)[0]!;
      const executionBeforeShutdown = store.getExecution(approval.executionId);

      await runtime.shutdown();
      expect(executionBeforeShutdown?.status).toBe('pending');
      expect(store.getExecution(approval.executionId)?.status).toBe('pending');
      expect(store.getApproval(approval.executionId)?.status).toBe('pending');
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: createModel(),
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      await until(() => runtime.getSnapshot(thread.id)?.approvals[0]?.status === 'pending');
      runtime.resolveApproval(approval.executionId, true);
      await runtime.drain();

      expect(store.getExecution(approval.executionId)?.status).toBe('completed');
      expect(store.getApproval(approval.executionId)?.status).toBe('allowed');
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(2);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discards an in-flight Model draft on shutdown and resumes from the last durable boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-model-shutdown-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let notifyModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      notifyModelStarted = resolve;
    });
    const interruptedModel = new FakeModel((_prompt, _callNumber, signal, onText) => {
      onText('This partial answer must not become history.');
      notifyModelStarted();
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('Runtime is shutting down.', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: interruptedModel,
      pluginDirectory: join(directory, 'empty-plugins'),
    });
    await runtime.initialize();
    const project = await runtime.createProject('Model recovery', workspace);
    const thread = runtime.createThread(project.id, 'host');
    try {
      await runtime.submit(thread.id, 'model-shutdown-message', 'Please finish this response.');
      await modelStarted;
      await runtime.shutdown();

      const unfinished = store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(interruptedModel.signals[0]?.aborted).toBe(true);
      expect(unfinished?.status).toBe('interrupted');
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(runtime.getThread(thread.id)?.pauseRequested).toBe(false);
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: new FakeModel(() => response('Recovered from the durable Message.')),
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      await runtime.drain();

      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toMatchObject([
        { payload: { content: 'Recovered from the durable Message.' } },
      ]);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not rerun a slash command when its request is retried after Runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-command-retry-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const databasePath = join(directory, 'runtime.sqlite');
    let invocations = 0;
    const commandStarted = deferred<void>();
    const releaseCommand = deferred<{ text: string }>();
    const plugin: PicoPlugin = {
      id: 'test.command-retry',
      name: 'Command retry',
      version: '1',
      activate({ commands }) {
        commands.register({
          name: 'count',
          description: 'Increment the test counter',
          async execute() {
            invocations += 1;
            commandStarted.resolve(undefined);
            return releaseCommand.promise;
          },
        });
      },
    };
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: new FakeModel(() => response('unused')),
      plugins: [plugin],
      pluginDirectory: join(directory, 'empty-plugins'),
    });
    await runtime.initialize();
    const project = await runtime.createProject('Command retries', workspace);
    const thread = runtime.createThread(project.id, 'host');
    try {
      const firstPromise = runtime.submit(thread.id, 'stable-command-id', '/count');
      await commandStarted.promise;
      const racingRetry = await runtime.submit(thread.id, 'stable-command-id', '/count');
      expect(racingRetry.duplicate).toBe(true);
      releaseCommand.resolve({ text: `Invocation ${invocations}` });
      const first = await firstPromise;
      expect(first.duplicate).toBe(false);
      expect(first.command?.text).toBe('Invocation 1');
      expect(invocations).toBe(1);

      store.close();
      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: new FakeModel(() => response('unused')),
        plugins: [plugin],
        pluginDirectory: join(directory, 'empty-plugins'),
      });
      await runtime.initialize();
      const retry = await runtime.submit(thread.id, 'stable-command-id', '/count');

      expect(retry.duplicate).toBe(true);
      expect(retry.command?.text).toContain('already accepted');
      expect(invocations).toBe(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      expect(
        store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'invocation-accepted'),
      ).toHaveLength(1);
      await expect(runtime.submit(thread.id, 'stable-command-id', '/other')).rejects.toThrow(
        /reused with different content/i,
      );
    } finally {
      releaseCommand.resolve({ text: 'cleanup' });
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes Model stage input replacements to the default model adapter', async () => {
    const plugin: PicoPlugin = {
      id: 'test.model-prompt',
      name: 'Model prompt modifier',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) =>
          next({ ...input, systemPrompt: `${input.systemPrompt}\nProject context: stable architecture.` }),
        );
        pipelines.use<ModelStageInput, ModelResponse>('model', async (input, next) =>
          next({
            ...input,
            prompt: { ...input.prompt, system: `${input.prompt.system}\nUse concise answers.` },
          }),
        );
      },
    };
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'model-prompt-message', 'Hello');
      await env.runtime.drain();

      expect(model.prompts[0]?.system).toContain('Use concise answers.');
      expect(env.store.listRecords(thread.id).find((record) => record.kind === 'message')?.payload).toMatchObject({
        content: 'Hello',
      });
      const records = env.store.listRecords(thread.id);
      const assistant = records.find((record) => record.kind === 'assistant');
      expect(records.filter((record) => record.kind === 'assistant')).toHaveLength(1);
      expect(records).toHaveLength(2);
      expect(assistant).toBeDefined();
      const modelExecutionId = assistant!.id.replace(/:assistant$/, '');
      const attempts = env.runtime.getModelInputAttempts(thread.id, modelExecutionId);
      expect(attempts).toHaveLength(1);
      expect(attempts?.[0]).toMatchObject({
        prompt: model.prompts[0],
        status: 'completed',
      });
      expect(attempts?.[0]?.prompt.system).toContain('Project context: stable architecture.');
      expect(attempts?.[0]?.prompt.system).toContain('Use concise answers.');
      expect(env.runtime.getModelInputAttempts(env.createThread().id, modelExecutionId)).toBeNull();
      expect(env.store.listRecords(thread.id)).toEqual(records);
    } finally {
      await env.cleanup();
    }
  });

  it('runs a Tool Batch concurrently and waits for every call to settle', async () => {
    const started = deferred<void>();
    const releaseAlpha = deferred<string>();
    const releaseBeta = deferred<string>();
    let starts = 0;
    const startOrder: string[] = [];
    const scheduledOrder: string[] = [];
    const batchPlugin: PicoPlugin = {
      id: 'test.parallel-tools',
      name: 'Parallel tools',
      version: '1',
      activate({ tools, pipelines }) {
        for (const name of ['batch_alpha', 'batch_beta']) {
          tools.register({ name, description: name, parameters: { type: 'object', properties: {} } }, async () => {
            starts += 1;
            startOrder.push(name);
            if (starts === 2) started.resolve();
            return name === 'batch_alpha' ? releaseAlpha.promise : releaseBeta.promise;
          });
        }
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input, next) => {
          const execute = input.execute;
          return next({
            ...input,
            calls: [...input.calls].reverse(),
            execute: (call) => {
              scheduledOrder.push(call.name);
              return execute(call);
            },
          });
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [
            { id: 'alpha', name: 'batch_alpha', arguments: {} },
            { id: 'alpha', name: 'batch_beta', arguments: {} },
          ])
        : response('Both tools finished.'),
    );
    const env = await setupRuntime(model, { plugins: [batchPlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'parallel-message', 'Run both tools');
      await started.promise;
      expect(starts).toBe(2);
      expect(startOrder).toEqual(['batch_beta', 'batch_alpha']);
      expect(scheduledOrder).toEqual(['batch_beta', 'batch_alpha']);
      expect(model.calls).toBe(1);

      releaseAlpha.resolve('alpha done');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'batch_alpha' && execution.status === 'completed'),
      );
      expect(model.calls).toBe(1);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'batch_beta')?.status).toBe(
        'running',
      );

      releaseBeta.resolve('beta done');
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(2);
      const assistant = env.store.listRecords(thread.id).find((record) => record.kind === 'assistant')!;
      const assistantStep = assistant.payload as unknown as AssistantPayload;
      expect(new Set(assistantStep.toolCalls.map((call) => call.id)).size).toBe(2);
    } finally {
      releaseAlpha.resolve('cleanup');
      releaseBeta.resolve('cleanup');
      await env.cleanup();
    }
  });

  it('keeps a Model Step and its Tool Batch inside one step pipeline iteration', async () => {
    const events: string[] = [];
    let nextStepId = 0;
    let activeStepId: number | null = null;
    const pipelinePlugin: PicoPlugin = {
      id: 'test.step-boundary',
      name: 'Step boundary',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'step_boundary_tool', description: 'Step boundary test', parameters: { type: 'object' } },
          async () => 'tool finished',
        );
        pipelines.use<StepInput, void>('step', async (input, next) => {
          const stepId = ++nextStepId;
          activeStepId = stepId;
          events.push(`step:${stepId}:start`);
          try {
            return await next(input);
          } finally {
            events.push(`step:${stepId}:end`);
            activeStepId = null;
          }
        });
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input, next) => {
          events.push(`batch:${activeStepId ?? 'outside'}`);
          return next(input);
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'step-tool', name: 'step_boundary_tool', arguments: {} }])
        : response('The iteration finished.'),
    );
    const env = await setupRuntime(model, { plugins: [pipelinePlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'step-boundary-message', 'Use the tool');
      await env.runtime.drain();

      expect(events).toEqual(['step:1:start', 'batch:1', 'step:1:end', 'step:2:start', 'step:2:end']);
      expect(model.calls).toBe(2);
    } finally {
      await env.cleanup();
    }
  });

  it('settles the current Model Step Tool Batch before honoring Pause', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const plugin: PicoPlugin = {
      id: 'test.pause-current-batch',
      name: 'Pause current Tool Batch',
      version: '1',
      activate({ tools }) {
        tools.register(
          { name: 'pause_batch_tool', description: 'Pause batch test', parameters: { type: 'object' } },
          async () => 'current batch finished',
        );
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1 ? firstResponse.promise : response('Continued after the pause.'),
    );
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'pause-batch-message', 'Start the current iteration');
      await until(() => model.calls === 1);
      const signal = model.signals[0]!;
      env.runtime.pause(thread.id);
      expect(signal.aborted).toBe(false);

      firstResponse.resolve(response('', [{ id: 'pause-call', name: 'pause_batch_tool', arguments: {} }]));
      await env.runtime.drain();

      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'completed',
      );
      env.runtime.continue(thread.id);
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      firstResponse.resolve(response('cleanup'));
      await env.cleanup();
    }
  });

  it('pauses when a short-circuited step leaves durable work unprocessed', async () => {
    const plugin: PicoPlugin = {
      id: 'test.skip-step',
      name: 'Skip step',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<StepInput, void>('step', async () => undefined);
      },
    };
    const model = new FakeModel(() => response('Should not run.'));
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'skipped-step-message', 'Wait for the plugin');
      await env.runtime.drain();

      expect(model.calls).toBe(0);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(env.runtime.getThread(thread.id)?.pauseReason).toContain('safe boundary');
    } finally {
      await env.cleanup();
    }
  });

  it('persists a replacement Tool Batch result before entering the next Model Step', async () => {
    let toolStarted = false;
    const batchPlugin: PicoPlugin = {
      id: 'test.replacement-batch',
      name: 'Replacement Tool Batch',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'batch_replaced', description: 'Replaced by the batch stage', parameters: { type: 'object' } },
          async () => {
            toolStarted = true;
            return 'unexpected';
          },
        );
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input) => {
          const now = new Date().toISOString();
          return input.calls.map((call) => ({
            id: `${input.thread.id}:${input.batchId.replace(/:batch$/, '')}:${call.id}`,
            threadId: input.thread.id,
            batchId: input.batchId,
            kind: 'tool',
            toolName: call.name,
            arguments: call.arguments,
            status: 'completed',
            result: { handledBy: 'replacement batch' },
            error: null,
            createdAt: now,
            updatedAt: now,
          }));
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'replaced-call', name: 'batch_replaced', arguments: {} }])
        : response('The replacement result is durable.'),
    );
    const env = await setupRuntime(model, { plugins: [batchPlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'replacement-batch-message', 'Run the replacement batch');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'batch_replaced');
      expect(toolStarted).toBe(false);
      expect(execution?.status).toBe('completed');
      expect(execution?.result).toEqual({ handledBy: 'replacement batch' });
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(1);
      expect(model.calls).toBe(2);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('replacement batch'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('Pause preserves the current Model Step, saves incoming Messages, and Continue resumes later', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1 ? firstResponse.promise : response('Continued.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'pause-message-1', 'Start');
      await until(() => model.calls === 1);
      const signal = model.signals[0]!;
      env.runtime.pause(thread.id);
      await env.runtime.submit(thread.id, 'pause-message-2', 'Save this for later');
      expect(signal.aborted).toBe(false);
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('pausing');

      firstResponse.resolve(response('Finished the current step.'));
      await env.runtime.drain();
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(2);

      env.runtime.continue(thread.id);
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      firstResponse.resolve(response('cleanup'));
      await env.cleanup();
    }
  });

  it('keeps Interrupt available for a Tool Execution that outlives a paused Thread', async () => {
    const toolStarted = deferred<void>();
    const toolAborted = deferred<void>();
    let store: PicoStore | null = null;
    const plugin: PicoPlugin = {
      id: 'test.paused-active-tool',
      name: 'Paused active Tool',
      version: '1',
      activate({ tools, pipelines }) {
        tools.register(
          { name: 'wait_for_interrupt', description: 'Wait for Interrupt', parameters: { type: 'object' } },
          async (_args, context) => {
            toolStarted.resolve(undefined);
            return new Promise((_, reject) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  toolAborted.resolve(undefined);
                  reject(new DOMException('Execution interrupted', 'AbortError'));
                },
                { once: true },
              );
            });
          },
        );
        pipelines.use<ToolBatchInput, Execution[]>('toolBatch', async (input) => {
          void input.execute(input.calls[0]!);
          await toolStarted.promise;
          const execution = store!
            .listExecutions(input.thread.id)
            .find((item) => item.batchId === input.batchId && item.kind === 'tool');
          if (!execution) throw new Error('Tool Execution was not durably started');
          return [execution];
        });
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'long-tool', name: 'wait_for_interrupt', arguments: {} }])
        : response('The tool was interrupted.'),
    );
    const env = await setupRuntime(model, { plugins: [plugin] });
    store = env.store;
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'paused-active-tool-message', 'Start a long tool');
      await toolStarted.promise;
      await env.runtime.drain();

      const paused = env.runtime.getThread(thread.id)!;
      const activeExecutions = env.store.listExecutions(thread.id);
      expect(paused.state).toBe('paused');
      expect(activeExecutions.some((execution) => execution.status === 'running')).toBe(true);
      expect(model.calls).toBe(1);
      expect(threadCanBeInterrupted(paused.state, activeExecutions)).toBe(true);

      await env.runtime.interrupt(thread.id);
      await toolAborted.promise;
      await until(() => env.store.listExecutions(thread.id).every((execution) => execution.status !== 'running'));
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'interrupted',
      );
      expect(threadCanBeInterrupted(env.runtime.getThread(thread.id)!.state, env.store.listExecutions(thread.id))).toBe(
        false,
      );
    } finally {
      await env.runtime.interrupt(thread.id);
      await env.cleanup();
    }
  });

  it('asks before a Host Executor tool call, then records the allowed result', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read-call', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('I read the file.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      expect(env.runtime.toolPermissions(thread.id).find((tool) => tool.name === 'read_file')?.policy).toBe('ask');
      await env.runtime.submit(thread.id, 'approval-message', 'Read facts.txt');
      await until(() => env.store.listApprovals(thread.id).some((approval) => approval.status === 'pending'));
      const approval = env.store.listApprovals(thread.id)[0]!;
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');

      env.runtime.resolveApproval(approval.executionId, true);
      await env.runtime.drain();
      expect(env.store.getApproval(approval.executionId)?.status).toBe('allowed');
      expect(env.runtime.toolPermissions(thread.id).find((tool) => tool.name === 'read_file')?.policy).toBe('ask');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toBe(true);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('Interrupt stops a pathological Host search while the Runtime remains responsive', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'regex-search', name: 'search_files', arguments: { pattern: '^(a+)+$' } }])
        : response('The search was interrupted.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/pathological.txt`, `${'a'.repeat(28)}!`, 'utf8');
    env.runtime.setToolPermission(thread.id, 'search_files', 'allow');
    try {
      await env.runtime.submit(thread.id, 'regex-search-message', 'Search this workspace.');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'search_files' && execution.status === 'running'),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'search_files');
      const result = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(execution?.status).toBe('interrupted');
      expect((result?.payload as { status?: string }).status).toBe('interrupted');
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  }, 5000);

  it('Interrupt cancels a pending approval without recording a denial or starting the Tool', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'cancel-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The interrupted approval was not executed.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    let invocations = 0;
    const readFileTool = env.runtime.tools.get('read_file')!;
    env.runtime.tools.replace({
      ...readFileTool,
      execute: async () => {
        invocations += 1;
        return { contents: 'should not be read' };
      },
    });
    try {
      await env.runtime.submit(thread.id, 'cancel-approval-message', 'Read facts.txt');
      await until(() => env.store.listApprovals(thread.id).some((approval) => approval.status === 'pending'));
      const approval = env.store.listApprovals(thread.id)[0]!;

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(env.store.getApproval(approval.executionId)?.status).toBe('cancelled');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('interrupted');
      expect(() => env.runtime.resolveApproval(approval.executionId, true, true)).toThrow(/cancelled/i);
      expect(env.runtime.toolPermissions(thread.id).find((tool) => tool.name === 'read_file')?.policy).toBe('ask');
      expect(invocations).toBe(0);
      expect(model.calls).toBe(1);
      const permissionRecords = env.store
        .listRecords(thread.id)
        .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions');
      expect(permissionRecords.some((record) => record.payload.action === 'cancel')).toBe(true);
      expect(
        permissionRecords.some((record) => record.payload.action === 'decision' && record.payload.decision === 'deny'),
      ).toBe(false);
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'tool_result' && record.payload.status === 'interrupted'),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('can persist an approval for one Tool in the Thread to avoid repeated prompts', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read-once', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : callNumber === 2
          ? response('', [{ id: 'read-again', name: 'read_file', arguments: { path: 'facts.txt' } }])
          : response('The file was read twice.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      await env.runtime.submit(thread.id, 'thread-approval-message', 'Read the file twice');
      await until(() => env.store.listApprovals(thread.id).some((approval) => approval.status === 'pending'));
      const approval = env.store.listApprovals(thread.id)[0]!;

      env.runtime.resolveApproval(approval.executionId, true, true);
      await env.runtime.drain();

      expect(env.runtime.toolPermissions(thread.id).find((tool) => tool.name === 'read_file')?.policy).toBe('allow');
      expect(env.store.listApprovals(thread.id)).toHaveLength(1);
      expect(env.store.getApproval(approval.executionId)?.status).toBe('allowed');
      expect(
        env.store
          .listRecords(thread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.scope === 'thread',
          ),
      ).toBe(true);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(model.calls).toBe(3);
      expect(
        model.prompts[2]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('explicit Interrupt aborts a Model Step and leaves no partial assistant fact', async () => {
    const started = deferred<void>();
    const model = new FakeModel(
      (_prompt, _callNumber, signal) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
        }),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'interrupt-model-message', 'Begin');
      await started.promise;
      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();
      expect(model.signals[0]?.aborted).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      const modelExecution = env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(modelExecution?.status).toBe('interrupted');
      expect(env.runtime.getModelInputAttempts(thread.id, modelExecution!.id)).toMatchObject([
        { status: 'interrupted', prompt: { turns: [{ content: 'Begin' }] } },
      ]);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('discards partial streaming text when a Model Step fails', async () => {
    const model = new FakeModel((_prompt, _callNumber, _signal, onText) => {
      onText('unfinished draft');
      throw new Error('stream disconnected');
    });
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'stream-failure-message', 'Write something');
      await env.runtime.drain();
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      const modelExecution = env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model');
      expect(modelExecution?.status).toBe('failed');
      expect(env.runtime.getModelInputAttempts(thread.id, modelExecution!.id)).toMatchObject([
        { status: 'failed', error: 'stream disconnected', prompt: { turns: [{ content: 'Write something' }] } },
      ]);
      expect(env.store.listRecords(thread.id).map((record) => record.kind)).toEqual(['message']);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('pauses on a model output limit and does not execute calls from the truncated response', async () => {
    const model = new FakeModel(() => ({
      ...response('The answer stops here'),
      finishReason: 'length',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      toolCalls: [{ id: 'truncated-call', name: 'read_file', arguments: { path: 'facts.txt' } }],
    }));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'output-limit-message', 'Answer and inspect facts.txt.');
      await env.runtime.drain();

      const assistant = env.store.listRecords(thread.id).find((record) => record.kind === 'assistant');
      expect(assistant?.payload).toMatchObject({
        content: 'The answer stops here',
        toolCalls: [],
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        finishReason: 'length',
      });
      expect(env.store.listExecutions(thread.id).filter((execution) => execution.kind === 'tool')).toHaveLength(0);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model')?.result).toMatchObject(
        {
          finishReason: 'length',
        },
      );
      expect(env.runtime.getThread(thread.id)).toMatchObject({
        state: 'paused',
        pauseReason: expect.stringContaining('output token limit'),
      });
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('lets a child Thread and parent exchange ordinary Messages without blocking spawn', async () => {
    let parentId = '';
    let childId = '';
    let parentCalls = 0;
    let childCalls = 0;
    const model = new FakeModel((prompt) => {
      const threadId = prompt.system.match(/Current Thread ID: ([^\n]+)/)?.[1];
      if (threadId === parentId) {
        parentCalls += 1;
        if (parentCalls === 1)
          return response('', [
            {
              id: 'spawn',
              name: 'spawn_thread',
              arguments: { title: 'Research child', prompt: 'Find one useful fact.' },
            },
          ]);
        if (parentCalls === 2)
          return response('', [
            {
              id: 'reply',
              name: 'send_thread_message',
              arguments: { thread_id: childId, message: 'Please check the detail.' },
            },
          ]);
        return response('Parent received the child update.');
      }
      childCalls += 1;
      if (childCalls === 1)
        return response('', [
          {
            id: 'child-reply',
            name: 'send_thread_message',
            arguments: { thread_id: parentId, message: 'The detail is confirmed.' },
          },
        ]);
      return response('Child work is complete.');
    });
    const env = await setupRuntime(model);
    const parent = env.createThread('host', 'Main thread');
    parentId = parent.id;
    const unsubscribe = env.runtime.subscribe((event) => {
      const created = event.thread as { id?: string; parentThreadId?: string | null } | undefined;
      if (event.type === 'thread.created' && created?.parentThreadId === parent.id) childId = created.id ?? '';
    });
    try {
      await env.runtime.submit(parent.id, 'parent-child-start', 'Delegate a quick check');
      await env.runtime.drain();
      const child = env.store.getThread(childId);
      expect(child).not.toBeNull();
      expect(child?.projectId).toBe(parent.projectId);
      expect(child?.executorKind).toBe(parent.executorKind);
      expect(child?.parentThreadId).toBe(parent.id);
      expect(env.runtime.getSnapshot(parent.id)?.children.map((item) => item.id)).toContain(childId);

      const parentMessages = env.store.listRecords(parent.id).filter((record) => record.kind === 'message');
      const childMessages = env.store.listRecords(childId).filter((record) => record.kind === 'message');
      expect(
        parentMessages.some(
          (record) => record.payload.source === 'child' && record.payload.content === 'The detail is confirmed.',
        ),
      ).toBe(true);
      expect(
        childMessages.some(
          (record) => record.payload.source === 'child' && record.payload.content === 'Please check the detail.',
        ),
      ).toBe(true);
      expect(parentCalls).toBeGreaterThanOrEqual(3);
      expect(childCalls).toBeGreaterThanOrEqual(2);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${parent.id}`) &&
            prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'The detail is confirmed.'),
        ),
      ).toBe(true);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${childId}`) &&
            prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Please check the detail.'),
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('shares explicit Project context across Threads without changing canonical Messages', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const sourceThread = env.createThread('host', 'Context editor');
    const otherExecutorThread = env.runtime.createThread(env.project.id, 'container', 'Container continuation');
    const isolatedProject = await env.runtime.createProject('Separate Project', env.workspace);
    const isolatedThread = env.runtime.createThread(isolatedProject.id, 'host', 'Isolated context');
    const contextText = 'Keep canonical history append-only.\nUse Project Context for decisions shared across Threads.';
    try {
      const saved = await env.runtime.submit(
        sourceThread.id,
        'project-context-set',
        `/project-context set\n${contextText}`,
      );

      expect(saved.command?.text).toContain('Project context saved');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      expect(
        env.store.getPluginState<Record<string, { text: string; revision: number }>>(
          'pico.project-context',
          'byProject',
          {},
        )[env.project.id],
      ).toEqual({ text: contextText, revision: 1 });
      expect(
        env.store
          .listRecords(sourceThread.id)
          .find((record) => record.kind === 'plugin' && record.payload.action === 'project-context.updated')?.payload,
      ).toMatchObject({
        pluginId: 'pico.project-context',
        projectId: env.project.id,
        revision: 1,
        operation: 'set',
        characters: contextText.length,
      });
      expect(
        env.store
          .listRecords(sourceThread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.action === 'project-context.updated' &&
              'text' in record.payload,
          ),
      ).toBe(false);

      await env.runtime.submit(otherExecutorThread.id, 'context-shared-message', 'Use project guidance.');
      await env.runtime.drain();
      const sharedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Use project guidance.'),
      );
      expect(sharedPrompt?.system).toContain(contextText);
      expect(sharedPrompt?.system).toContain('User-maintained Project Context');

      await env.runtime.submit(isolatedThread.id, 'context-isolated-message', 'Check the other Project.');
      await env.runtime.drain();
      const isolatedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the other Project.'),
      );
      expect(isolatedPrompt?.system).not.toContain(contextText);

      const cleared = await env.runtime.submit(sourceThread.id, 'project-context-clear', '/project-context clear');
      expect(cleared.command?.text).toContain('Project context cleared');
      expect(env.store.listRecords(sourceThread.id).filter((record) => record.kind === 'message')).toHaveLength(0);
      await env.runtime.submit(otherExecutorThread.id, 'context-cleared-message', 'Check the updated guidance.');
      await env.runtime.drain();
      const clearedPrompt = model.prompts.find((prompt) =>
        prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Check the updated guidance.'),
      );
      expect(clearedPrompt?.system).not.toContain(contextText);
    } finally {
      await env.cleanup();
    }
  });

  it('loads a local plugin tool, slash command, semantic UI contribution, state, and canonical log', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'note', name: 'save_thread_note', arguments: { note: 'Keep the setup small.' } }])
        : response('Saved.'),
    );
    const env = await setupRuntime(model, { pluginDirectory: resolve(process.cwd(), 'plugins') });
    const thread = env.createThread();
    try {
      expect(env.runtime.pluginInfo().plugins.some((plugin) => plugin.id === 'pico.example-notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'project-context')).toBe(true);
      expect(env.runtime.pluginInfo().ui.some((contribution) => contribution.id === 'pico.example-notes:notes')).toBe(
        true,
      );
      expect(
        env.runtime
          .pluginInfo()
          .ui.some(
            (contribution) =>
              contribution.id === 'pico.project-context:project-context' && contribution.command === '/project-context',
          ),
      ).toBe(true);

      await env.runtime.submit(thread.id, 'plugin-tool-message', 'Save a note');
      await env.runtime.drain();
      expect(
        env.store.getPluginState<Record<string, Array<{ note: string }>>>('pico.example-notes', 'notesByThread', {})[
          thread.id
        ]?.[0]?.note,
      ).toBe('Keep the setup small.');
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.example-notes'),
      ).toBe(true);
      const command = await env.runtime.submit(thread.id, 'plugin-command', '/notes');
      expect(command.command?.text).toContain('Keep the setup small.');
    } finally {
      await env.cleanup();
    }
  });

  it('reports an invalid plugin pipeline stage and rolls back its partial contributions', async () => {
    const invalidPlugin: PicoPlugin = {
      id: 'test.invalid-pipeline-stage',
      name: 'Invalid pipeline stage',
      version: '1',
      activate({ tools, pipelines, ui }) {
        tools.register(
          {
            name: 'partial_plugin_tool',
            description: 'Must be removed when activation fails.',
            parameters: { type: 'object', properties: {} },
          },
          async () => ({ registered: true }),
        );
        ui.contribute({ slot: 'thread.toolbar', id: 'partial', label: 'Partial contribution' });
        pipelines.use('projetion' as never, async (input, next) => next(input));
      },
    };
    const validPlugin: PicoPlugin = {
      id: 'test.valid-after-invalid',
      name: 'Valid after invalid',
      version: '1',
      activate({ pipelines, ui }) {
        pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => next(input));
        ui.contribute({ slot: 'thread.toolbar', id: 'valid', label: 'Valid contribution' });
      },
    };
    const model = new FakeModel(() => response('The remaining plugins loaded.'));
    const env = await setupRuntime(model, { plugins: [invalidPlugin, validPlugin] });
    const thread = env.createThread();
    try {
      const info = env.runtime.pluginInfo();
      expect(info.errors).toContain('test.invalid-pipeline-stage: Unsupported execution pipeline stage: projetion');
      expect(info.plugins.map((plugin) => plugin.id)).toContain('test.valid-after-invalid');
      expect(info.plugins.map((plugin) => plugin.id)).not.toContain('test.invalid-pipeline-stage');
      expect(info.ui.map((contribution) => contribution.id)).toContain('test.valid-after-invalid:valid');
      expect(info.ui.map((contribution) => contribution.id)).not.toContain('test.invalid-pipeline-stage:partial');

      await env.runtime.submit(thread.id, 'plugin-stage-validation-message', 'Check the remaining plugins.');
      await env.runtime.drain();

      expect(model.prompts[0]?.tools.some((tool) => tool.name === 'partial_plugin_tool')).toBe(false);
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('passes frozen projections to plugins while preserving canonical facts', async () => {
    let frozenObserved = false;
    const immutablePlugin: PicoPlugin = {
      id: 'test.immutable-projection',
      name: 'Immutable projection probe',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<any, any>('projection', async (input, next) => {
          frozenObserved = Object.isFrozen(input.records[0]) && Object.isFrozen(input.records[0].payload);
          try {
            input.records[0].payload.content = 'rewritten';
          } catch {
            /* Frozen canonical view rejects writes. */
          }
          return next(input);
        });
      },
    };
    const model = new FakeModel(() => response('Kept intact.'));
    const env = await setupRuntime(model, { plugins: [immutablePlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'immutable-message', 'Original fact');
      await env.runtime.drain();
      expect(frozenObserved).toBe(true);
      expect(
        env.store.listRecords(thread.id).find((record) => record.id === 'immutable-message')?.payload.content,
      ).toBe('Original fact');
      expect(() =>
        env.store.db
          .prepare('UPDATE canonical_records SET payload_json = ? WHERE id = ?')
          .run('{"content":"rewritten"}', 'immutable-message'),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM canonical_records WHERE id = ?').run('immutable-message')).toThrow(
        /append-only/,
      );
      const pluginRecord = env.store.appendPluginRecord(thread.id, 'test.owner', {
        pluginId: 'forged.owner',
        action: 'test',
      });
      expect(pluginRecord.payload.pluginId).toBe('test.owner');
      const logId = (env.store.db.prepare('SELECT id FROM execution_log LIMIT 1').get() as { id: string }).id;
      expect(() =>
        env.store.db.prepare('UPDATE execution_log SET detail_json = ? WHERE id = ?').run('{}', logId),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM execution_log WHERE id = ?').run(logId)).toThrow(/append-only/);
    } finally {
      await env.cleanup();
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
