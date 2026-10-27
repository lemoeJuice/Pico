import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptResponsesAdapter } from '../model.js';
import type { ChatGptPlanAuth } from '../auth.js';
import type { ModelPrompt, ModelRequestTrace } from '../../../runtime/model.js';

describe('ChatGPT Responses adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams transient text and maps completed function calls, usage, and settings', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization = '';
    let sessionIdHeader = '';
    let threadIdHeader = '';
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization') ?? '';
      sessionIdHeader = headers.get('session-id') ?? '';
      threadIdHeader = headers.get('thread-id') ?? '';
      const frames = [
        { type: 'response.reasoning_summary_text.delta', delta: 'Checking the path. ' },
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
    const accessToken = vi.fn(async () => 'oauth-access-token');
    const auth = { accessToken } as unknown as ChatGptPlanAuth;
    const requestTrace: ModelRequestTrace = {
      started: vi.fn(() => 'provider-attempt-1'),
      response: vi.fn(),
      settled: vi.fn(),
    };
    const prompt: ModelPrompt = {
      system: 'You are Pico.',
      model: 'selected-model',
      temperature: 0.2,
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
    const events: Array<Record<string, unknown>> = [];
    const adapter = new ChatGptResponsesAdapter(auth);
    const result = await adapter.complete(
      prompt,
      new AbortController().signal,
      (delta) => deltas.push(delta),
      requestTrace,
      (event) => events.push(event),
      { fields: { reasoning: { summary: 'auto', effort: 'high' }, service_tier: 'priority' } },
      'pico-thread-123',
    );

    expect(accessToken).toHaveBeenCalledWith(false, requestTrace);
    expect(requestTrace.started).toHaveBeenCalledWith({
      provider: 'chatgpt-plan',
      protocol: 'https+sse',
      endpoint: 'https://api.openai.com/v1/responses',
      attempt: 1,
      providerMetadata: { 'pico.chatgpt-plan.fastMode': true },
    });
    expect(authorization).toBe('Bearer oauth-access-token');
    expect(sessionIdHeader).toBe('pico-thread-123');
    expect(threadIdHeader).toBe('pico-thread-123');
    expect(requestBody).toMatchObject({
      model: 'selected-model',
      instructions: 'You are Pico.',
      store: false,
      stream: true,
      parallel_tool_calls: true,
      prompt_cache_key: 'pico-thread-123',
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      service_tier: 'priority',
    });
    expect(requestBody?.input).toEqual([
      { role: 'user', content: 'Read this file.' },
      { type: 'function_call', call_id: 'call_old', name: 'read_file', arguments: '{"path":"old.txt"}' },
      { type: 'function_call_output', call_id: 'call_old', output: '{"text":"old"}' },
    ]);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(events).toContainEqual({ type: 'reasoning_summary.delta', delta: 'Checking the path. ' });
    expect(result.reasoningSummary).toBe('Checking the path. ');
    expect(result).toMatchObject({
      content: 'Hello',
      model: 'account-model',
      usage: { inputTokens: 24, outputTokens: 6, totalTokens: 30 },
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'notes.txt' } }],
      finishReason: 'tool_calls',
    });
  });

  it('keeps distinct reasoning summary parts separated without splitting deltas within a part', async () => {
    const frames = [
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: '**Archive download timed out**',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: ' during the request.',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 1,
        delta: '**Clarifying no file created**',
      },
      { type: 'response.reasoning_summary_text.delta', output_index: 1, summary_index: 0, delta: 'A separate point.' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: '**Archive download timed out** during the request.' },
                { type: 'summary_text', text: '**Clarifying no file created**' },
              ],
            },
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A separate point.' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
          ],
        },
      },
    ];
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    const events: Array<{ type: string; delta?: string }> = [];

    const result = await adapter.complete(
      { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] },
      new AbortController().signal,
      () => undefined,
      undefined,
      (event) => events.push(event),
    );

    const streamedSummary = events
      .filter((event) => event.type === 'reasoning_summary.delta')
      .map((event) => event.delta)
      .join('');
    const expectedSummary =
      '**Archive download timed out** during the request.\n\n**Clarifying no file created**\n\nA separate point.';
    expect(streamedSummary).toBe(expectedSummary);
    expect(result.reasoningSummary).toBe(expectedSummary);
  });

  it('replays the complete Responses reasoning item on a later tool-call turn', async () => {
    const completedReasoning = {
      type: 'reasoning',
      id: 'rs_123',
      summary: [{ type: 'summary_text', text: 'Inspecting the request.' }],
    };
    const streamedReasoning = { ...completedReasoning, encrypted_content: 'opaque-encrypted-reasoning' };
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestIndex = 0;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const frames =
        requestIndex++ === 0
          ? [
              { type: 'response.output_item.done', output_index: 0, item: streamedReasoning },
              {
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [
                    completedReasoning,
                    { type: 'function_call', call_id: 'call_read', name: 'read_file', arguments: '{"path":"a.txt"}' },
                  ],
                },
              },
            ]
          : [
              {
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }],
                },
              },
            ];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    const first = await adapter.complete(
      {
        system: 'System',
        model: 'gpt-6-sol',
        temperature: 0.2,
        turns: [{ kind: 'message', role: 'user', content: 'Read a.txt.' }],
        tools: [],
      },
      new AbortController().signal,
      () => undefined,
    );
    expect(first.reasoningReplay).toEqual([streamedReasoning]);

    await adapter.complete(
      {
        system: 'System',
        model: 'gpt-6-sol',
        temperature: 0.2,
        turns: [
          {
            kind: 'assistant_tools',
            content: '',
            calls: [{ id: 'call_read', name: 'read_file', arguments: { path: 'a.txt' } }],
            reasoningReplay: first.reasoningReplay,
          },
          { kind: 'tool_result', callId: 'call_read', toolName: 'read_file', content: 'contents' },
          { kind: 'message', role: 'user', content: 'Summarize it.' },
        ],
        tools: [],
      },
      new AbortController().signal,
      () => undefined,
    );

    expect(requestBodies[1]?.input).toEqual([
      streamedReasoning,
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
      { type: 'function_call_output', call_id: 'call_read', output: 'contents' },
      { role: 'user', content: 'Summarize it.' },
    ]);
    expect(requestBodies[1]?.include).toEqual(['reasoning.encrypted_content']);
  });

  it('recovers streamed text and function calls omitted from the completed response', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const frames = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Recovered ' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'text' },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Recovered text' },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'item_2', type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'item_2',
        delta: '{"path":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'item_2',
        delta: '"notes.txt"}',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 1,
        item_id: 'item_2',
        arguments: '{"path":"notes.txt"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'item_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'read_file',
          arguments: '{"path":"notes.txt"}',
        },
      },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);
    const deltas: string[] = [];
    const events: Array<Record<string, unknown>> = [];

    await expect(
      adapter.complete(
        { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] },
        new AbortController().signal,
        (delta) => deltas.push(delta),
        undefined,
        (event) => events.push(event),
      ),
    ).resolves.toMatchObject({
      content: 'Recovered text',
      toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'notes.txt' } }],
      finishReason: 'tool_calls',
    });
    expect(deltas).toEqual(['Recovered ', 'text']);
    expect(requestBody?.reasoning).toEqual({ summary: 'auto' });
    expect(events).toContainEqual({
      type: 'tool_call.preview',
      index: 1,
      id: 'call_2',
      name: 'read_file',
      argumentsText: '{"path":',
    });
  });

  it('accepts empty completed responses and rejects function calls with unfinished arguments', async () => {
    const prompt: ModelPrompt = { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] };
    const auth = {
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth;

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    );
    const emptyAdapter = new ChatGptResponsesAdapter(auth);
    await expect(emptyAdapter.complete(prompt, new AbortController().signal, () => undefined)).resolves.toMatchObject({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
    });

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { id: 'item_3', type: 'function_call', call_id: 'call_3', name: 'read_file', arguments: '' },
            },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_3', delta: '{"path":' },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    );
    const incompleteCallAdapter = new ChatGptResponsesAdapter(auth);
    await expect(incompleteCallAdapter.complete(prompt, new AbortController().signal, () => undefined)).rejects.toThrow(
      'without completing its arguments',
    );
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
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('stream ended before the model step completed');
  });

  it('treats output-token exhaustion as a limit result and other incomplete responses as failures', async () => {
    const prompt: ModelPrompt = { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] };

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
    await expect(adapter.complete(prompt, new AbortController().signal, () => undefined)).resolves.toMatchObject({
      content: 'partial but complete stream',
      finishReason: 'length',
    });

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
    await expect(incompleteAdapter.complete(prompt, new AbortController().signal, () => undefined)).rejects.toThrow(
      'response was incomplete (content_filter)',
    );
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
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('subscription_sharing_usage_limit_exceeded');
  });

  it('records the nested network code when the Responses request fails before an HTTP response', async () => {
    const cause = Object.assign(new Error('connection failed'), { code: 'EACCES' });
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause });
    });
    const trace: ModelRequestTrace = {
      started: vi.fn(() => 'provider-attempt-1'),
      response: vi.fn(),
      settled: vi.fn(),
    };
    const adapter = new ChatGptResponsesAdapter({
      accessToken: async () => 'oauth-access-token',
    } as unknown as ChatGptPlanAuth);

    await expect(
      adapter.complete(
        { system: '', model: 'selected-model', temperature: 0.2, turns: [], tools: [] },
        new AbortController().signal,
        () => undefined,
        trace,
      ),
    ).rejects.toThrow('fetch failed');
    expect(trace.response).not.toHaveBeenCalled();
    expect(trace.settled).toHaveBeenCalledWith(
      'provider-attempt-1',
      expect.objectContaining({ outcome: 'failed', errorCategory: 'transport', errorCode: 'EACCES' }),
    );
  });
});
