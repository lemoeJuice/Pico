import { describe, expect, it } from 'vitest';
import type { ModelResponse } from '../src/contracts/model.js';
import type { ProjectionInput } from '../src/contracts/plugin-pipeline.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import { rollingContextPlugin } from '../src/plugins/rolling-context.js';
import {
  buildProviderObservedContextTokenHistory,
  buildProviderObservedSegmentLedger,
} from '../src/runtime/context-token-history.js';
import { ThreadContextState } from '../src/runtime/context-state.js';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';

const toolName = 'return_long_evidence';
const toolOutput = 'verified tool output '.repeat(80);

const evidenceTool: PicoPlugin = {
  id: 'pico.test.provider-token-evidence',
  name: 'Provider Token Evidence',
  version: '1',
  defaultToolsEnabled: true,
  activate({ tools }) {
    tools.register(
      { name: toolName, description: 'Return long test evidence.', parameters: { type: 'object' } },
      () => toolOutput,
    );
  },
};

interface RuntimeInternals {
  contextStates: ThreadContextState;
}

function withUsage(result: ModelResponse, usage: NonNullable<ModelResponse['usage']>): ModelResponse {
  return { ...result, usage };
}

async function submitOneToolRound(env: Awaited<ReturnType<typeof setupRuntime>>, thread: Thread, model: FakeModel) {
  await env.runtime.submit(thread.id, 'provider-ledger-user', 'Keep this user prompt fixed across model rounds.');
  await env.runtime.drain();
  expect(model.prompts).toHaveLength(2);
}

describe('Runtime provider observed context token accounting', () => {
  it('keeps the unobserved latest tool result out of the preflight count and measures the next request delta', async () => {
    const secondCallStarted = deferred<void>();
    const secondCallResponse = deferred<ModelResponse>();
    const model = new FakeModel((_prompt, callNumber) => {
      if (callNumber === 1) {
        return withUsage(response('', [{ id: 'evidence-call', name: toolName, arguments: {} }]), {
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 2,
          totalTokens: 10,
        });
      }
      secondCallStarted.resolve();
      return secondCallResponse.promise;
    });
    const env = await setupRuntime(model, {
      plugins: [evidenceTool],
      disabledBuiltinPlugins: ['pico.rolling-context'],
    });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({
        contextWindowTokens: 1_000,
        compactionThresholdTokens: 110,
      });
      const submission = submitOneToolRound(env, thread, model);
      await secondCallStarted.promise;

      expect(JSON.stringify(model.prompts[1]?.turns)).toContain(toolOutput);
      const state = await (env.runtime as unknown as RuntimeInternals).contextStates.read(thread.id);
      // 100 observed request tokens + 8 visible assistant output tokens. The newly
      // appended tool output has not yet appeared in any provider usage report.
      expect(state.tokenCount).toBe(108);
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'model-input-recorded'),
      ).toHaveLength(2);

      secondCallResponse.resolve(
        withUsage(response('Finished.'), {
          inputTokens: 135,
          outputTokens: 9,
          reasoningTokens: 3,
          totalTokens: 9,
        }),
      );
      await submission;
      const ledger = buildProviderObservedSegmentLedger(
        env.store.listRecords(thread.id),
        thread,
        env.runtime.threadModelSelection(thread.id),
      );
      expect(ledger?.segmentLedger).toEqual([
        expect.objectContaining({
          tokenCount: 35,
          startSeq: expect.any(Number),
          endSeq: expect.any(Number),
        }),
      ]);
    } finally {
      secondCallResponse.resolve(response('Finished.'));
      await env.cleanup();
    }
  });

  it('replaces a raw provider-measured round with the real rolling capsule and latest visible assistant output', async () => {
    const thirdCallStarted = deferred<void>();
    const thirdCallResponse = deferred<ModelResponse>();
    const projectionSnapshots: Array<{ input: ProjectionInput; records: CanonicalRecord[] }> = [];
    let mainCalls = 0;
    const model = new FakeModel((prompt) => {
      if (prompt.system.includes('Summarize exactly one sealed model-response round')) {
        return withUsage(response('VISIBLE CAPSULE BODY'), {
          inputTokens: 40,
          outputTokens: 15,
          reasoningTokens: 5,
          totalTokens: 15,
        });
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return withUsage(response('', [{ id: 'evidence-call', name: toolName, arguments: {} }]), {
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 2,
          totalTokens: 10,
        });
      }
      if (mainCalls === 2) {
        return withUsage(
          response('', [{ id: 'rolling-compact-call', name: 'rolling_compact', arguments: { keep_recent_rounds: 0 } }]),
          {
            inputTokens: 135,
            outputTokens: 14,
            reasoningTokens: 4,
            totalTokens: 14,
          },
        );
      }
      thirdCallStarted.resolve();
      return thirdCallResponse.promise;
    });
    const projectionProbe: PicoPlugin = {
      id: 'pico.test.provider-token-projection-probe',
      name: 'Provider Token Projection Probe',
      version: '1',
      pipelinePriority: { projection: 80 },
      activate({ canonical, pipelines }) {
        pipelines.use('projection', async (input, next) => {
          if (input.modelStep) {
            projectionSnapshots.push({
              input,
              records: canonical.list(input.thread.id),
            });
          }
          return next(input);
        });
      },
    };
    const env = await setupRuntime(model, {
      plugins: [evidenceTool, rollingContextPlugin, projectionProbe],
    });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({
        contextWindowTokens: 100_000,
        compactionThresholdTokens: 90_000,
      });
      const selection = env.runtime.threadModelSelection(thread.id);
      const economicsRoute = env.runtime.pluginHttpRoute('pico.rolling-context', 'PUT', '/economics');
      expect(economicsRoute).toBeDefined();
      await economicsRoute!.handler({
        body: {
          threadId: thread.id,
          provider: selection.provider,
          model: selection.model,
          inputPerMillion: 100,
          cachedInputPerMillion: 100,
          cacheWritePerMillion: 0,
          expectedFutureCalls: 10,
        },
        query: new URLSearchParams(),
        origin: null,
      });

      await env.runtime.submit(thread.id, 'rolling-ledger-user', 'Keep this user prompt fixed across model rounds.');
      // Call 3 is reached only after rolling_compact warms the first completed round
      // and Runtime has reconciled the resulting capsule into the next projection.
      const drain = env.runtime.drain();
      await thirdCallStarted.promise;

      const mainPrompts = model.prompts.filter(
        (prompt) => !prompt.system.includes('Summarize exactly one sealed model-response round'),
      );
      expect(mainCalls).toBe(3);
      expect(mainPrompts).toHaveLength(3);
      expect(JSON.stringify(mainPrompts[2]?.turns)).toContain('VISIBLE CAPSULE BODY');
      expect(JSON.stringify(mainPrompts[2]?.turns)).not.toContain('Segment rc-');

      const state = await (env.runtime as unknown as RuntimeInternals).contextStates.read(thread.id);
      const observedProjection = projectionSnapshots.at(-1)!;
      const observedContext = buildProviderObservedContextTokenHistory(
        observedProjection.records,
        observedProjection.input,
        selection,
        env.store.listPluginModelCalls({ threadId: thread.id }),
      );
      expect(observedContext?.inputTokens).toBe(120);
      // Baseline provider input 135 - original round delta 35 + capsule body 10
      // visible output tokens + latest assistant output 10 (14 output - 4 reasoning).
      expect(state.tokenCount).toBe(120);
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
      ).toHaveLength(0);

      const ledger = buildProviderObservedSegmentLedger(
        observedProjection.records.filter((record) => record.seq <= state.sourceThrough),
        thread,
        selection,
        env.store.listPluginModelCalls({ threadId: thread.id }),
      );
      expect(ledger?.segmentLedger).toEqual([expect.objectContaining({ tokenCount: 35 })]);
      expect(env.store.listPluginModelCalls({ threadId: thread.id })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'pico.rolling-context',
            purpose: 'rolling-summary',
            status: 'completed',
            response: expect.objectContaining({
              content: 'VISIBLE CAPSULE BODY',
              usage: { inputTokens: 40, outputTokens: 15, reasoningTokens: 5, totalTokens: 15 },
            }),
          }),
        ]),
      );

      thirdCallResponse.resolve(
        withUsage(response('Continued from the capsule.'), {
          inputTokens: 120,
          outputTokens: 6,
          reasoningTokens: 2,
          totalTokens: 6,
        }),
      );
      await drain;
    } finally {
      thirdCallResponse.resolve(response('Finished.'));
      await env.cleanup();
    }
  });

  it.each([
    ['missing input usage', null],
    ['missing reasoning usage', { inputTokens: 100, outputTokens: 10, totalTokens: 10 }],
  ] as const)('%s leaves the Runtime context count unknown', async (_label, usage) => {
    const secondCallStarted = deferred<void>();
    const secondCallResponse = deferred<ModelResponse>();
    const model = new FakeModel((_prompt, callNumber) => {
      if (callNumber === 1) {
        const result = response('', [{ id: 'evidence-call', name: toolName, arguments: {} }]);
        return usage === null ? result : { ...result, usage };
      }
      secondCallStarted.resolve();
      return secondCallResponse.promise;
    });
    const env = await setupRuntime(model, {
      plugins: [evidenceTool],
      disabledBuiltinPlugins: ['pico.rolling-context'],
    });
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({
        contextWindowTokens: 1_000,
        compactionThresholdTokens: 110,
      });
      const submission = submitOneToolRound(env, thread, model);
      await secondCallStarted.promise;
      const state = await (env.runtime as unknown as RuntimeInternals).contextStates.read(thread.id);
      expect(state.tokenCount).toBeNull();
      secondCallResponse.resolve(
        withUsage(response('Finished.'), {
          inputTokens: 135,
          outputTokens: 9,
          reasoningTokens: 3,
          totalTokens: 9,
        }),
      );
      await submission;
    } finally {
      secondCallResponse.resolve(response('Finished.'));
      await env.cleanup();
    }
  });
});
