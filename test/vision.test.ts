import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '../src/core/types.js';
import { ExecutionPipelines, type Interceptor, type PipelineStage } from '../src/core/pipeline.js';
import {
  isMultimodalToolResult,
  redactMultimodalToolResult,
  type MultimodalToolResult,
} from '../src/contracts/multimodal.js';
import { ChatGptResponsesAdapter } from '../src/plugins/chatgpt-plan/model.js';
import type { ChatGptPlanAuth } from '../src/plugins/chatgpt-plan/auth.js';
import type { PluginContext } from '../src/plugins/host.js';
import { visionPlugin } from '../src/plugins/vision.js';
import { OpenAiCompatibleAdapter, type ModelPrompt } from '../src/runtime/model.js';

const image = {
  type: 'image' as const,
  mimeType: 'image/png' as const,
  data: 'aGVsbG8=',
  name: 'screen.png',
};

function promptWithImage(): ModelPrompt {
  return {
    system: 'You are testing Pico.',
    model: 'test-model',
    temperature: 0.2,
    tools: [],
    turns: [
      {
        kind: 'assistant_tools',
        content: '',
        calls: [{ id: 'call-read-image', name: 'read_image', arguments: { path: image.name } }],
      },
      {
        kind: 'tool_result',
        callId: 'call-read-image',
        batchId: 'batch-1',
        toolName: 'read_image',
        content: 'Read image screen.png (image/png, 5 bytes).',
        images: [image],
      },
    ],
  };
}

function responseStream(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('Pico visual tool results', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads supported image bytes in the Executor and returns the versioned envelope', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pico-vision-'));
    const pngData = 'iVBORw0KGgo=';
    const bytes = Buffer.from(pngData, 'base64');
    try {
      await writeFile(join(workspacePath, image.name), bytes);
      const tool = (await import('../src/executor/tools.js')).createToolCatalog().get('read_image');
      expect(tool).toBeDefined();
      const result = await tool!.execute(
        { path: image.name },
        { workspacePath, executionId: 'vision-test', signal: new AbortController().signal },
      );
      expect(isMultimodalToolResult(result)).toBe(true);
      expect(result).toEqual({
        kind: 'pico.multimodal-tool-result',
        version: 1,
        text: 'Read image screen.png (image/png, 8 bytes).',
        images: [{ ...image, data: pngData }],
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('projects images onto only the matching retained tool result and redacts public metadata', async () => {
    const pipelines = new ExecutionPipelines();
    await visionPlugin.activate?.({
      pipelines: {
        use<I, O>(stage: PipelineStage, interceptor: Interceptor<I, O>) {
          pipelines.use(stage, visionPlugin.id, interceptor, visionPlugin.pipelinePriority?.projection ?? 0);
        },
      },
    } as unknown as PluginContext);
    const result: MultimodalToolResult = {
      kind: 'pico.multimodal-tool-result',
      version: 1,
      text: 'Read image screen.png (image/png, 5 bytes).',
      images: [image],
    };
    const record = {
      id: 'result-1',
      threadId: 'thread-1',
      seq: 2,
      kind: 'tool_result' as const,
      payload: {
        status: 'completed',
        result,
        batchId: 'batch-1',
        toolCallId: 'call-read-image',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const projected = await pipelines.run(
      'projection',
      {
        thread: {} as Thread,
        records: [record],
        through: 2,
        systemPrompt: '',
        tools: [],
        turns: promptWithImage().turns.map((turn) =>
          turn.kind === 'tool_result' ? { ...turn, images: undefined } : turn,
        ),
      },
      async (input) => input,
    );

    expect(projected.turns[1]).toMatchObject({
      kind: 'tool_result',
      callId: 'call-read-image',
      images: [image],
    });
    expect(redactMultimodalToolResult(result)).toEqual({
      kind: 'pico.multimodal-tool-result',
      version: 1,
      text: result.text,
      images: [{ type: 'image', mimeType: 'image/png', name: 'screen.png', byteLength: 5 }],
    });
  });

  it('serializes projected image bytes as image_url for OpenAI-compatible providers', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream([
        { choices: [{ delta: { content: 'Verified.' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]);
    });
    await new OpenAiCompatibleAdapter().complete(
      promptWithImage(),
      {
        baseUrl: 'https://model.invalid/v1',
        apiKey: '',
        model: 'test-model',
        temperature: 0.2,
        provider: 'openai-compatible',
      },
      new AbortController().signal,
      () => undefined,
    );

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-read-image' });
    expect(messages[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Images returned by tool read_image (call id call-read-image).' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } },
      ],
    });
  });

  it('serializes projected image bytes as input_image for ChatGPT Responses', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream([
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Verified.' }] }],
          },
        },
      ]);
    };
    const auth = { accessToken: async () => 'local-test-token' } as unknown as ChatGptPlanAuth;
    await new ChatGptResponsesAdapter(auth, fetcher).complete(
      promptWithImage(),
      new AbortController().signal,
      () => undefined,
    );

    expect(requestBody?.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call-read-image',
        name: 'read_image',
        arguments: '{"path":"screen.png"}',
      },
      { type: 'function_call_output', call_id: 'call-read-image', output: 'Read image screen.png (image/png, 5 bytes).' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Images returned by tool read_image (call id call-read-image).' },
          { type: 'input_image', image_url: `data:image/png;base64,${image.data}` },
        ],
      },
    ]);
  });
});
