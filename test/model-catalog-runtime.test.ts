import { describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import type { PluginContext } from '../src/plugins/host.js';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';
import type { ModelResponse } from '../src/contracts/model.js';

describe('framework model configuration', () => {
  it('uses a plugin fixed selection, replays after that selection disappears, and isolates waiter cancellation', async () => {
    let complete!: PluginContext['models']['complete'];
    const pending = deferred<ModelResponse>();
    const model = new FakeModel(() => pending.promise);
    const env = await setupRuntime(model, {
      plugins: [
        {
          id: 'test.aux',
          name: 'Auxiliary',
          version: '1',
          modelCalls: true,
          activate(context) {
            complete = context.models.complete;
          },
        },
      ],
    });
    try {
      const thread = env.createThread('runtime');
      const fixed = await env.catalog.addModel('aux-model');
      env.runtime.updatePluginModelSelection('test.aux', { mode: 'fixed', selection: fixed });
      const request = {
        threadId: thread.id,
        purpose: 'summary',
        idempotencyKey: 'once',
        prompt: { system: 'Summarize', turns: [], tools: [], model: '', temperature: 0 },
      };
      const first = complete(request);
      const waiter = new AbortController();
      const duplicate = complete({ ...request, signal: waiter.signal });
      waiter.abort();
      await expect(duplicate).rejects.toHaveProperty('name', 'AbortError');
      expect(model.signals[0]?.aborted).not.toBe(true);
      pending.resolve({ ...response('summary'), model: 'aux-model' });
      const result = await first;
      expect(model.prompts[0]?.model).toBe('aux-model');
      expect(model.calls).toBe(1);
      env.runtime.modelCatalog.removeOwner('pico.test');
      expect(env.runtime.pluginModelSelectionsView()['test.aux']?.selection).toHaveProperty('unavailableReason');
      expect((await complete(request)).id).toBe(result.id);
      expect(model.calls).toBe(1);
      expect(() => complete({ ...request, prompt: { ...request.prompt, system: 'Different' } })).toThrow(
        'different request',
      );
    } finally {
      await env.cleanup();
    }
  });

  it('rejects adapter wire fields that would override the selected model before invoking a model', async () => {
    const model = new FakeModel(() => response('must not run'));
    const env = await setupRuntime(model);
    try {
      env.runtime.modelCatalog.registerAdapter('pico.test', {
        id: 'test.bad-wire',
        label: 'Invalid',
        match: {},
        controls: [],
        temperature: { supported: true },
        serialize: () => ({ fields: { model: 'other-model' } }),
      });
      const thread = env.createThread('runtime');
      env.runtime.updateThreadModelSelection(thread.id, { ...env.catalog.select(), adapterId: 'test.bad-wire' });
      await env.runtime.submitUserMessage(thread.id, 'wire-override', 'Hello');
      await env.runtime.drain();
      expect(model.calls).toBe(0);
      expect(env.store.listExecutions(thread.id)).toContainEqual(expect.objectContaining({ status: 'failed' }));
    } finally {
      await env.cleanup();
    }
  });

  it('uses framework Responses HTTP for main calls, preserves compatible replay, and records server metrics', async () => {
    const store = new PicoStore(':memory:');
    const runtime = new PicoRuntime(store, { pluginDirectory: '/tmp/pico-no-model-plugins' });
    const bodies: Array<Record<string, unknown>> = [];
    const headers: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers).get('authorization') ?? '');
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Response(
        JSON.stringify({
          id: 'response',
          status: 'completed',
          model: 'responses-model-server-alias',
          output: [
            { type: 'reasoning', id: 'r1', encrypted_content: 'synthetic-opaque' },
            { type: 'message', content: [{ type: 'output_text', text: 'Answer' }] },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await runtime.initialize();
      runtime.modelCatalog.registerProviderType(
        'test.responses',
        { id: 'responses', label: 'Responses', addPage: { pluginId: 'test.responses', pageId: 'add' } },
        {
          listModels: async () => [
            {
              id: 'responses-model',
              name: 'responses-model',
              label: 'Responses',
              protocol: 'openai-responses',
              supportsImages: true,
              endpoint: 'https://model.invalid/v1/responses',
            },
          ],
          authorize: async () => ({ authorization: 'Bearer synthetic-local-canary' }),
        },
      );
      runtime.modelCatalog.registerAdapter('test.responses', {
        id: 'responses-adapter',
        label: 'Responses',
        match: { protocols: ['openai-responses'] },
        controls: [],
        temperature: { supported: false },
        replayFormat: 'openai-responses',
      });
      const instance = runtime.modelCatalog.addInstance('test.responses', 'responses', {
        label: 'Responses',
        config: {},
      });
      const [model] = await runtime.modelCatalog.refreshInstance(instance.id);
      const project = await runtime.createProject('Responses', '/tmp');
      const thread = runtime.createThread(project.id, 'runtime');
      expect(runtime.threadModelSelection(thread.id).modelId).toBe('');
      runtime.updateThreadModelSelection(thread.id, {
        modelId: model!.modelId,
        adapterId: 'responses-adapter',
        parameters: { options: {} },
      });
      await runtime.submitUserMessage(thread.id, 'first', 'First');
      await runtime.drain();
      await runtime.submitUserMessage(thread.id, 'second', 'Next');
      await runtime.drain();
      expect(fetcher.mock.calls.length, JSON.stringify(store.listExecutions(thread.id))).toBe(2);
      expect(headers).toEqual(['Bearer synthetic-local-canary', 'Bearer synthetic-local-canary']);
      expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'r1' }));
      expect(bodies[0]?.model).toBe('responses-model');
      const execution = store
        .listExecutions(thread.id)
        .filter((item) => item.kind === 'model')
        .at(-1)!;
      const requests =
        runtime.getModelInputAttempts(thread.id, execution.id)?.flatMap((item) => item.providerRequests ?? []) ?? [];
      expect(requests).toContainEqual(
        expect.objectContaining({ outcome: 'completed', outputTokensPerSecond: expect.any(Number) }),
      );
      expect(JSON.stringify(runtime.getSnapshot(thread.id))).not.toContain('synthetic-local-canary');
      expect(JSON.stringify(runtime.getSnapshot(thread.id))).not.toContain('synthetic-opaque');
      const otherInstance = runtime.modelCatalog.addInstance('test.responses', 'responses', {
        label: 'Other account',
        config: {},
      });
      const [otherModel] = await runtime.modelCatalog.refreshInstance(otherInstance.id);
      runtime.updateThreadModelSelection(thread.id, {
        modelId: otherModel!.modelId,
        adapterId: 'responses-adapter',
        parameters: { options: {} },
      });
      await runtime.submitUserMessage(thread.id, 'third', 'Switch account');
      await runtime.drain();
      expect(bodies[2]?.input).not.toContainEqual(expect.objectContaining({ type: 'reasoning' }));
    } finally {
      await runtime.shutdown();
      store.close();
      vi.unstubAllGlobals();
    }
  });
});
