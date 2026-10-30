import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { FakeModel, response, setupRuntime } from './helpers.js';
import { rollingContextPlugin } from '../src/plugins/rolling-context.js';
import type { PicoRuntime } from '../src/runtime/runtime.js';
import type { Thread } from '../src/core/types.js';
import type { ModelPrompt } from '../src/contracts/model.js';

type ProjectedPrompt = Pick<ModelPrompt, 'tools' | 'turns'> & { systemPrompt: string };

async function compactProjected(runtime: PicoRuntime, thread: Thread) {
  const records = runtime.store.listRecords(thread.id);
  const projection = await runtime['projectModelInput'](thread, records, records.at(-1)?.seq ?? 0);
  const result = await runtime['compactThread'](thread, false, false, projection);
  return { projection, result };
}

function isCompactionPrompt(prompt: ModelPrompt) {
  const finalTurn = prompt.turns.at(-1);
  return (
    finalTurn?.kind === 'message' && finalTurn.role === 'user' && /summarize this conversation/i.test(finalTurn.content)
  );
}

function expectCompactionPromptMatchesProjection(prompt: ModelPrompt, projection: ProjectedPrompt) {
  expect(prompt.system).toBe(projection.systemPrompt);
  expect(prompt.tools).toEqual(projection.tools);
  expect(prompt.turns.slice(0, projection.turns.length)).toEqual(projection.turns);
  expect(prompt.turns).toHaveLength(projection.turns.length + 1);
  expect(isCompactionPrompt(prompt)).toBe(true);
}

describe('projected compaction', () => {
  it.each([true, false])('summarizes the projected canonical prefix with rolling enabled: %s', async (rolling) => {
    const model = new FakeModel(() => response('Condensed earlier history.'));
    const env = await setupRuntime(
      model,
      rolling ? { plugins: [rollingContextPlugin] } : { disabledBuiltinPlugins: ['pico.rolling-context'] },
    );
    expect(env.runtime.plugins.list().some((plugin) => plugin.id === 'pico.rolling-context')).toBe(rolling);
    const thread = env.createThread('runtime');
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let n = 1; n <= 4; n++) {
        const user = env.store.appendCanonical(thread.id, `map-user-${n}`, 'message', {
          role: 'user',
          source: 'user',
          content: `request ${n}`,
        });
        env.store.appendCanonical(thread.id, `map-assistant-${n}`, 'assistant', {
          content: `answer ${n}`,
          toolCalls: [],
          batchId: null,
          projectionThrough: user.record.seq,
          usage: null,
          model: 'test-model',
        });
      }
      const first = await compactProjected(env.runtime, thread);
      expect(first.result.text).toContain('Compacted 2 completed model invocation(s)');
      const firstPrompt = model.prompts.filter(isCompactionPrompt)[0]!;
      expectCompactionPromptMatchesProjection(firstPrompt, first.projection);
      expect(JSON.stringify(firstPrompt.turns)).toContain('request 1');
      expect(JSON.stringify(firstPrompt.turns)).toContain('request 3');
      for (let n = 5; n <= 6; n++) {
        const user = env.store.appendCanonical(thread.id, `map-user-${n}`, 'message', {
          role: 'user',
          source: 'user',
          content: `request ${n}`,
        });
        env.store.appendCanonical(thread.id, `map-assistant-${n}`, 'assistant', {
          content: `answer ${n}`,
          toolCalls: [],
          batchId: null,
          projectionThrough: user.record.seq,
          usage: null,
          model: 'test-model',
        });
      }
      const second = await compactProjected(env.runtime, thread);
      expect(second.result.text).toContain('Compacted');
      const secondPrompt = model.prompts.filter(isCompactionPrompt)[1]!;
      expectCompactionPromptMatchesProjection(secondPrompt, second.projection);
      expect(JSON.stringify(secondPrompt.turns)).toContain('Condensed earlier history.');
      expect(JSON.stringify(secondPrompt.turns)).toContain('request 5');
    } finally {
      await env.runtime.shutdown();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });
});

describe('context changes followed by projected compaction', () => {
  it.each(['restore', 'rewind'] as const)('preserves the active history after %s', async (action) => {
    const model = new FakeModel(() => response('Summary 1'));
    const env = await setupRuntime(model, { plugins: [rollingContextPlugin] });
    const thread = env.createThread('runtime');
    const append = (prefix: string, n: number) => {
      const user = env.store.appendCanonical(thread.id, `${prefix}-user-${n}`, 'message', {
        role: 'user',
        source: 'user',
        content: `${prefix} request ${n}`,
      });
      env.store.appendCanonical(thread.id, `${prefix}-assistant-${n}`, 'assistant', {
        content: `${prefix} answer ${n}`,
        toolCalls: [],
        batchId: null,
        projectionThrough: user.record.seq,
        usage: null,
        model: 'test-model',
      });
    };
    try {
      env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
      for (let n = 1; n <= 6; n++) append('old', n);
      const first = await compactProjected(env.runtime, thread);
      expect(first.result.text).toContain('Compacted');
      if (action === 'restore') env.runtime.restoreContextCheckpoint(thread.id);
      else env.runtime.rewindContextToMessage(thread.id, 'old-assistant-2');
      for (let n = 1; n <= 4; n++) append('new', n);
      const second = await compactProjected(env.runtime, thread);
      expect(second.result.text).toContain('Compacted');
      const secondPrompt = model.prompts.filter(isCompactionPrompt)[1]!;
      expectCompactionPromptMatchesProjection(secondPrompt, second.projection);
      const source = JSON.stringify(secondPrompt.turns);
      expect(source).toContain('new request 1');
      expect(source).toContain('new request 3');
      expect(source).not.toContain('old request 5');
      expect(source).not.toContain('old request 6');
      if (action === 'rewind') {
        expect(source).toContain('old request 1');
        expect(source).not.toContain('old request 3');
      }
      if (action === 'restore') expect(source).toContain('Summary 1');
      else {
        expect(source).not.toContain('Summary 1');
      }
      const records = env.store.listRecords(thread.id);
      expect(records.some((record) => record.id === 'old-user-6')).toBe(true);
      const compactions = records.filter(
        (record) => record.kind === 'plugin' && record.payload.action === 'context-compacted',
      );
      expect(compactions).toHaveLength(2);
      const sourceIds = compactions[1]!.payload.sourceRecordIds as string[];
      expect(sourceIds).toContain('new-user-1');
      if (action === 'rewind') {
        expect(sourceIds).toContain('old-user-1');
        expect(sourceIds).not.toContain('old-user-3');
        expect(sourceIds).not.toContain('old-user-6');
      } else {
        expect(sourceIds).toContain('old-user-4');
        expect(sourceIds).not.toContain('old-user-6');
      }
    } finally {
      await env.runtime.shutdown();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });
});

it('does not run Runtime fallback from stale usage after a much smaller full projection', async () => {
  const rawFirstRound = `LARGE_FIRST_ROUND ${'A'.repeat(30_000)}`;
  const rawSecondRound = `SECOND_ROUND ${'B'.repeat(2_000)}`;
  let mainCalls = 0;
  const withUsage = (content: string, toolCalls: ReturnType<typeof response>['toolCalls'], inputTokens: number) => ({
    ...response(content, toolCalls),
    usage: { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20 },
  });
  const isRollingSummary = (prompt: { system: string }) =>
    prompt.system.includes('Summarize exactly one sealed model-response round');
  const isRuntimeSummary = isCompactionPrompt;
  const model = new FakeModel((prompt) => {
    if (isRollingSummary(prompt)) return response(JSON.stringify({ summary: 'FIRST_ROUND_WARM_SUMMARY' }));
    mainCalls += 1;
    if (mainCalls === 1) return withUsage(rawFirstRound, [], 100);
    if (mainCalls === 2) return withUsage(rawSecondRound, [], 100);
    if (mainCalls === 3)
      return withUsage(
        '',
        [{ id: 'compact-large-round', name: 'rolling_compact', arguments: { keep_recent_rounds: 1 } }],
        1_500,
      );
    return withUsage('Continued from the warm summary.', [], 100);
  });
  const env = await setupRuntime(model, { plugins: [rollingContextPlugin] });
  const thread = env.createThread();
  try {
    env.runtime.updateContextManagementSettings({
      contextWindowTokens: 1_000_000,
      compactionThresholdTokens: 1_000,
      keepRecentTokens: 1,
    });
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
      },
      query: new URLSearchParams(),
      origin: null,
    });

    await env.runtime.submit(thread.id, 'fallback-small-projection-1', 'FIRST_USER_CAPSULE');
    await env.runtime.drain();
    await env.runtime.submit(thread.id, 'fallback-small-projection-2', 'SECOND_USER_CAPSULE');
    await env.runtime.drain();
    await env.runtime.submit(thread.id, 'fallback-small-projection-3', 'THIRD_USER_CAPSULE');
    await env.runtime.drain();

    const records = env.store.listRecords(thread.id);
    expect(
      records.some((record) => record.kind === 'tool_result' && record.payload.toolName === 'rolling_compact'),
    ).toBe(true);
    expect(
      records.filter((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted'),
    ).toHaveLength(0);
    expect(model.prompts.some(isRuntimeSummary)).toBe(false);
    expect(env.runtime.getThread(thread.id)?.state).not.toBe('paused');
    const continuation = model.prompts.filter((prompt) => !isRollingSummary(prompt)).at(-1)!;
    const serializedTurns = JSON.stringify(continuation.turns);
    expect(serializedTurns).toContain('FIRST_ROUND_WARM_SUMMARY');
    expect(serializedTurns).not.toContain('LARGE_FIRST_ROUND');
    expect(serializedTurns).toContain('SECOND_ROUND');
    expect(serializedTurns).toContain('THIRD_USER_CAPSULE');
  } finally {
    await env.cleanup();
  }
});

it('checks a large new user input against the full projected prompt without provider usage', async () => {
  const model = new FakeModel(() => response('This request must not be sent.'));
  const env = await setupRuntime(model);
  const thread = env.createThread('runtime');
  try {
    const emptyProjection = await env.runtime['projectModelInput'](thread, [], 0);
    const emptyRequestSize = JSON.stringify({
      system: emptyProjection.systemPrompt,
      tools: emptyProjection.tools,
      turns: emptyProjection.turns,
      model: env.runtime.threadModelSelection(thread.id).model,
      temperature: env.runtime.threadModelSelection(thread.id).parameters.temperature ?? 0.7,
    }).length;
    const contextWindowTokens = emptyRequestSize + 1_000;
    env.runtime.updateContextManagementSettings({
      contextWindowTokens,
      compactionThresholdTokens: contextWindowTokens - 1,
      keepRecentTokens: 1,
    });
    await env.runtime.submit(thread.id, 'large-input-without-usage', `Large new request ${'X'.repeat(5_000)}`);
    await env.runtime.drain();

    expect(model.prompts).toHaveLength(0);
    expect(env.runtime.getThread(thread.id)).toMatchObject({
      state: 'paused',
      pauseReason: expect.stringContaining('There are no completed model invocations'),
    });
  } finally {
    await env.cleanup();
  }
});

it('respects unknown grouped boundaries and preserves the complete plugin projection', async () => {
  const plugin: import('../src/plugins/host.js').PicoPlugin = {
    id: 'example.unknown-projector',
    name: 'Unknown projector',
    version: '1',
    activate({ pipelines }) {
      pipelines.use('projection', async (input, next) => {
        const sources = input.provenance!.filter((item) => item.kind === 'canonical');
        const grouped = sources.slice(1, 3);
        const first = grouped[0]!,
          last = grouped[1]!;
        const start = first.turnStartIndex!,
          end = last.turnEndIndex!;
        const removed = end - start - 1;
        const provenance = input
          .provenance!.filter((item) => !grouped.includes(item))
          .map((item) => ({
            ...item,
            ...(item.turnStartIndex !== undefined && item.turnStartIndex >= end
              ? { turnStartIndex: item.turnStartIndex - removed }
              : {}),
            ...(item.turnEndIndex !== undefined && item.turnEndIndex >= end
              ? { turnEndIndex: item.turnEndIndex - removed }
              : {}),
          }));
        const turns = [
          ...input.turns.slice(0, start),
          { kind: 'message' as const, role: 'user' as const, content: 'Grouped plugin summary' },
          ...input.turns.slice(end),
        ];
        provenance.push({
          id: 'grouped',
          sourcePluginId: 'example.unknown-projector',
          label: 'Grouped summary',
          kind: 'rolling_segment',
          disposition: 'summary',
          canonicalStartSeq: first.canonicalStartSeq!,
          canonicalEndSeq: last.canonicalEndSeq!,
          turnStartIndex: start,
          turnEndIndex: start + 1,
        });
        provenance.push({
          id: 'context',
          sourcePluginId: 'example.unknown-projector',
          label: 'Context',
          kind: 'plugin',
          disposition: 'raw',
          turnIndex: turns.length,
        });
        turns.push({ kind: 'message', role: 'user', content: 'Separate plugin context remains available' });
        return next({ ...input, turns, provenance });
      });
    },
  };
  const model = new FakeModel(() => response('Summary'));
  const env = await setupRuntime(model, { plugins: [plugin] });
  const thread = env.createThread('runtime');
  try {
    env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
    for (let n = 1; n <= 4; n++) {
      const user = env.store.appendCanonical(thread.id, `unknown-user-${n}`, 'message', {
        role: 'user',
        source: 'user',
        content: `unknown request ${n}`,
      });
      env.store.appendCanonical(thread.id, `unknown-assistant-${n}`, 'assistant', {
        content: `unknown answer ${n}`,
        toolCalls: [],
        batchId: null,
        projectionThrough: user.record.seq,
        usage: null,
        model: 'test-model',
      });
    }
    const compacted = await compactProjected(env.runtime, thread);
    expect(compacted.result.text).toContain('Compacted 1 completed model invocation');
    const prompt = model.prompts.filter(isCompactionPrompt)[0]!;
    expectCompactionPromptMatchesProjection(prompt, compacted.projection);
    const promptText = JSON.stringify(prompt.turns);
    expect(promptText).toContain('unknown request 1');
    expect(promptText).not.toContain('unknown request 2');
    expect(promptText).not.toContain('unknown request 3');
    expect(promptText).toContain('Grouped plugin summary');
    expect(promptText).toContain('Separate plugin context remains available');
    const compaction = env.store
      .listRecords(thread.id)
      .find((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted')!;
    expect(compaction.payload.sourceRecordIds).toEqual(['unknown-user-1', 'unknown-assistant-1']);
  } finally {
    await env.runtime.shutdown();
    env.store.close();
    await rm(env.directory, { recursive: true, force: true });
  }
});

it('compacts complete tool invocations inside a single user turn without splitting results', async () => {
  const model = new FakeModel(() => response('Summary'));
  const env = await setupRuntime(model);
  const thread = env.createThread('runtime');
  try {
    env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
    const user = env.store.appendCanonical(thread.id, 'single-user', 'message', {
      role: 'user',
      source: 'user',
      content: 'one request',
    });
    for (let n = 1; n <= 4; n++) {
      const calls = n < 4 ? [{ id: `call-${n}`, name: 'example', arguments: {} }] : [];
      env.store.appendCanonical(thread.id, `single-assistant-${n}`, 'assistant', {
        content: `assistant ${n}`,
        toolCalls: calls,
        batchId: n < 4 ? `batch-${n}` : null,
        projectionThrough: user.record.seq,
        usage: null,
        model: 'test-model',
      });
      if (n < 4)
        env.store.appendCanonical(thread.id, `single-${n}:result`, 'tool_result', {
          batchId: `batch-${n}`,
          toolCallId: `call-${n}`,
          toolName: 'example',
          executionId: `single-${n}`,
          result: `result ${n}`,
        });
    }
    const records = env.store.listRecords(thread.id);
    const projection = await env.runtime['projectModelInput'](thread, records, records.at(-1)!.seq);
    expect(projection.turns.filter((turn) => turn.kind === 'assistant_tools')).toHaveLength(3);
    expect(projection.turns.filter((turn) => turn.kind === 'tool_result')).toHaveLength(3);
    const result = await env.runtime['compactThread'](thread, false, false, projection);
    expect(result.text).toContain('Compacted 2 completed model invocation');
    const compaction = env.store
      .listRecords(thread.id)
      .find((record) => record.kind === 'plugin' && record.payload.action === 'context-compacted')!;
    expect(compaction.payload.sourceRecordIds).toEqual([
      'single-user',
      'single-assistant-1',
      'single-1:result',
      'single-assistant-2',
      'single-2:result',
    ]);
    const prompt = model.prompts.filter(isCompactionPrompt)[0]!;
    expectCompactionPromptMatchesProjection(prompt, projection);
    const promptText = JSON.stringify(prompt.turns);
    expect(promptText).toContain('assistant 2');
    expect(promptText).toContain('assistant 3');
  } finally {
    await env.runtime.shutdown();
    env.store.close();
    await rm(env.directory, { recursive: true, force: true });
  }
});

it('manual compaction summarizes the final plugin projection rather than Canonical source text', async () => {
  const projector: import('../src/plugins/host.js').PicoPlugin = {
    id: 'example.compaction-redactor',
    name: 'Compaction redactor',
    version: '1',
    activate({ pipelines }) {
      pipelines.use('projection', async (input, next) =>
        next({
          ...input,
          turns: input.turns.map((turn) =>
            turn.kind === 'message' && turn.content.includes('private canonical request')
              ? { ...turn, content: 'safe projected request' }
              : turn,
          ),
        }),
      );
    },
  };
  const model = new FakeModel(() => response('Summary based on safe projection'));
  const env = await setupRuntime(model, { plugins: [projector] });
  const thread = env.createThread('runtime');
  try {
    env.runtime.updateContextManagementSettings({ keepRecentTokens: 1 });
    for (let n = 1; n <= 4; n++) {
      const user = env.store.appendCanonical(thread.id, `manual-user-${n}`, 'message', {
        role: 'user',
        source: 'user',
        content: n === 1 ? 'private canonical request' : `request ${n}`,
      });
      env.store.appendCanonical(thread.id, `manual-assistant-${n}`, 'assistant', {
        content: `answer ${n}`,
        toolCalls: [],
        batchId: null,
        projectionThrough: user.record.seq,
        usage: null,
        model: 'test-model',
      });
    }

    const records = env.store.listRecords(thread.id);
    const projection = await env.runtime['projectModelInput'](thread, records, records.at(-1)!.seq);
    const result = await env.runtime['compactThread'](thread, false, false, projection);

    expect(result.text).toContain('Compacted');
    const prompt = model.prompts.find(isCompactionPrompt)!;
    expectCompactionPromptMatchesProjection(prompt, projection);
    const promptText = JSON.stringify(prompt.turns);
    expect(promptText).toContain('safe projected request');
    expect(promptText).not.toContain('private canonical request');
  } finally {
    await env.runtime.shutdown();
    env.store.close();
    await rm(env.directory, { recursive: true, force: true });
  }
});
