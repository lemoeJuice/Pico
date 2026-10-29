import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from '../src/contracts/plugin-pipeline.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import { rollingContextPlugin } from '../src/plugins/rolling-context.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

const isRollingSummary = (prompt: { system: string }) =>
  prompt.system.includes('Summarize exactly one sealed model-response round');

describe('Rolling Context v2 lifecycle', () => {
  it('waits for the next user input; previews and manual /compact do not seal or summarize rounds', async () => {
    let previewModelInput: ((threadId: string) => Promise<ProjectionInput>) | undefined;
    const previewServicePlugin: PicoPlugin = {
      id: 'example.rolling-preview-probe',
      name: 'Rolling preview probe',
      version: '1',
      activate(context) {
        previewModelInput = context.threads.previewModelInput;
      },
    };
    let mainCall = 0;
    const model = new FakeModel((prompt) => {
      if (isRollingSummary(prompt)) return response(JSON.stringify({ summary: 'Round one assistant answer.' }));
      mainCall += 1;
      return response(mainCall === 1 ? 'Round one assistant answer.' : 'Round two assistant answer.');
    });
    const env = await setupRuntime(model, { plugins: [rollingContextPlugin, previewServicePlugin] });
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'rolling-lifecycle-first', 'private first user message');
      await env.runtime.drain();

      expect(model.prompts.filter(isRollingSummary)).toHaveLength(0);
      expect(previewModelInput).toBeTypeOf('function');
      const preview = await previewModelInput!(thread.id);
      expect(preview.modelStep).toBe(false);
      expect(model.prompts.filter(isRollingSummary)).toHaveLength(0);

      await env.runtime.executeCommand(thread.id, 'rolling-lifecycle-manual-compact', '/compact');
      expect(model.prompts.filter(isRollingSummary)).toHaveLength(0);

      await env.runtime.submit(thread.id, 'rolling-lifecycle-second', 'second user message');
      await env.runtime.drain();

      const summaryPrompts = model.prompts.filter(isRollingSummary);
      expect(summaryPrompts).toHaveLength(1);
      const summaryInput = JSON.stringify(summaryPrompts[0]!.turns);
      expect(summaryInput).toContain('Round one assistant answer.');
      expect(summaryInput).not.toContain('private first user message');
      expect(summaryInput).not.toContain('second user message');
      expect(model.prompts.at(-1)?.turns).toContainEqual(
        expect.objectContaining({ kind: 'message', role: 'user', content: 'second user message' }),
      );
      expect(model.prompts.at(-1)?.turns).toContainEqual(
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          content: expect.stringContaining('Round one assistant answer.'),
        }),
      );

      const summaryIndex = model.prompts.findIndex(isRollingSummary);
      expect(summaryIndex).toBeGreaterThan(0);
      expect(model.prompts.slice(0, summaryIndex).filter((prompt) => !isRollingSummary(prompt))).toHaveLength(1);
      expect(model.prompts.slice(summaryIndex + 1).filter((prompt) => !isRollingSummary(prompt))).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it('summarizes a complete assistant tool round after its result and before the next main model step', async () => {
    let mainCall = 0;
    const model = new FakeModel((prompt) => {
      if (isRollingSummary(prompt)) return response(JSON.stringify({ summary: 'Tool round summary.' }));
      mainCall += 1;
      if (mainCall === 1)
        return response('Checking now.', [
          { id: 'rolling-lifecycle-call', name: 'rolling_lifecycle_tool', arguments: { query: 'tool evidence' } },
        ]);
      return response('Finished after the tool result.');
    });
    const toolPlugin: PicoPlugin = {
      id: 'example.rolling-lifecycle-tool',
      name: 'Rolling lifecycle tool',
      version: '1',
      defaultToolsEnabled: true,
      activate({ tools }) {
        tools.register(
          {
            name: 'rolling_lifecycle_tool',
            description: 'Return deterministic evidence for the lifecycle test.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          },
          () => 'tool evidence result',
        );
      },
    };
    const env = await setupRuntime(model, { plugins: [rollingContextPlugin, toolPlugin] });
    const thread = env.createThread('runtime');
    try {
      await env.runtime.submit(thread.id, 'rolling-tool-round', 'private user request for a tool check');
      await env.runtime.drain();

      const summaryIndexes = model.prompts.flatMap((prompt, index) => (isRollingSummary(prompt) ? [index] : []));
      expect(summaryIndexes).toHaveLength(1);
      const summaryIndex = summaryIndexes[0]!;
      const summaryInput = JSON.stringify(model.prompts[summaryIndex]!.turns);
      expect(summaryInput).toContain('Checking now.');
      expect(summaryInput).toContain('rolling_lifecycle_tool');
      expect(summaryInput).toContain('tool evidence result');
      expect(summaryInput).not.toContain('private user request for a tool check');
      expect(model.prompts[summaryIndex - 1]!.turns).toContainEqual(
        expect.objectContaining({ kind: 'message', role: 'user', content: 'private user request for a tool check' }),
      );
      expect(JSON.stringify(model.prompts[summaryIndex + 1]!.turns)).toContain('tool evidence result');
      expect(env.store.listRecords(thread.id).some((record) => record.kind === 'tool_result')).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  async function runRollingCompactScenario(configureEconomics: boolean) {
    const rawRoundOne = `ROUND_ONE_RAW_FACT ${'A'.repeat(700)}`;
    const rawRoundTwo = `ROUND_TWO_RAW_FACT ${'B'.repeat(700)}`;
    let mainCall = 0;
    const model = new FakeModel((prompt) => {
      if (isRollingSummary(prompt)) {
        const source = JSON.stringify(prompt.turns);
        return response(
          JSON.stringify({
            summary: source.includes('ROUND_ONE_RAW_FACT')
              ? 'ROUND_ONE_WARM_SUMMARY'
              : source.includes('ROUND_TWO_RAW_FACT')
                ? 'ROUND_TWO_WARM_SUMMARY'
                : 'ROLLING_COMPACT_CALL_SUMMARY',
          }),
        );
      }
      mainCall += 1;
      if (mainCall === 1) return response(rawRoundOne);
      if (mainCall === 2) return response(rawRoundTwo);
      if (mainCall === 3)
        return response('', [
          {
            id: 'rolling-compact-call',
            name: 'rolling_compact',
            arguments: { keep_recent_rounds: 1 },
          },
        ]);
      return response('Continuation after rolling_compact.');
    });
    const env = await setupRuntime(model, { plugins: [rollingContextPlugin] });
    const thread = env.createThread('runtime');
    try {
      if (configureEconomics) {
        const selection = env.runtime.threadModelSelection(thread.id);
        const route = env.runtime.pluginHttpRoute('pico.rolling-context', 'PUT', '/economics');
        expect(route).toBeDefined();
        await route!.handler({
          body: {
            threadId: thread.id,
            provider: selection.provider,
            model: selection.model,
            inputPerMillion: 100,
            cachedInputPerMillion: 100,
            cacheWritePerMillion: 0,
            expectedFutureCalls: 10,
            charactersPerToken: 1,
          },
          query: new URLSearchParams(),
          origin: null,
        });
      }
      await env.runtime.submit(thread.id, 'rolling-compact-user-1', 'USER_ONE_PRIVATE_SOURCE');
      await env.runtime.drain();
      await env.runtime.submit(thread.id, 'rolling-compact-user-2', 'USER_TWO_PRIVATE_SOURCE');
      await env.runtime.drain();
      await env.runtime.submit(thread.id, 'rolling-compact-user-3', 'USER_THREE_PRIVATE_SOURCE');
      await env.runtime.drain();

      const toolResult = env.store
        .listRecords(thread.id)
        .find((record) => record.kind === 'tool_result' && record.payload.toolName === 'rolling_compact');
      return {
        finalTurns: structuredClone(model.prompts.at(-1)!.turns),
        rollingSummaryInputs: model.prompts.filter(isRollingSummary).map((prompt) => JSON.stringify(prompt.turns)),
        toolResult: toolResult?.payload.result,
      };
    } finally {
      await env.cleanup();
    }
  }

  it('uses positive configured economics to warm only older rounds and preserves every user capsule', async () => {
    const result = await runRollingCompactScenario(true);
    const finalInput = JSON.stringify(result.finalTurns);

    expect(result.toolResult).toMatchObject({
      status: 'compacted',
      estimate: { status: 'estimated', keepRecentRounds: 1 },
    });
    expect(finalInput).toContain('ROUND_ONE_WARM_SUMMARY');
    expect(finalInput).not.toContain('ROUND_ONE_RAW_FACT');
    expect(finalInput).toContain('ROUND_TWO_RAW_FACT');
    expect(finalInput).toContain('USER_ONE_PRIVATE_SOURCE');
    expect(finalInput).toContain('USER_TWO_PRIVATE_SOURCE');
    expect(finalInput).toContain('USER_THREE_PRIVATE_SOURCE');
    expect(result.rollingSummaryInputs.some((input) => input.includes('USER_ONE_PRIVATE_SOURCE'))).toBe(false);
    expect(result.rollingSummaryInputs.some((input) => input.includes('USER_TWO_PRIVATE_SOURCE'))).toBe(false);
  });

  it('leaves candidate rounds raw when economics are missing', async () => {
    const result = await runRollingCompactScenario(false);
    const finalInput = JSON.stringify(result.finalTurns);

    expect(result.toolResult).toMatchObject({ status: 'cannot_estimate' });
    expect(finalInput).toContain('ROUND_ONE_RAW_FACT');
    expect(finalInput).toContain('ROUND_TWO_RAW_FACT');
    expect(finalInput).not.toContain('ROUND_ONE_WARM_SUMMARY');
    expect(finalInput).toContain('USER_ONE_PRIVATE_SOURCE');
    expect(finalInput).toContain('USER_TWO_PRIVATE_SOURCE');
    expect(finalInput).toContain('USER_THREE_PRIVATE_SOURCE');
  });
});
