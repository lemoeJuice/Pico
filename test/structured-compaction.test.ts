import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';
import { visionPlugin } from '../src/plugins/vision.js';
import type { Thread } from '../src/core/types.js';
import type { ModelPrompt } from '../src/contracts/model.js';
import type { ModelResponse } from '../src/contracts/model.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';

type ProjectedPrompt = Pick<ModelPrompt, 'tools' | 'turns'> & { systemPrompt: string };
type CanonicalTestEnv = { store: Pick<Awaited<ReturnType<typeof setupRuntime>>['store'], 'appendCanonical'> };

function isCompactionPrompt(prompt: ModelPrompt) {
  const last = prompt.turns.at(-1);
  return last?.kind === 'message' && last.role === 'user' && /summarize this conversation/i.test(last.content);
}

function projectedState(projection: ProjectedPrompt) {
  return {
    system: projection.systemPrompt,
    tools: projection.tools,
    turns: projection.turns,
  };
}

function expectStructuredCompactionPrompt(prompt: ModelPrompt, projection: ProjectedPrompt) {
  expect(prompt.system).toBe(projection.systemPrompt);
  expect(prompt.tools).toEqual(projection.tools);
  expect(prompt.turns.slice(0, projection.turns.length)).toEqual(projection.turns);
  expect(prompt.turns).toHaveLength(projection.turns.length + 1);
  expect(isCompactionPrompt(prompt)).toBe(true);
}

function appendInvocation(env: CanonicalTestEnv, thread: Thread, round: number, withImage = false) {
  const batchId = `batch-${round}`;
  const callId = `call-${round}`;
  const user = env.store.appendCanonical(thread.id, `user-${round}`, 'message', {
    role: 'user',
    source: 'user',
    content: `request ${round}`,
  });
  env.store.appendCanonical(thread.id, `assistant-${round}`, 'assistant', {
    content: `assistant response ${round}`,
    toolCalls: [{ id: callId, name: 'inspect', arguments: { round } }],
    batchId,
    projectionThrough: user.record.seq,
    usage: null,
    model: 'test-model',
  });
  env.store.appendCanonical(thread.id, `execution-${round}:result`, 'tool_result', {
    batchId,
    toolCallId: callId,
    toolName: 'inspect',
    executionId: `execution-${round}`,
    status: 'completed',
    result: withImage
      ? {
          kind: 'pico.multimodal-tool-result',
          version: 1,
          text: `image result ${round}`,
          images: [{ type: 'image', mimeType: 'image/png', data: 'AQID', name: `recent-${round}.png` }],
        }
      : `result ${round}`,
  });
}

function appendSimpleInvocation(env: CanonicalTestEnv, thread: Thread, round: number) {
  const user = env.store.appendCanonical(thread.id, `simple-user-${round}`, 'message', {
    role: 'user',
    source: 'user',
    content: `simple request ${round}`,
  });
  env.store.appendCanonical(thread.id, `simple-assistant-${round}`, 'assistant', {
    content: `simple answer ${round}`,
    toolCalls: [],
    batchId: null,
    projectionThrough: user.record.seq,
    usage: null,
    model: 'test-model',
  });
}

async function selectResponsesModel(runtime: PicoRuntime, thread: Thread) {
  runtime.modelCatalog.registerProviderType(
    'test.compaction-responses',
    {
      id: 'responses',
      label: 'Local test Responses',
      addPage: { pluginId: 'test.compaction-responses', pageId: 'add' },
    },
    {
      listModels: async () => [
        {
          id: 'responses-test-model',
          name: 'responses-test-model',
          label: 'Responses test model',
          protocol: 'openai-responses',
          supportsImages: true,
          endpoint: 'https://responses.mock.invalid/v1/responses',
        },
      ],
      authorize: async () => ({}),
    },
  );
  runtime.modelCatalog.registerAdapter('test.compaction-responses', {
    id: 'responses-adapter',
    label: 'Responses test adapter',
    match: { protocols: ['openai-responses'] },
    controls: [],
    temperature: { supported: false },
    replayFormat: 'openai-responses',
  });
  const instance = runtime.modelCatalog.addInstance('test.compaction-responses', 'responses', {
    label: 'Local test Responses',
    config: {},
  });
  const [model] = await runtime.modelCatalog.refreshInstance(instance.id);
  runtime.updateThreadModelSelection(thread.id, {
    modelId: model!.modelId,
    adapterId: 'responses-adapter',
    parameters: { options: {} },
  });
}

async function setupResponsesRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'pico-structured-responses-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const store = new PicoStore(':memory:');
  const runtime = new PicoRuntime(store, { pluginDirectory: join(directory, 'empty-plugins') });
  await runtime.initialize();
  const project = await runtime.createProject('Responses test project', workspace);
  const thread = runtime.createThread(project.id, 'runtime');
  await selectResponsesModel(runtime, thread);
  return {
    directory,
    store,
    runtime,
    thread,
    async cleanup() {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function responseBody(output: unknown[] = []) {
  return new Response(
    JSON.stringify({ id: 'local-response', status: 'completed', model: 'responses-test-model', output }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('structured Runtime compaction', () => {
  it('uses the complete projected request structure and retains recent tool results and images', async () => {
    const model = new FakeModel(() => response('Summary of prior context.'));
    const env = await setupRuntime(model, { plugins: [visionPlugin] });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendInvocation(env, thread, round, round >= 3);

      const beforeRecords = env.store.listRecords(thread.id);
      const beforeRawRecords = beforeRecords
        .filter((record) => record.kind !== 'plugin')
        .map((record) => ({ id: record.id, kind: record.kind, payload: record.payload }));
      const beforeProjection = await env.runtime['projectModelInput'](thread, beforeRecords, beforeRecords.at(-1)!.seq);
      const result = await env.runtime['compactThread'](thread, false, false, beforeProjection);
      expect(result.text).toContain('Compacted');

      const compactPrompt = model.prompts.find(isCompactionPrompt)!;
      expectStructuredCompactionPrompt(compactPrompt, beforeProjection);
      expect(compactPrompt.turns).toContainEqual(
        expect.objectContaining({ kind: 'assistant_tools', calls: [expect.objectContaining({ id: 'call-4' })] }),
      );
      expect(compactPrompt.turns).toContainEqual(
        expect.objectContaining({
          kind: 'tool_result',
          callId: 'call-4',
          content: expect.stringContaining('image result 4'),
        }),
      );
      for (const round of [3, 4]) {
        expect(compactPrompt.turns).toContainEqual(
          expect.objectContaining({
            kind: 'tool_result',
            callId: `call-${round}`,
            images: [expect.objectContaining({ data: 'AQID', name: `recent-${round}.png` })],
          }),
        );
      }

      const afterRecords = env.store.listRecords(thread.id);
      const afterRawRecords = afterRecords
        .filter((record) => record.kind !== 'plugin')
        .filter((record) => beforeRawRecords.some((before) => before.id === record.id))
        .map((record) => ({ id: record.id, kind: record.kind, payload: record.payload }));
      expect(afterRawRecords).toEqual(beforeRawRecords);

      const afterProjection = await env.runtime['projectModelInput'](thread, afterRecords, afterRecords.at(-1)!.seq);
      const recentCalls = afterProjection.turns.filter(
        (turn) =>
          turn.kind === 'assistant_tools' && turn.calls.some((call) => call.id === 'call-3' || call.id === 'call-4'),
      );
      expect(recentCalls).toHaveLength(2);
      for (const callId of ['call-3', 'call-4']) {
        expect(afterProjection.turns).toContainEqual(
          expect.objectContaining({
            kind: 'tool_result',
            callId,
            images: [expect.objectContaining({ data: 'AQID', name: `recent-${callId.slice(-1)}.png` })],
          }),
        );
      }
    } finally {
      await env.cleanup();
    }
  });

  it.each([
    ['invalid summary', () => response('')],
    [
      'failed summary call',
      () => {
        throw new Error('Synthetic model failure');
      },
    ],
  ] as const)('%s leaves the projection and raw Canonical records unchanged', async (_label, respond) => {
    const model = new FakeModel(() => respond());
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendInvocation(env, thread, round);
      const beforeRecords = env.store.listRecords(thread.id);
      const beforeProjection = await env.runtime['projectModelInput'](thread, beforeRecords, beforeRecords.at(-1)!.seq);
      const beforeState = projectedState(beforeProjection);
      const rawRecords = beforeRecords.filter((record) => record.kind !== 'plugin');

      try {
        await env.runtime['compactThread'](thread, false, false, beforeProjection);
      } catch {
        // A rejected helper call is also a valid failure result; state assertions below are decisive.
      }

      const afterRecords = env.store.listRecords(thread.id);
      const afterProjection = await env.runtime['projectModelInput'](
        thread,
        afterRecords,
        afterRecords.at(-1)?.seq ?? 0,
      );
      expect(projectedState(afterProjection)).toEqual(beforeState);
      expect(afterRecords.filter((record) => record.kind !== 'plugin')).toEqual(rawRecords);
      expect(
        afterRecords.some((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
      ).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('uses the same Responses cache key and projected request prefix as the main model call', async () => {
    const env = await setupResponsesRuntime();
    const { runtime, thread } = env;
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      // The primary call is deliberately empty so it does not add a projected
      // assistant turn between the main request and its compact continuation.
      if (bodies.length === 1) return responseBody();
      return responseBody([{ type: 'message', content: [{ type: 'output_text', text: 'Local summary.' }] }]);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendSimpleInvocation(env, thread, round);

      await runtime.submit(thread.id, 'responses-prefix-probe', 'Show this complete projected history.');
      await runtime.drain();
      expect(bodies).toHaveLength(1);
      const compactResult = await runtime['compactThread'](thread);
      expect(compactResult.text).toContain('Compacted');
      expect(bodies).toHaveLength(2);

      const [mainBody, compactBody] = bodies as [Record<string, unknown>, Record<string, unknown>];
      expect(mainBody.prompt_cache_key).toBe(thread.id);
      expect(compactBody.prompt_cache_key).toBe(mainBody.prompt_cache_key);
      expect(compactBody.instructions).toBe(mainBody.instructions);
      expect(compactBody.tools).toEqual(mainBody.tools);
      const mainInput = mainBody.input as unknown[];
      const compactInput = compactBody.input as unknown[];
      expect(compactInput.slice(0, mainInput.length)).toEqual(mainInput);
      expect(compactInput).toHaveLength(mainInput.length + 1);
      expect(compactInput.at(-1)).toEqual(
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Summarize this conversation for continuing the same task.'),
        }),
      );
      expect(fetcher.mock.calls.every(([url]) => String(url) === 'https://responses.mock.invalid/v1/responses')).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
      await env.cleanup();
    }
  });

  it('keeps messages appended during summarization after the committed summary', async () => {
    const entered = deferred<void>();
    const pending = deferred<ModelResponse>();
    const model = new FakeModel((prompt) => {
      if (!isCompactionPrompt(prompt)) return response('unused');
      entered.resolve();
      return pending.promise;
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendInvocation(env, thread, round);
      const before = env.store.listRecords(thread.id);
      const projection = await env.runtime['projectModelInput'](thread, before, before.at(-1)!.seq);
      const compacting = env.runtime['compactThread'](thread, false, false, projection);
      await entered.promise;
      const firstArrival = env.store.appendCanonical(thread.id, 'arrived-during-compaction', 'message', {
        role: 'user',
        source: 'user',
        content: 'First message arrived while the summary model was running.',
      });
      const childArrival = env.store.appendCanonical(thread.id, 'child-arrived-during-compaction', 'message', {
        role: 'user',
        source: 'child',
        senderThreadId: 'child-thread',
        senderLabel: 'Research child',
        content: 'Second message arrived while the summary model was running.',
      });
      pending.resolve(response('Summary of earlier context.'));

      const result = await compacting;
      expect(result.text).toContain('Compacted');
      const after = env.store.listRecords(thread.id);
      const marker = after.find((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted');
      expect(marker).toBeDefined();
      expect((marker!.payload as { summaryInputRecordIds: string[] }).summaryInputRecordIds).not.toContain(
        'arrived-during-compaction',
      );
      expect((marker!.payload as { summaryInputRecordIds: string[] }).summaryInputRecordIds).not.toContain(
        'child-arrived-during-compaction',
      );
      expect(after.find((record) => record.id === 'arrived-during-compaction')).toBeDefined();
      const cached = await env.runtime['contextStates'].read(thread.id);
      const cachedTurns = JSON.stringify(cached.turns);
      expect(cached.sourceThrough).toBeGreaterThanOrEqual(childArrival.record.seq);
      expect(cachedTurns).toContain('Summary of earlier context.');
      expect(cachedTurns).toContain('First message arrived while the summary model was running.');
      expect(cachedTurns).toContain('Second message arrived while the summary model was running.');
      expect(
        cached.provenance.some(
          (item) =>
            item.canonicalStartSeq === firstArrival.record.seq && item.canonicalEndSeq === childArrival.record.seq,
        ),
      ).toBe(true);
      const current = await env.runtime['projectModelInput'](thread, after, after.at(-1)!.seq);
      const content = JSON.stringify(current.turns);
      expect(content).toContain('Summary of earlier context.');
      expect(content).toContain('First message arrived while the summary model was running.');
      expect(content).toContain('Second message arrived while the summary model was running.');
      expect(content.indexOf('Summary of earlier context.')).toBeLessThan(
        content.indexOf('First message arrived while the summary model was running.'),
      );
      expect(content.indexOf('First message arrived while the summary model was running.')).toBeLessThan(
        content.indexOf('Second message arrived while the summary model was running.'),
      );
    } finally {
      await env.cleanup();
    }
  });

  it('still refuses to commit if non-message Canonical history changes during summarization', async () => {
    const entered = deferred<void>();
    const pending = deferred<ModelResponse>();
    const model = new FakeModel((prompt) => {
      if (!isCompactionPrompt(prompt)) return response('unused');
      entered.resolve();
      return pending.promise;
    });
    const env = await setupRuntime(model);
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendInvocation(env, thread, round);
      const before = env.store.listRecords(thread.id);
      const projection = await env.runtime['projectModelInput'](thread, before, before.at(-1)!.seq);
      const compacting = env.runtime['compactThread'](thread, false, false, projection);
      await entered.promise;
      env.store.appendCanonical(thread.id, 'history-changed-during-compaction', 'plugin', {
        pluginId: 'pico.runtime',
        action: 'context-rewound',
        version: 1,
      });
      pending.resolve(response('Stale summary must not commit.'));

      const result = await compacting;
      expect(result.severity).toBe('error');
      expect(result.text).toContain('history changed during compaction');
      const after = env.store.listRecords(thread.id);
      expect(after.some((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted')).toBe(
        false,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('does not execute a tool returned by the compact summary model', async () => {
    let toolRuns = 0;
    const plugin: PicoPlugin = {
      id: 'test.compaction-tool-guard',
      name: 'Compaction tool guard',
      version: '1',
      activate({ tools }) {
        tools.register(
          {
            name: 'must_not_run',
            description: 'A probe for compact helper tool isolation.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          async () => {
            toolRuns += 1;
            return { unexpected: true };
          },
        );
      },
    };
    const model = new FakeModel(() => response('', [{ id: 'compact-tool-call', name: 'must_not_run', arguments: {} }]));
    const env = await setupRuntime(model, { plugins: [plugin] });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let round = 1; round <= 4; round += 1) appendInvocation(env, thread, round);
      const before = env.store.listRecords(thread.id);
      const projection = await env.runtime['projectModelInput'](thread, before, before.at(-1)!.seq);
      const result = await env.runtime['compactThread'](thread, false, false, projection);
      expect(result.severity).toBe('error');
      expect(result.text).toContain('usable compaction summary');
      expect(toolRuns).toBe(0);
      expect(env.store.listExecutions(thread.id)).toHaveLength(0);
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
      ).toBe(false);
    } finally {
      await env.cleanup();
    }
  });
});
