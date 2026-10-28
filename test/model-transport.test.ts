import { describe, expect, it, vi } from 'vitest';
import { executeModelRequest } from '../src/runtime/model-transport.js';
import { ResponsesModelAdapter } from '../src/runtime/responses-model.js';
import { OpenAiCompatibleAdapter } from '../src/runtime/model.js';
import type { ModelPrompt } from '../src/contracts/model.js';

const prompt: ModelPrompt = { system: 'system', turns: [], tools: [], model: 'test', temperature: 1 };
const trace = () => ({ started: vi.fn(() => 'id'), response: vi.fn(), settled: vi.fn() });

describe('shared model transport', () => {
  it('settles every fetch once and shares the retry budget across a refresh', async () => {
    const log = trace();
    const token = vi.fn(async (_signal: AbortSignal, refresh: boolean) => (refresh ? 'refreshed' : 'initial'));
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      executeModelRequest({
        endpoint: 'https://example.test/responses',
        provider: 'test',
        protocol: 'responses',
        body: '{}',
        headers: {},
        signal: new AbortController().signal,
        trace: log,
        authorization: { accessToken: token, refreshOnUnauthorized: true },
        fetcher,
        fetchRetries: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('fetch failed');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(token).toHaveBeenCalledTimes(2);
    expect(log.started).toHaveBeenCalledTimes(3);
    expect(log.response).toHaveBeenCalledTimes(1);
    expect(log.settled.mock.calls.map((call) => call[1].outcome)).toEqual(['retrying', 'retrying', 'failed']);
  });

  it('reports end-to-end throughput only with known output tokens and duration', async () => {
    const log = trace();
    const request = await executeModelRequest({
      endpoint: 'https://example.test',
      provider: 'test',
      protocol: 'responses',
      body: '{}',
      headers: {},
      signal: new AbortController().signal,
      trace: log,
      fetcher: vi.fn(async () => new Response('ok')),
    });
    request.settle({ outcome: 'completed', durationMs: 2000, firstTextMs: 500, usage: { outputTokens: 12 } });
    request.settle({ outcome: 'failed', durationMs: 2 });
    expect(log.settled).toHaveBeenCalledTimes(1);
    expect(log.settled.mock.calls[0]?.[1].outputTokensPerSecond).toBe(6);
    const withoutUsage = await executeModelRequest({
      endpoint: 'https://example.test',
      provider: 'test',
      protocol: 'responses',
      body: '{}',
      headers: {},
      signal: new AbortController().signal,
      trace: log,
      fetcher: vi.fn(async () => new Response('ok')),
    });
    withoutUsage.settle({ outcome: 'completed', durationMs: 2000, usage: null });
    expect(log.settled.mock.calls[1]?.[1].outputTokensPerSecond).toBeUndefined();
  });

  it('uses a configured Responses endpoint and API key without automatic retries', async () => {
    const log = trace();
    const fetcher = vi.fn(
      async (_input: string | URL | Request) =>
        new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const adapter = new ResponsesModelAdapter({
      endpoint: 'https://example.test/custom',
      provider: 'other',
      authorization: { accessToken: async () => 'example-key' },
      fetcher,
    });
    const result = await adapter.complete(prompt, new AbortController().signal, () => {}, log);
    expect(result.content).toBe('');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://example.test/custom');
    expect(log.settled).toHaveBeenCalledTimes(1);
    expect(log.settled.mock.calls[0]?.[1].outcome).toBe('completed');
  });

  it('settles chat parsing errors and HTTP errors', async () => {
    const original = globalThis.fetch;
    try {
      for (const response of [
        new Response('bad', { status: 500 }),
        new Response('bad', { headers: { 'content-type': 'application/json' } }),
      ]) {
        globalThis.fetch = vi.fn(async () => response);
        const log = trace();
        await expect(
          new OpenAiCompatibleAdapter().complete(
            prompt,
            { provider: 'test', baseUrl: 'https://example.test', apiKey: '' } as never,
            new AbortController().signal,
            () => {},
            log,
          ),
        ).rejects.toThrow();
        expect(log.started).toHaveBeenCalledTimes(1);
        expect(log.response).toHaveBeenCalledTimes(1);
        expect(log.settled).toHaveBeenCalledTimes(1);
        expect(log.settled.mock.calls[0]?.[1].outcome).toBe('failed');
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
