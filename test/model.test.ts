import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleAdapter, type ModelPrompt } from '../src/runtime/model.js';
import type { ModelRequestTrace, ProviderRequestSummary } from '../src/contracts/model.js';

describe('OpenAI-compatible streaming adapter', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }),
    );
    vi.restoreAllMocks();
  });

  it('parses streamed text and fragmented parallel tool-call arguments without exposing wire details', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        const frames = [
          {
            model: 'actual-model',
            choices: [{ delta: { reasoning_summary_text: 'Checking ' }, finish_reason: null }],
          },
          {
            choices: [{ delta: { content: 'Hel' }, finish_reason: null }],
          },
          {
            choices: [
              {
                delta: {
                  content: 'lo',
                  tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"note.txt"}' } }] }, finish_reason: null },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 3,
              total_tokens: 15,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          },
        ];
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
    const prompt: ModelPrompt = {
      system: 'You are testing Pico.',
      turns: [{ kind: 'message', role: 'user', content: 'Read a file.' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      model: 'configured-model',
      temperature: 0.4,
    };
    const deltas: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const requestSummaries: ProviderRequestSummary[] = [];
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const requestTrace: ModelRequestTrace = {
      started: () => 'attempt-1',
      response: () => {
        now = 1_060;
      },
      settled: (_providerAttemptId, summary) => requestSummaries.push(summary),
    };
    const result = await new OpenAiCompatibleAdapter().complete(
      prompt,
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'configured-model',
        temperature: 0.4,
        provider: 'openai-compatible',
      },
      new AbortController().signal,
      (delta) => {
        deltas.push(delta);
        if (delta === 'Hel') now = 1_400;
      },
      requestTrace,
      (event) => {
        events.push(event);
        if (event.type === 'reasoning_summary.delta') now = 1_125;
      },
    );

    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.stream_options).toEqual({ include_usage: true });
    expect(requestBody?.parallel_tool_calls).toBe(true);
    expect(requestBody?.model).toBe('configured-model');
    expect((requestBody?.messages as Array<{ role: string }>)[1]?.role).toBe('user');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(events).toContainEqual({ type: 'reasoning_summary.delta', delta: 'Checking ' });
    expect(events).toContainEqual({
      type: 'tool_call.preview',
      index: 0,
      id: 'call_1',
      name: 'read_file',
      argumentsText: '{"path":',
    });
    expect(result.reasoningSummary).toBe('Checking ');
    expect(result).toMatchObject({
      content: 'Hello',
      model: 'actual-model',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, reasoningTokens: 1 },
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'note.txt' } }],
    });
    expect(requestSummaries).toHaveLength(1);
    expect(requestSummaries[0]).toMatchObject({ outcome: 'completed', firstTextMs: 125, durationMs: 400 });
  });

  it('replays reasoning and reads cache usage from streamed responses when traits are enabled', async () => {
    const frames = [
      { choices: [{ delta: { reasoning_content: 'thinking' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 7,
          completion_tokens: 4,
          completion_tokens_details: { reasoning_tokens: -1 },
        },
      },
    ];
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const events: unknown[] = [];
    const result = await new OpenAiCompatibleAdapter().complete(
      {
        system: '',
        model: 'custom-name',
        temperature: 1,
        tools: [],
        turns: [{ kind: 'message', role: 'assistant', content: 'old', reasoningContent: 'previous' }],
      },
      { baseUrl: 'https://example.test/v1', apiKey: '', model: 'custom-name', provider: 'test', temperature: 1 },
      new AbortController().signal,
      () => {},
      undefined,
      (event) => events.push(event),
      undefined,
      { protocolTraits: { reasoningContent: true, cacheHitMissUsage: true } },
    );
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(request.messages[1].reasoning_content).toBe('previous');
    expect(result).toMatchObject({
      content: 'answer',
      reasoningContent: 'thinking',
      usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4 },
    });
    expect(events).toContainEqual({ type: 'reasoning_summary.delta', delta: 'thinking' });
  });

  it('closes a provider stream after the done marker even when the server keeps the connection open', async () => {
    let resolveClosed!: () => void;
    let finishResponse: (() => void) | undefined;
    const streamClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = createServer((request, outgoing) => {
      request.resume();
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.once('close', resolveClosed);
      outgoing.write('data: [DONE]\n\n');
      finishResponse = () => outgoing.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');

    try {
      await new OpenAiCompatibleAdapter().complete(
        {
          system: 'You are testing Pico.',
          turns: [],
          tools: [],
          model: 'configured-model',
          temperature: 0.2,
        },
        {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'test-key',
          model: 'configured-model',
          temperature: 0.2,
          provider: 'openai-compatible',
        },
        new AbortController().signal,
        () => undefined,
      );
      const closed = await Promise.race([
        streamClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(closed).toBe(true);
    } finally {
      finishResponse?.();
    }
  });
});
