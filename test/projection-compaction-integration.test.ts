import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { FakeModel, response, setupRuntime } from './helpers.js';
import { rollingContextPlugin } from '../src/plugins/rolling-context.js';
import type { PicoRuntime } from '../src/runtime/runtime.js';
import type { Thread } from '../src/core/types.js';

async function compactProjected(runtime: PicoRuntime, thread: Thread) {
  const records = runtime.store.listRecords(thread.id);
  const projection = await runtime['projectModelInput'](thread, records, records.at(-1)?.seq ?? 0);
  return runtime['compactThread'](thread, false, false, projection);
}

describe('projected compaction', () => {
  it.each([true, false])('summarizes the projected canonical prefix with rolling enabled: %s', async (rolling) => {
    const model = new FakeModel(() => response('Condensed earlier history.'));
    const env = await setupRuntime(
      model,
      rolling ? { plugins: [rollingContextPlugin] } : { disabledBuiltinPlugins: ['pico.rolling-context'] },
    );
    expect(env.runtime.plugins.list().some((plugin) => plugin.id === 'pico.rolling-context')).toBe(rolling);
    const thread = env.runtime.createThread(env.project.id, 'runtime');
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
      const result = await compactProjected(env.runtime, thread);
      expect(result.text).toContain('Compacted 2 completed model invocation(s)');
      expect(
        JSON.stringify(
          model.prompts.filter((prompt) =>
            prompt.system.startsWith("You are Pico Runtime's conversation compaction helper"),
          )[0],
        ),
      ).toContain('request 1');
      expect(
        JSON.stringify(
          model.prompts.filter((prompt) =>
            prompt.system.startsWith("You are Pico Runtime's conversation compaction helper"),
          )[0],
        ),
      ).not.toContain('request 3');
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
      expect(second.text).toContain('Compacted');
      expect(
        JSON.stringify(
          model.prompts.filter((prompt) =>
            prompt.system.startsWith("You are Pico Runtime's conversation compaction helper"),
          )[1],
        ),
      ).toContain('Condensed earlier history.');
      expect(
        JSON.stringify(
          model.prompts.filter((prompt) =>
            prompt.system.startsWith("You are Pico Runtime's conversation compaction helper"),
          )[1],
        ),
      ).not.toContain('request 5');
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
    const thread = env.runtime.createThread(env.project.id, 'runtime');
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
      expect(first.text).toContain('Compacted');
      if (action === 'restore') env.runtime.restoreContextCheckpoint(thread.id);
      else env.runtime.rewindContextToMessage(thread.id, 'old-assistant-2');
      for (let n = 1; n <= 4; n++) append('new', n);
      const second = await compactProjected(env.runtime, thread);
      expect(second.text).toContain('Compacted');
      const source = JSON.stringify(
        model.prompts.filter((prompt) =>
          prompt.system.startsWith("You are Pico Runtime's conversation compaction helper"),
        )[1],
      );
      expect(source).toContain('new request 1');
      expect(source).not.toContain('new request 3');
      expect(source).not.toContain('old request 5');
      expect(source).not.toContain('old request 6');
      if (action === 'restore') expect(source).toContain('Summary 1');
      else {
        expect(source).toContain('old request 1');
        expect(source).not.toContain('old request 3');
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

it('respects an unknown plugin grouped boundary without summarizing plugin context', async () => {
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
        turns.push({ kind: 'message', role: 'user', content: 'Plugin context must be excluded' });
        return next({ ...input, turns, provenance });
      });
    },
  };
  const model = new FakeModel(() => response('Summary'));
  const env = await setupRuntime(model, { plugins: [plugin] });
  const thread = env.runtime.createThread(env.project.id, 'runtime');
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
    const result = await compactProjected(env.runtime, thread);
    expect(result.text).toContain('Compacted 1 completed model invocation');
    const prompt = JSON.stringify(model.prompts[0]);
    expect(prompt).toContain('unknown request 1');
    expect(prompt).not.toContain('unknown request 2');
    expect(prompt).not.toContain('unknown request 3');
    expect(prompt).not.toContain('Plugin context must be excluded');
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
  const thread = env.runtime.createThread(env.project.id, 'runtime');
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
    const prompt = JSON.stringify(model.prompts[0]);
    expect(prompt).toContain('assistant 2');
    expect(prompt).not.toContain('assistant 3');
  } finally {
    await env.runtime.shutdown();
    env.store.close();
    await rm(env.directory, { recursive: true, force: true });
  }
});
