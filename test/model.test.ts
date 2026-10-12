import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleAdapter, type ModelPrompt } from '../src/runtime/model.js';

describe('OpenAI-compatible streaming adapter', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        if (!server.listening) return;
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }),
    );
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
          { model: 'actual-model', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
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
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
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
    const result = await new OpenAiCompatibleAdapter().complete(
      prompt,
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        model: 'configured-model',
        temperature: 0.4,
      },
      new AbortController().signal,
      (delta) => deltas.push(delta),
    );

    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.parallel_tool_calls).toBe(true);
    expect(requestBody?.model).toBe('configured-model');
    expect((requestBody?.messages as Array<{ role: string }>)[1]?.role).toBe('user');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      content: 'Hello',
      model: 'actual-model',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'note.txt' } }],
    });
  });
});
