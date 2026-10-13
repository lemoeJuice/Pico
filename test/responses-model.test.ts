import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptResponsesAdapter } from '../src/runtime/responses-model.js';
import type { ChatGptPlanAuth } from '../src/runtime/chatgpt-auth.js';
import type { ModelPrompt } from '../src/runtime/model.js';

describe('ChatGPT Responses adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams transient text and maps completed function calls, usage, and settings', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization = '';
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      const frames = [
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            model: 'account-model',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'read_file',
                arguments: '{"path":"notes.txt"}',
              },
            ],
            usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30 },
          },
        },
      ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const auth = { accessToken: async () => 'oauth-access-token' } as unknown as ChatGptPlanAuth;
    const prompt: ModelPrompt = {
      system: 'You are Pico.',
      model: 'selected-model',
      temperature: 0.2,
      reasoningEffort: 'high',
      fastMode: true,
      turns: [
        { kind: 'message', role: 'user', content: 'Read this file.' },
        {
          kind: 'assistant_tools',
          content: '',
          calls: [{ id: 'call_old', name: 'read_file', arguments: { path: 'old.txt' } }],
        },
        { kind: 'tool_result', callId: 'call_old', toolName: 'read_file', content: '{"text":"old"}' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    };
    const deltas: string[] = [];
    const adapter = new ChatGptResponsesAdapter(auth);
    const result = await adapter.complete(
      prompt,
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: prompt.model,
        temperature: prompt.temperature,
        provider: 'chatgpt-plan',
        reasoningEffort: 'high',
        fastMode: true,
      },
      new AbortController().signal,
      (delta) => deltas.push(delta),
    );

    expect(authorization).toBe('Bearer oauth-access-token');
    expect(requestBody).toMatchObject({
      model: 'selected-model',
      instructions: 'You are Pico.',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      reasoning: { effort: 'high' },
      service_tier: 'fast',
    });
    expect(requestBody?.input).toEqual([
      { role: 'user', content: 'Read this file.' },
      { type: 'function_call', call_id: 'call_old', name: 'read_file', arguments: '{"path":"old.txt"}' },
      { type: 'function_call_output', call_id: 'call_old', output: '{"text":"old"}' },
    ]);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      content: 'Hello',
      model: 'account-model',
      usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }],
      finishReason: 'tool_calls',
    });
  });

  it('does not return an incomplete stream as a completed model step', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);

    await expect(
      adapter.complete(
        { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] },
        {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'selected-model',
          temperature: 0.2,
          provider: 'chatgpt-plan',
          reasoningEffort: 'auto',
          fastMode: false,
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('stream ended before the model step completed');
  });

  it('treats output-token exhaustion as a limit result and other incomplete responses as failures', async () => {
    const prompt: ModelPrompt = { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] };
    const settings = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'selected-model',
      temperature: 0.2,
      provider: 'chatgpt-plan' as const,
      reasoningEffort: 'auto' as const,
      fastMode: false,
    };

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial but complete stream' }] }],
            },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    await expect(
      adapter.complete(prompt, settings, new AbortController().signal, () => undefined),
    ).resolves.toMatchObject({ content: 'partial but complete stream', finishReason: 'length' });

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const incompleteAdapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    await expect(
      incompleteAdapter.complete(prompt, settings, new AbortController().signal, () => undefined),
    ).rejects.toThrow('response was incomplete (content_filter)');
  });

  it('preserves structured provider error codes from failed stream events', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Plan limit reached.' } },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    await expect(
      adapter.complete(
        { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] },
        {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'selected-model',
          temperature: 0.2,
          provider: 'chatgpt-plan',
          reasoningEffort: 'auto',
          fastMode: false,
        },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('subscription_sharing_usage_limit_exceeded');
  });
});
