import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import type { ModelRequestParameters, ModelStreamEvent } from '../src/contracts/model.js';
import type { ModelStageInput } from '../src/runtime/stages.js';
import type { PluginModelCallRecord } from '../src/contracts/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { deferred, response, setupRuntime } from './helpers.js';

describe('Runtime model provider dispatch', () => {
  it('allows a Thread to be created before a default model is configured and reports it on send', async () => {
    const env = await setupRuntime({
      async complete() {
        return response('unreachable');
      },
    });
    env.runtime.updateModelSettings({ model: '' });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      expect(env.runtime.threadModelSelection(thread.id).model).toBe('');
      await env.runtime.submit(thread.id, 'unconfigured-model', 'Hello');
      await env.runtime.drain();
      expect(env.runtime.getThread(thread.id)?.pauseReason).toContain('No model is configured for this Thread');
    } finally {
      await env.cleanup();
    }
  });

  it('pins existing Thread choices when Settings defaults change and rejects unsupported semantic options', async () => {
    const env = await setupRuntime({
      async complete() {
        return response('done');
      },
    });
    const first = env.runtime.createThread(env.project.id, 'runtime');
    const second = env.runtime.createThread(env.project.id, 'runtime');
    try {
      const firstSelection = env.runtime.threadModelSelection(first.id);
      env.runtime.updateModelSettings({ model: 'new-default-model', temperature: 0.9 });
      expect(env.runtime.threadModelSelection(first.id)).toEqual(firstSelection);
      expect(env.runtime.threadModelSelection(second.id)).toEqual(firstSelection);
      expect(env.runtime.publicModelSettings().model).toBe('new-default-model');

      expect(() =>
        env.runtime.updateThreadModelSelection(first.id, {
          ...firstSelection,
          parameters: { temperature: 0.3, options: { madeUpOption: true } },
        }),
      ).toThrow(/option|available|support/i);
      expect(env.runtime.threadModelSelection(first.id)).toEqual(firstSelection);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps a disabled Thread provider unavailable instead of calling the default adapter', async () => {
    const calls: string[] = [];
    const provider: PicoPlugin = {
      id: 'test.provider',
      name: 'Test Provider',
      version: '1',
      activate(context) {
        context.models.registerProvider({ id: 'test-provider', label: 'Test provider' }, async () => {
          calls.push('provider');
          return response('provider result');
        });
      },
    };
    const fake: ModelAdapter = {
      async complete() {
        calls.push('default');
        return response('wrong fallback');
      },
    };
    const env = await setupRuntime(fake, { plugins: [provider] });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      env.runtime.updateThreadModelSelection(thread.id, {
        provider: 'test-provider',
        connectionId: 'default',
        model: 'test-model',
        parameters: { options: {}, temperature: 0.3 },
      });
      await env.runtime.setPluginEnabled('test.provider', false);
      await env.runtime.submit(thread.id, 'disabled-provider', 'Run once');
      await env.runtime.drain();

      expect(calls).toEqual([]);
      expect(env.runtime.getThread(thread.id)?.pauseRequested).toBe(true);
      expect(
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.status === 'failed' && execution.error?.includes('unavailable')),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('dispatches and records the model pipeline final target and request parameters', async () => {
    const observed: Array<{
      target: ModelStageInput['modelTarget'];
      prompt: ModelPrompt;
      parameters?: ModelRequestParameters;
    }> = [];
    const provider: PicoPlugin = {
      id: 'test.router',
      name: 'Test Router',
      version: '1',
      activate(context) {
        context.models.registerProvider({ id: 'routed-provider', label: 'Routed provider' }, async (input) => {
          observed.push({
            target: input.modelTarget,
            prompt: input.prompt,
            ...(input.requestParameters ? { parameters: input.requestParameters } : {}),
          });
          return { ...response('routed result'), model: input.prompt.model };
        });
        context.pipelines.use('model', async (input, next) =>
          next({
            ...input,
            provider: 'routed-provider',
            modelTarget: {
              provider: 'routed-provider',
              connectionId: 'default',
              baseUrl: 'https://models.example.test/v1',
              model: 'routed-model',
            },
            prompt: { ...input.prompt, model: 'routed-model' },
            requestParameters: { fields: { reasoning_effort: 'high' }, temperature: 0.4 },
          }),
        );
      },
    };
    const env = await setupRuntime(
      {
        async complete() {
          throw new Error('The default adapter must not run.');
        },
      },
      { plugins: [provider] },
    );
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      await env.runtime.submit(thread.id, 'routed-request', 'Route this request');
      await env.runtime.drain();

      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]).toMatchObject({
        target: {
          provider: 'routed-provider',
          connectionId: 'default',
          baseUrl: 'https://models.example.test/v1',
          model: 'routed-model',
        },
        prompt: { model: 'routed-model' },
        parameters: { fields: { reasoning_effort: 'high' }, temperature: 0.4 },
      });
      expect(env.store.modelOutputForThread(thread.id)?.payload).toMatchObject({
        provider: 'routed-provider',
        model: 'routed-model',
      });
      const invocationFacts = env.store.db
        .prepare(
          "SELECT payload_json FROM canonical_records WHERE scope_key = ? AND payload_json LIKE '%model-invocation:%'",
        )
        .all(`workflow:thread:${thread.id}`) as Array<{ payload_json: string }>;
      expect(invocationFacts.map((row) => row.payload_json).join('\n')).toContain('https://models.example.test/v1');
      expect(invocationFacts.map((row) => row.payload_json).join('\n')).toContain('routed-provider');
    } finally {
      await env.cleanup();
    }
  });

  it('rejects a pipeline target with an unknown connection before dispatch or invocation facts', async () => {
    let providerCalls = 0;
    const provider: PicoPlugin = {
      id: 'test.connection-router',
      name: 'Test Connection Router',
      version: '1',
      activate(context) {
        context.models.registerProvider({ id: 'routed-provider', label: 'Routed provider' }, async () => {
          providerCalls += 1;
          return response('must not be called');
        });
        context.pipelines.use('model', async (input, next) =>
          next({
            ...input,
            provider: 'routed-provider',
            modelTarget: {
              provider: 'routed-provider',
              connectionId: 'route-a',
              baseUrl: 'https://models.example.test/v1',
              model: 'routed-model',
            },
          }),
        );
      },
    };
    const env = await setupRuntime(
      {
        async complete() {
          providerCalls += 1;
          return response('default adapter must not be called');
        },
      },
      { plugins: [provider] },
    );
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      await env.runtime.submit(thread.id, 'unknown-connection', 'Route this request');
      await env.runtime.drain();

      expect(providerCalls).toBe(0);
      expect(
        env.store
          .listExecutions(thread.id)
          .some(
            (execution) =>
              execution.status === 'failed' && execution.error?.includes('model connection is unavailable'),
          ),
      ).toBe(true);
      const invocationFacts = env.store.db
        .prepare(
          "SELECT payload_json FROM canonical_records WHERE scope_key = ? AND payload_json LIKE '%model-invocation:%'",
        )
        .all(`workflow:thread:${thread.id}`) as Array<{ payload_json: string }>;
      expect(invocationFacts).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it('uses Thread selection for auxiliary calls and replays completed idempotency keys', async () => {
    const observed: Array<{ settings: Parameters<ModelAdapter['complete']>[1]; parameters?: ModelRequestParameters }> =
      [];
    let complete:
      | ((request: {
          threadId: string;
          purpose: string;
          idempotencyKey: string;
          prompt: ModelPrompt;
          modelTarget?: { provider: string; connectionId?: string; model?: string };
          requestParameters?: ModelRequestParameters;
          onEvent?: (event: ModelStreamEvent) => void;
        }) => Promise<unknown>)
      | undefined;
    const plugin: PicoPlugin = {
      id: 'test.auxiliary',
      name: 'Test Auxiliary',
      version: '1',
      activate(context) {
        complete = context.models.complete;
      },
    };
    const fake: ModelAdapter = {
      async complete(_prompt, settings, _signal, _onText, _trace, onEvent, parameters) {
        observed.push({ settings, ...(parameters ? { parameters } : {}) });
        onEvent?.({ type: 'reasoning_summary.delta', delta: 'event delivered' });
        return { ...response('summary'), model: settings.model };
      },
    };
    const env = await setupRuntime(fake, { plugins: [plugin] });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      env.runtime.updateThreadModelSelection(thread.id, {
        provider: 'openai-compatible',
        connectionId: 'default',
        model: 'thread-model',
        parameters: { temperature: 0.25, options: {} },
      });
      const request = {
        threadId: thread.id,
        purpose: 'test-summary',
        idempotencyKey: 'stable-call',
        prompt: { system: 'Summarize', turns: [], tools: [], model: '', temperature: 0.2 },
        requestParameters: { temperature: 0.7, fields: { max_tokens: 32 } },
        onEvent: (event: ModelStreamEvent) => {
          if (event.type === 'reasoning_summary.delta') events.push(event.delta);
        },
      };
      const events: string[] = [];
      const first = (await complete!(request)) as { response: ModelResponse };
      const replay = (await complete!(request)) as { response: ModelResponse };

      expect(observed).toHaveLength(1);
      expect(observed[0]?.settings.model).toBe('thread-model');
      expect(observed[0]?.parameters).toEqual({ temperature: 0.7, fields: { max_tokens: 32 } });
      expect(events).toEqual(['event delivered']);
      expect(replay.response).toEqual(first.response);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      expect(env.store.listExecutions(thread.id).filter((execution) => execution.kind === 'tool')).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  it('binds idempotency keys to the full request across concurrency, rebuild, and restart', async () => {
    const gate = deferred<ModelResponse>();
    const started = deferred<void>();
    let providerCalls = 0;
    let complete:
      | ((request: {
          threadId: string;
          purpose: string;
          idempotencyKey: string;
          prompt: ModelPrompt;
          modelTarget?: { provider: string; connectionId?: string; model?: string };
          requestParameters?: ModelRequestParameters;
          signal?: AbortSignal;
          onEvent?: (event: ModelStreamEvent) => void;
        }) => Promise<unknown>)
      | undefined;
    const plugin: PicoPlugin = {
      id: 'test.fingerprinted-call',
      name: 'Test Fingerprinted Call',
      version: '1',
      activate(context) {
        complete = context.models.complete;
      },
    };
    const fake: ModelAdapter = {
      async complete() {
        providerCalls += 1;
        started.resolve();
        return gate.promise;
      },
    };
    const env = await setupRuntime(fake, { plugins: [plugin] });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    const otherThread = env.runtime.createThread(env.project.id, 'runtime');
    const selection = {
      provider: 'openai-compatible',
      connectionId: 'default',
      model: 'fingerprint-model',
      parameters: { temperature: 0.3, options: {} },
    };
    env.runtime.updateThreadModelSelection(thread.id, selection);
    env.runtime.updateThreadModelSelection(otherThread.id, selection);
    env.runtime.updateModelSettings({ apiKey: 'credential-sentinel' });
    const request = {
      threadId: thread.id,
      purpose: 'fingerprint-review',
      idempotencyKey: 'fingerprint-key',
      prompt: { system: 'private-prompt-sentinel', turns: [], tools: [], model: '', temperature: 0.2 },
    };
    let restarted: PicoRuntime | undefined;
    try {
      const first = complete!(request);
      await started.promise;
      expect(() => complete!({ ...request, threadId: otherThread.id })).toThrow(/different request/);
      expect(() => complete!({ ...request, prompt: { ...request.prompt, system: 'changed prompt' } })).toThrow(
        /different request/,
      );
      expect(() => complete!({ ...request, purpose: 'different-purpose' })).toThrow(/different request/);
      expect(() =>
        complete!({
          ...request,
          modelTarget: { provider: 'openai-compatible', connectionId: 'default', model: 'different-model' },
        }),
      ).toThrow(/different request/);
      expect(() =>
        complete!({ ...request, requestParameters: { temperature: 0.9, fields: { max_tokens: 64 } } }),
      ).toThrow(/different request/);
      expect(() => complete!({ ...request, signal: new AbortController().signal })).not.toThrow();
      const sameInFlight = complete!(request);
      expect(providerCalls).toBe(1);
      gate.resolve(response('fingerprinted result'));
      const [firstRaw, inFlightRaw] = await Promise.all([first, sameInFlight]);
      const firstResult = firstRaw as { response: ModelResponse };
      const inFlightResult = inFlightRaw as { response: ModelResponse };
      expect(inFlightResult.response).toEqual(firstResult.response);

      const completed = env.store.findPluginModelCall('test.fingerprinted-call', request.idempotencyKey)!;
      expect(completed.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const factText = JSON.stringify(env.store.listScopedCanonical(`workflow:thread:${thread.id}`));
      expect(factText).toContain(completed.requestFingerprint);
      expect(factText).not.toContain('private-prompt-sentinel');
      expect(factText).not.toContain('credential-sentinel');

      env.runtime.updateThreadModelSelection(thread.id, { ...selection, model: 'changed-selection' });
      expect(() => complete!(request)).toThrow(/different request/);
      env.runtime.updateThreadModelSelection(thread.id, selection);
      expect(((await complete!(request)) as { response: ModelResponse }).response).toEqual(firstResult.response);
      expect(providerCalls).toBe(1);

      await env.runtime.shutdown();
      env.store.rebuildWorkflowViews();
      restarted = new PicoRuntime(env.store, {
        model: fake,
        plugins: [plugin],
        pluginDirectory: `${env.directory}/empty-plugins`,
      });
      await restarted.initialize();
      expect(((await complete!(request)) as { response: ModelResponse }).response).toEqual(firstResult.response);
      expect(() => complete!({ ...request, purpose: 'after-restart-mismatch' })).toThrow(/different request/);
      expect(providerCalls).toBe(1);

      env.store.savePluginModelCall({
        id: 'legacy-completed-call',
        pluginId: 'test.fingerprinted-call',
        idempotencyKey: 'legacy-key',
        requestFingerprint: null,
        threadId: thread.id,
        projectId: thread.projectId,
        purpose: request.purpose,
        provider: 'openai-compatible',
        model: selection.model,
        prompt: null,
        status: 'completed',
        response: response('legacy result'),
        usage: null,
        attempts: [],
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      expect(() => complete!({ ...request, idempotencyKey: 'legacy-key' })).toThrow(/identity is unavailable/);
    } finally {
      await restarted?.shutdown();
      await env.cleanup();
    }
  });

  it('recovers an orphaned auxiliary running call as interrupted without invoking a provider', async () => {
    let providerCalls = 0;
    const fake: ModelAdapter = {
      async complete() {
        providerCalls += 1;
        return response('must not run');
      },
    };
    const env = await setupRuntime(fake);
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    const now = new Date().toISOString();
    const running: PluginModelCallRecord = {
      id: 'orphaned-call',
      pluginId: 'test.reviewer',
      idempotencyKey: 'orphaned-key',
      threadId: thread.id,
      projectId: thread.projectId,
      purpose: 'review',
      provider: 'openai-compatible',
      model: 'test-model',
      prompt: { system: '', turns: [], tools: [], model: 'test-model', temperature: 0.2 },
      status: 'running',
      response: null,
      usage: null,
      attempts: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    let restarted: PicoRuntime | null = null;
    try {
      env.store.savePluginModelCall(running);
      await env.runtime.shutdown();
      restarted = new PicoRuntime(env.store, { model: fake, pluginDirectory: `${env.directory}/empty-plugins` });
      await restarted.initialize();

      expect(env.store.findPluginModelCall('test.reviewer', 'orphaned-key')).toMatchObject({
        status: 'interrupted',
        error: expect.stringContaining('Runtime restarted'),
      });
      expect(providerCalls).toBe(0);
    } finally {
      await restarted?.shutdown();
      await env.cleanup();
    }
  });

  it('cancels auxiliary provider work through the shared model call kernel', async () => {
    let onProviderStart: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      onProviderStart = resolve;
    });
    const fake: ModelAdapter = {
      async complete(_prompt, _settings, signal) {
        onProviderStart?.();
        return new Promise<ModelResponse>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
    };
    let complete:
      | ((request: {
          threadId: string;
          purpose: string;
          idempotencyKey: string;
          prompt: ModelPrompt;
          signal?: AbortSignal;
        }) => Promise<unknown>)
      | undefined;
    const plugin: PicoPlugin = {
      id: 'test.auxiliary-cancel',
      name: 'Test Auxiliary Cancellation',
      version: '1',
      activate(context) {
        complete = context.models.complete;
      },
    };
    const env = await setupRuntime(fake, { plugins: [plugin] });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    const controller = new AbortController();
    try {
      const pending = complete!({
        threadId: thread.id,
        purpose: 'test-cancel',
        idempotencyKey: 'cancelled-call',
        prompt: { system: '', turns: [], tools: [], model: '', temperature: 0.2 },
        signal: controller.signal,
      });
      await providerStarted;
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(env.store.findPluginModelCall('test.auxiliary-cancel', 'cancelled-call')).toMatchObject({
        status: 'interrupted',
        error: expect.stringContaining('AbortError'),
      });
    } finally {
      await env.cleanup();
    }
  });
});
