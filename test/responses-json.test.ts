import { describe, expect, it, vi } from 'vitest';
import { ResponsesModelAdapter } from '../src/runtime/responses-model.js';
import type { ModelPrompt } from '../src/contracts/model.js';
const prompt: ModelPrompt = { model: 'model', system: '', turns: [], tools: [], temperature: 1 };
const trace = () => ({ started: vi.fn(() => 'attempt'), response: vi.fn(), settled: vi.fn() });

describe('Responses JSON', () => {
  it('normalizes completed output and replay without inventing a streaming first-text time', async () => {
    const log = trace();
    const onText = vi.fn();
    const adapter = new ResponsesModelAdapter({
      endpoint: 'https://example.test/v1/responses',
      provider: 'test',
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              id: 'r',
              output: [
                { type: 'reasoning', id: 'reason', encrypted_content: 'opaque' },
                { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
                { type: 'function_call', call_id: 'call', name: 'example', arguments: '{"x":1}' },
              ],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const result = await adapter.complete(prompt, new AbortController().signal, onText, log);
    expect(result).toMatchObject({
      content: 'hello',
      reasoningReplay: [{ id: 'reason', encrypted_content: 'opaque' }],
      toolCalls: [{ id: 'call', name: 'example', arguments: { x: 1 } }],
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(onText).toHaveBeenCalledExactlyOnceWith('hello');
    expect(log.settled).toHaveBeenCalledOnce();
    expect(log.settled.mock.calls[0]![1]).toMatchObject({ outcome: 'completed', outputTextCharacters: 5 });
    expect(log.settled.mock.calls[0]![1].firstTextMs).toBeUndefined();
  });
  it.each([
    ['malformed JSON', '{', 'invalid_json'],
    ['failed response', '{"status":"failed"}', 'response_failed'],
    ['missing completion', '{}', 'missing_completion'],
    [
      'non-token incomplete response',
      '{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}',
      'content_filter',
    ],
  ])('settles %s once without emitting output', async (_name, body, code) => {
    const log = trace();
    const onText = vi.fn();
    const adapter = new ResponsesModelAdapter({
      endpoint: 'https://example.test',
      provider: 'test',
      fetcher: vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })),
    });
    await expect(adapter.complete(prompt, new AbortController().signal, onText, log)).rejects.toThrow();
    expect(onText).not.toHaveBeenCalled();
    expect(log.settled).toHaveBeenCalledOnce();
    expect(log.settled.mock.calls[0]![1]).toMatchObject({
      outcome: 'failed',
      errorCategory: 'protocol',
      errorCode: code,
    });
  });
});
