import { describe, expect, it } from 'vitest';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import type { Thread } from '../src/core/types.js';
import { CommandRegistry, type PluginContext } from '../src/plugins/host.js';
import { createChatGptPlanPlugin } from '../src/plugins/chatgpt-plan.js';
import type { ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import type { ModelStageInput } from '../src/runtime/stages.js';

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
      tools: { register: () => undefined },
      models: { registerProvider: (provider) => providers.push(provider) },
      pipelines: { use: (stage, interceptor) => pipelines.use(stage, plugin.id, interceptor) },
      commands: { register: (command) => commands.register(plugin.id, command) },
      ui: {
        contribute: (contribution) => contributions.push(contribution),
        registerPage: (page) => pages.push(page),
      },
      http: { register: (method, path) => routes.push(`${method} ${path}`) },
      state: {
        get: (key, fallback) => (state.has(key) ? (state.get(key) as typeof fallback) : fallback),
        set: (key, value) => void state.set(key, value),
      },
      canonical: { append: () => ({}) as never, list: () => [] },
    };
    await plugin.activate(context);

    expect(providers).toContainEqual(expect.objectContaining({ id: 'chatgpt-plan' }));
    expect(pages).toContainEqual(expect.objectContaining({ id: 'account', entry: 'webui' }));
    expect(contributions).toContainEqual(
      expect.objectContaining({ slot: 'composer.model', component: 'ChatGptPlanComposerModel', entry: 'webui' }),
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        'GET /status',
        'GET /models',
        'POST /models/refresh',
        'POST /sign-in',
        'PUT /preferences',
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
