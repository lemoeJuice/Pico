import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import type { ModelRequestParameters, ModelStreamEvent } from '../src/contracts/model.js';
import type { PluginModelCallRecord } from '../src/contracts/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { deferred, response, setupRuntime, setupTestCatalog } from './helpers.js';

describe('Runtime model provider dispatch', () => {
  it('allows a Thread to be created before a default model is configured and reports it on send', async () => {
    const env = await setupRuntime({
      async complete() {
        return response('unreachable');
      },
    });
    const thread = env.runtime.createThread(env.project.id, 'runtime');
    try {
      expect(env.runtime.threadModelSelection(thread.id).model).toBe('');
      await env.runtime.submit(thread.id, 'unconfigured-model', 'Hello');
      await env.runtime.drain();
      expect(env.runtime.getThread(thread.id)?.pauseRequested).toBe(true);
      expect(env.store.listExecutions(thread.id)).toContainEqual(
        expect.objectContaining({ status: 'failed', error: expect.stringMatching(/choose a model/i) }),
      );
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
    const first = env.createThread('runtime');
    const second = env.createThread('runtime');
    try {
      const firstSelection = env.runtime.threadModelSelection(first.id);
      const newSelection = await env.catalog.addModel('new-default-model');
      env.runtime.updateThreadModelSelection(second.id, {
        ...newSelection,
        parameters: { temperature: 0.9, options: {} },
      });
      expect(env.runtime.threadModelSelection(first.id)).toEqual(firstSelection);
      expect(env.runtime.threadModelSelection(second.id).model).toBe('new-default-model');
      expect(env.runtime.threadModelSelection(second.id).modelId).not.toBe(firstSelection.modelId);

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
    let selection:
      | { modelId: string; adapterId: string; parameters: { options: Record<string, string | number | boolean> } }
      | undefined;
    const provider: PicoPlugin = {
      id: 'test.provider',
      name: 'Test Provider',
      version: '1',
      async activate(context) {
        context.providers.registerType(
          { id: 'provider-disabled', label: 'Provider', addPage: { pluginId: 'test.provider', pageId: 'add' } },
          {
            listModels: async () => [
              {
                id: 'model',
                name: 'test-model',
                label: 'Test',
                protocol: 'openai-chat-completions',
                endpoint: 'https://test.invalid/v1',
                supportsImages: true,
              },
            ],
            authorize: async () => ({}),
          },
        );
        context.models.registerAdapter({
          id: 'adapter-disabled',
          label: 'Adapter',
          match: { providerTypeIds: ['provider-disabled'] },
          controls: [],
          temperature: { supported: true },
        });
        const instance = context.providers.add('provider-disabled', { label: 'Test', config: {} });
        const models = await context.providers.refresh(instance.id);
        selection = { modelId: models[0]!.modelId, adapterId: 'adapter-disabled', parameters: { options: {} } };
      },
    };
    const fake: ModelAdapter = {
      async complete() {
        calls.push('default');
        return response('wrong fallback');
      },
    };
    const env = await setupRuntime(fake, { plugins: [provider] });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateThreadModelSelection(thread.id, selection!);
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

  it('dispatches and records the selected model and request parameters', async () => {
    const observed: Array<{ settings: Parameters<ModelAdapter['complete']>[1]; parameters?: ModelRequestParameters }> =
      [];
    const env = await setupRuntime({
      async complete(_prompt, settings, _signal, _onText, _trace, _onEvent, parameters) {
        observed.push({ settings, ...(parameters ? { parameters } : {}) });
        return response('routed result');
      },
    });
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'routed-request', 'Route this request');
      await env.runtime.drain();
      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]).toMatchObject({
        settings: { model: 'test-model', baseUrl: 'https://test.invalid/v1' },
        parameters: { fields: {}, temperature: 0.7 },
      });
      expect(env.store.modelOutputForThread(thread.id)?.payload).toMatchObject({
        provider: 'pico.test-provider',
        model: 'test-model',
      });
      const invocationFacts = env.store.db
        .prepare(
          "SELECT payload_json FROM canonical_records WHERE scope_key = ? AND payload_json LIKE '%model-invocation:%'",
        )
        .all(`workflow:thread:${thread.id}`) as Array<{ payload_json: string }>;
      expect(invocationFacts.map((row) => row.payload_json).join('\n')).toContain('https://test.invalid/v1');
      expect(invocationFacts.map((row) => row.payload_json).join('\n')).toContain('pico.test-provider');
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
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'unknown-connection', 'Route this request');
      await env.runtime.drain();

      expect(providerCalls).toBe(0);
      expect(
        env.store
          .listExecutions(thread.id)
          .some(
            (execution) => execution.status === 'failed' && execution.error?.includes('target identity do not match'),
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
      modelCalls: true,
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
    const thread = env.createThread('runtime');
    try {
      const selected = await env.catalog.addModel('thread-model');
      env.runtime.updateThreadModelSelection(thread.id, {
        ...selected,
        parameters: { temperature: 0.25, options: {} },
      });
      const request = {
        threadId: thread.id,
        purpose: 'test-summary',
        idempotencyKey: 'stable-call',
        prompt: { system: 'Summarize', turns: [], tools: [], model: '', temperature: 0.2 },
        onEvent: (event: ModelStreamEvent) => {
          if (event.type === 'reasoning_summary.delta') events.push(event.delta);
        },
      };
      const events: string[] = [];
      const first = (await complete!(request)) as { response: ModelResponse };
      const replay = (await complete!(request)) as { response: ModelResponse };

      expect(observed).toHaveLength(1);
      expect(observed[0]?.settings.model).toBe('thread-model');
      expect(observed[0]?.parameters).toEqual({ temperature: 0.25, fields: {} });
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
      modelCalls: true,
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
    const thread = env.createThread('runtime');
    const otherThread = env.createThread('runtime');
    const selection = {
      ...(await env.catalog.addModel('fingerprint-model')),
      parameters: { temperature: 0.3, options: {} },
    };
    const changedSelection = await env.catalog.addModel('changed-selection');
    env.runtime.updateThreadModelSelection(thread.id, selection);
    env.runtime.updateThreadModelSelection(otherThread.id, selection);
    env.store.setPrivateSecret('pico.test', 'credential', 'credential-sentinel');
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
      ).toThrow(/framework model selection/);
      expect(() =>
        complete!({ ...request, requestParameters: { temperature: 0.9, fields: { max_tokens: 64 } } }),
      ).toThrow(/framework model selection/);
      expect(() => complete!({ ...request, signal: new AbortController().signal })).not.toThrow();
      const sameInFlight = complete!(request);
      expect(providerCalls).toBe(1);
      gate.resolve(response('fingerprinted result'));
      const [firstRaw, inFlightRaw] = await Promise.all([first, sameInFlight]);
      const firstResult = firstRaw as { id: string; response: ModelResponse };
      const inFlightResult = inFlightRaw as { response: ModelResponse };
      expect(inFlightResult.response).toEqual(firstResult.response);

      const completed = env.store.findPluginModelCall('test.fingerprinted-call', request.idempotencyKey)!;
      expect(completed.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const factText = JSON.stringify(env.store.listScopedCanonical(`workflow:thread:${thread.id}`));
      expect(factText).toContain(completed.requestFingerprint);
      expect(factText).not.toContain('private-prompt-sentinel');
      expect(factText).not.toContain('credential-sentinel');

      env.runtime.updateThreadModelSelection(thread.id, changedSelection);
      const afterSelectionChange = (await complete!(request)) as { id: string; response: ModelResponse };
      expect(afterSelectionChange.response).toEqual(firstResult.response);
      expect(afterSelectionChange.id).toBe(firstResult.id);
      expect(providerCalls).toBe(1);
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
      await setupTestCatalog(restarted, ['test-model', 'fingerprint-model', 'changed-selection']);
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
        model: 'fingerprint-model',
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
    const thread = env.createThread('runtime');
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
      modelCalls: true,
      activate(context) {
        complete = context.models.complete;
      },
    };
    const env = await setupRuntime(fake, { plugins: [plugin] });
    const thread = env.createThread('runtime');
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
