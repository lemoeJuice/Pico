import { unavailablePluginServices } from '../../../plugins/services.js';
import { describe, expect, it } from 'vitest';
import { ExecutionPipelines } from '../../../core/pipeline.js';
import type { Thread } from '../../../core/types.js';
import { CommandRegistry, type PluginContext } from '../../../plugins/host.js';
import { createChatGptPlanPlugin } from '../../../plugins/chatgpt-plan.js';
import type { ModelPrompt, ModelResponse } from '../../../runtime/model.js';
import type { ModelStageInput } from '../../../runtime/stages.js';

describe('ChatGPT provider plugin', () => {
  it('registers provider, model pipeline, account page, composer contribution, command and routes', async () => {
    const plugin = createChatGptPlanPlugin();
    const pipelines = new ExecutionPipelines();
    const commands = new CommandRegistry();
    const contributions: unknown[] = [];
    const pages: unknown[] = [];
    const providers: unknown[] = [];
    const routes: string[] = [];
    const state = new Map<string, unknown>();
    const context: PluginContext = {
      ...unavailablePluginServices,
      threads: {
        ...unavailablePluginServices.threads,
        updateTitle: () => {
          throw new Error('not used by this test');
        },
      },
      tools: { register: () => undefined },
      models: {
        complete: async () => {
          throw new Error('not used by this test');
        },
        history: () => [],
        subscribe: () => () => undefined,
        registerProvider: (provider, handler) => providers.push({ provider, handler: typeof handler }),
        registerSelectionNormalizer: () => undefined,
      },
      continuations: { register: () => () => undefined },
      pipelines: { use: (stage, interceptor) => pipelines.use(stage, plugin.id, interceptor) },
      commands: { register: (command) => commands.register(plugin.id, command) },
      ui: {
        contribute: (contribution) => contributions.push(contribution),
        registerPage: (page) => pages.push(page),
        invalidate: () => undefined,
      },
      http: { register: (method, path) => routes.push(`${method} ${path}`) },
      state: {
        get: (key, fallback) => (state.has(key) ? (state.get(key) as typeof fallback) : fallback),
        set: (key, value) => void state.set(key, value),
        transaction: (run) => run(),
        subscribe: () => () => undefined,
      },
      cache: {
        get: (key, fallback) => (state.has(`cache:${key}`) ? (state.get(`cache:${key}`) as typeof fallback) : fallback),
        set: (key, value) => void state.set(`cache:${key}`, value),
      },
      secrets: {
        get: (key, fallback) =>
          state.has(`secret:${key}`) ? (state.get(`secret:${key}`) as typeof fallback) : fallback,
        set: (key, value) => void state.set(`secret:${key}`, value),
        delete: (key) => void state.delete(`secret:${key}`),
      },
      canonical: { append: () => ({}) as never, list: () => [], read: () => [], subscribe: () => () => undefined },
    };
    await plugin.activate?.(context);

    expect(providers).toContainEqual({
      provider: expect.objectContaining({ id: 'chatgpt-plan' }),
      handler: 'function',
    });
    expect(pages).toContainEqual(expect.objectContaining({ id: 'account', entry: 'webui' }));
    expect(contributions).toContainEqual(
      expect.objectContaining({
        slot: 'composer.model',
        component: 'ChatGptPlanComposerModel',
        entry: 'webui',
        providers: ['chatgpt-plan'],
      }),
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /status',
        'GET /models',
        'POST /models/refresh',
        'POST /sign-in',
        'POST /sign-in/complete',
        'POST /sign-in/retry',
        'DELETE /account',
      ]),
    );
    expect(await commands.execute('/chatgpt-provider', { thread: null, projectId: null })).toEqual({
      text: 'No ChatGPT account is connected. Open the ChatGPT plugin settings to connect one.',
    });

    const prompt: ModelPrompt = { system: '', turns: [], tools: [], model: 'test', temperature: 0.2 };
    const input: ModelStageInput = {
      thread: {} as Thread,
      provider: 'openai-compatible',
      prompt,
      signal: new AbortController().signal,
      onText: () => undefined,
      recordModelInput: () => undefined,
    };
    const fallback: ModelResponse = {
      content: 'fallback',
      toolCalls: [],
      usage: null,
      model: 'test',
      finishReason: 'stop',
    };
    await expect(pipelines.run<ModelStageInput, ModelResponse>('model', input, async () => fallback)).resolves.toBe(
      fallback,
    );
  });
});
