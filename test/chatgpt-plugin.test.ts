import { describe, expect, it, vi } from 'vitest';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import type { ModelSettings, Thread } from '../src/core/types.js';
import { CommandRegistry, type PluginContext } from '../src/plugins/host.js';
import { createChatGptPlanPlugin } from '../src/plugins/chatgpt-plan.js';
import type { ModelAdapter, ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import type { ModelStageInput } from '../src/runtime/stages.js';

describe('ChatGPT provider plugin', () => {
  it('routes only selected ChatGPT model calls and contributes its command and toolbar action', async () => {
    const prompt: ModelPrompt = {
      system: 'system',
      turns: [],
      tools: [],
      model: 'gpt-test',
      temperature: 0.3,
    };
    const settings: ModelSettings = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-test',
      temperature: 0.3,
      provider: 'chatgpt-plan',
      reasoningEffort: 'auto',
      fastMode: false,
    };
    const response: ModelResponse = {
      content: 'From ChatGPT',
      toolCalls: [],
      usage: null,
      model: 'gpt-test',
      finishReason: 'stop',
    };
    const complete = vi.fn<ModelAdapter['complete']>(async () => response);
    const plugin = createChatGptPlanPlugin({
      auth: { status: () => ({ connected: true, accountLabel: 'person@example.test' }) },
      model: { complete },
      getSettings: () => settings,
    });
    const pipelines = new ExecutionPipelines();
    const commands = new CommandRegistry();
    const contributions: PluginContext extends { ui: { contribute(value: infer T): void } } ? T[] : never[] = [];
    const context: PluginContext = {
      tools: { register: () => undefined },
      pipelines: {
        use: (stage, interceptor) => pipelines.use(stage, plugin.id, interceptor),
      },
      commands: { register: (command) => commands.register(plugin.id, command) },
      ui: { contribute: (contribution) => contributions.push(contribution) },
      state: {
        get: (_key, fallback) => fallback,
        set: () => undefined,
      },
      canonical: { append: () => ({}) as never, list: () => [] },
    };
    plugin.activate(context);

    const recorded: Array<[ModelPrompt, ModelStageInput['provider']]> = [];
    const input = (provider: ModelStageInput['provider']): ModelStageInput => ({
      thread: {} as Thread,
      provider,
      prompt,
      signal: new AbortController().signal,
      onText: vi.fn(),
      recordModelInput: (actualPrompt, actualProvider) => recorded.push([actualPrompt, actualProvider]),
    });

    const defaultResult = await pipelines.run<ModelStageInput, ModelResponse>(
      'model',
      input('openai-compatible'),
      async () => ({ ...response, content: 'Default adapter' }),
    );
    const chatGptResult = await pipelines.run<ModelStageInput, ModelResponse>(
      'model',
      input('chatgpt-plan'),
      async () => {
        throw new Error('ChatGPT plugin should short-circuit to its provider adapter.');
      },
    );

    expect(defaultResult.content).toBe('Default adapter');
    expect(chatGptResult.content).toBe('From ChatGPT');
    expect(complete).toHaveBeenCalledWith(prompt, settings, expect.any(AbortSignal), expect.any(Function));
    expect(recorded).toEqual([[prompt, 'chatgpt-plan']]);
    expect(await commands.execute('/chatgpt-provider', { thread: null, projectId: null })).toEqual({
      text: 'ChatGPT account connected as person@example.test.',
    });
    expect(contributions).toContainEqual(
      expect.objectContaining({ slot: 'thread.toolbar', command: '/chatgpt-provider' }),
    );
  });
});
