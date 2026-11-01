import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogSelection } from '../src/contracts/model-catalog.js';
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

/** Installs a deterministic in-memory catalog for FakeModel integration tests. */
export async function setupTestCatalog(runtime: PicoRuntime, names: string[] = ['test-model']) {
  const owner = 'pico.test';
  const typeId = 'pico.test-provider';
  const adapterId = 'pico.test-adapter';
  runtime.modelCatalog.registerProviderType(
    owner,
    { id: typeId, label: 'Test provider', addPage: { pluginId: owner, pageId: 'add' } },
    {
      listModels: async () =>
        names.map((name) => ({
          id: name,
          name,
          label: name,
          protocol: 'openai-chat-completions',
          endpoint: 'https://test.invalid/v1',
          supportsImages: true,
        })),
      authorize: async () => ({}),
    },
  );
  runtime.modelCatalog.registerAdapter(owner, {
    id: adapterId,
    label: 'Test adapter',
    match: { providerTypeIds: [typeId] },
    controls: [],
    temperature: { supported: true, min: 0, max: 2 },
  });
  const instance =
    runtime.modelCatalog.listInstances().find((entry) => entry.owner === owner && entry.typeId === typeId) ??
    runtime.modelCatalog.addInstance(owner, typeId, { label: 'Test provider', config: {} });
  await runtime.modelCatalog.refreshInstance(instance.id);
  const select = (name = 'test-model'): CatalogSelection => {
    const model = runtime.modelCatalog
      .listModels()
      .find((entry) => entry.instanceId === instance.id && entry.name === name);
    if (!model) throw new Error('Test model unavailable');
    return { modelId: model.modelId, adapterId, parameters: { temperature: 0.7, options: {} } };
  };
  return {
    instance,
    select,
    async addModel(name: string) {
      if (!names.includes(name)) names.push(name);
      await runtime.modelCatalog.refreshInstance(instance.id);
      return select(name);
    },
  };
}

export async function setupRuntime(model: ModelAdapter, options: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pico-test-'));
  const workspace = join(directory, 'workspace');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
  const store = new PicoStore(':memory:');
  const runtime = new PicoRuntime(store, {
    ...options,
    executorActivityEnabled: options.executorActivityEnabled ?? false,
    model,
    pluginDirectory: options.pluginDirectory ?? join(directory, 'empty-plugins'),
  });
  await runtime.initialize();
  const catalog = await setupTestCatalog(runtime);
  const project = await runtime.createProject('Test project', workspace);
  return {
    directory,
    workspace,
    store,
    runtime,
    project,
    catalog,
    createThread: (executor: 'host' | 'container' | 'runtime' = 'host', title = 'Test thread') => {
      const thread = runtime.createThread(project.id, executor, title);
      runtime.updateThreadModelSelection(thread.id, catalog.select());
      return thread;
    },
    async cleanup() {
      await runtime.shutdown();
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
