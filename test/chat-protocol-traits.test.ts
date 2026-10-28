import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleAdapter } from '../src/runtime/model.js';
import type { ModelPrompt } from '../src/contracts/model.js';

const prompt: ModelPrompt = {
  model: 'any-name',
  system: '',
  temperature: 1,
  tools: [],
  turns: [{ kind: 'message', role: 'assistant', content: 'answer', reasoningContent: 'prior' }],
};
const settings = { provider: 'test', baseUrl: 'https://example.test', apiKey: 'fallback' } as never;

describe('chat-completions adapter traits', () => {
  it('uses explicit reasoning and cache traits independent of model name', async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok', reasoning_content: 'reason' }, finish_reason: 'stop' }],
            usage: { prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetcher;
    try {
      const adapter = new OpenAiCompatibleAdapter();
      const result = await adapter.complete(
        prompt,
        settings,
        new AbortController().signal,
        () => {},
        undefined,
        undefined,
        undefined,
        {
          protocolTraits: { reasoningContent: true, cacheHitMissUsage: true },
          authorize: async () => ({ Authorization: 'Bearer injected' }),
        },
      );
      const request = fetcher.mock.calls[0]![1]!;
      expect(request.redirect).toBe('error');
      const messages = JSON.parse(String(request.body)).messages;
      expect(messages[1].reasoning_content).toBe('prior');
      expect(new Headers(request.headers).get('authorization')).toBe('Bearer injected');
      expect(result.reasoningContent).toBe('reason');
      expect(result.usage).toMatchObject({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 });
      const generic = await adapter.complete(
        { ...prompt, model: 'deepseek' },
        settings,
        new AbortController().signal,
        () => {},
      );
      expect(generic.reasoningContent).toBeUndefined();
      expect(generic.usage).toEqual({ outputTokens: 2 });
      expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).messages[1].reasoning_content).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
