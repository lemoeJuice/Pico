import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantPayload } from '../src/core/types.js';
import { PicoStore } from '../src/core/store.js';
import type { ModelAdapter, ModelPrompt, ModelResponse } from '../src/runtime/model.js';
import { PicoRuntime, type RuntimeOptions } from '../src/runtime/runtime.js';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function response(content = '', toolCalls: ModelResponse['toolCalls'] = []): ModelResponse {
  return { content, toolCalls, usage: null, model: 'test-model', finishReason: 'stop' };
}

export class FakeModel implements ModelAdapter {
  calls = 0;
  readonly prompts: ModelPrompt[] = [];
  readonly signals: AbortSignal[] = [];

  constructor(
    private readonly responder: (
      prompt: ModelPrompt,
      callNumber: number,
      signal: AbortSignal,
      onText: (delta: string) => void,
    ) => Promise<ModelResponse> | ModelResponse,
  ) {}

  async complete(
    prompt: ModelPrompt,
    _settings: Parameters<ModelAdapter['complete']>[1],
    signal: AbortSignal,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    const callNumber = ++this.calls;
    this.prompts.push(prompt);
    this.signals.push(signal);
    return this.responder(prompt, callNumber, signal, onText);
  }
}

export async function setupRuntime(model: ModelAdapter, options: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pico-test-'));
  const workspace = join(directory, 'workspace');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
  const store = new PicoStore(':memory:');
  const runtime = new PicoRuntime(store, {
    ...options,
    model,
    pluginDirectory: options.pluginDirectory ?? join(directory, 'empty-plugins'),
  });
  await runtime.initialize();
  const project = await runtime.createProject('Test project', workspace);
  return {
    directory,
    workspace,
    store,
    runtime,
    project,
    createThread: (executor: 'host' | 'container' = 'host', title = 'Test thread') =>
      runtime.createThread(project.id, executor, title),
    async cleanup() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function assistantPayload(overrides: Partial<AssistantPayload> = {}): AssistantPayload {
  return {
    content: '',
    toolCalls: [],
    batchId: null,
    projectionThrough: 0,
    usage: null,
    model: 'test-model',
    ...overrides,
  };
}
