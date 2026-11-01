import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from '../src/contracts/plugin-pipeline.js';
import type { ProjectionProvenance } from '../src/contracts/runtime.js';
import type { CanonicalRecord, ThreadModelSelection } from '../src/core/types.js';
import { buildProviderObservedContextTokenHistory, buildProviderObservedSegmentLedger } from '../src/runtime/context-token-history.js';

const selection: ThreadModelSelection = {
  provider: 'provider-a',
  connectionId: 'connection-a',
  model: 'model-a',
  modelId: 'model-id-a',
  adapterId: 'adapter-a',
  parameters: { temperature: 0.7, options: {} },
};
const thread = {
  id: 'thread-a', projectId: 'project-a', executorId: 'executor-a', executorKind: 'container' as const,
  executorRemote: false, executorLabel: 'container', workspacePath: '/workspace', title: 'Thread',
  parentThreadId: null, createdByAgent: false, pauseRequested: false, pauseReason: null,
  createdAt: '2026-01-01T00:00:00.000Z', state: 'idle' as const,
};

function pluginRecord(
  seq: number,
  executionId: string,
  prompt: Record<string, unknown>,
  provenance: unknown[],
) {
  return {
    id: `input-${executionId}`, threadId: thread.id, seq, kind: 'plugin' as const,
    payload: {
      pluginId: 'pico.runtime', action: 'model-input-recorded', executionId,
      requestId: `request-${executionId}`, prompt, promptSummary: {}, projectionProvenance: provenance,
      tokenAccountingSelection: selection,
    },
    createdAt: new Date(seq).toISOString(),
  };
}

function assistantRecord(seq: number, executionId: string, usage: Record<string, unknown>) {
  return {
    id: `${executionId}:assistant`, threadId: thread.id, seq, kind: 'assistant' as const,
    payload: {
      modelId: selection.modelId, adapterId: selection.adapterId, provider: selection.provider,
      model: selection.model, content: `answer-${executionId}`, toolCalls: [], batchId: null,
      projectionThrough: seq - 1, usage, finishReason: 'stop',
    },
    createdAt: new Date(seq).toISOString(),
  };
}

function prompt(turns: unknown[]) {
  return { version: 1, system: 'system', turns, tools: [], model: selection.model, temperature: 0.7 };
}

function rawProv(id: string, start: number, end: number, turnStartIndex = 0): ProjectionProvenance {
  return {
    id, sourcePluginId: 'pico.rolling-context', label: id, kind: 'rolling_segment', disposition: 'raw',
    canonicalStartSeq: start, canonicalEndSeq: end, turnStartIndex, turnEndIndex: turnStartIndex + 1,
  };
}

function projection(
  turns: ProjectionInput['turns'],
  provenance: NonNullable<ProjectionInput['provenance']>,
): ProjectionInput {
  return {
    thread, records: [], through: 20, systemPrompt: 'system', turns, tools: [], provenance,
  };
}

function assistantTurn(content: string) {
  return { kind: 'message' as const, role: 'assistant' as const, content };
}

function assistantToolsTurn(content: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return { kind: 'assistant_tools' as const, content, calls };
}

function userRecord(seq: number, id: string, content: string) {
  return {
    id, threadId: thread.id, seq, kind: 'message' as const,
    payload: { role: 'user', content, source: 'user' }, createdAt: new Date(seq).toISOString(),
  };
}

function summaryProvenance(record: CanonicalRecord, visibleTokens?: number, callId = 'summary-call-1'): ProjectionProvenance {
  const sourceHash = createHash('sha256').update(JSON.stringify([record], null, 2)).digest('hex');
  const segmentId = `rc-${createHash('sha256')
    .update(`${thread.id}:${record.seq}:${record.seq}:${sourceHash}`)
    .digest('hex')
    .slice(0, 20)}`;
  return {
    id: `rolling:${segmentId}`, sourcePluginId: 'pico.rolling-context', label: 'summary',
    kind: 'rolling_segment', disposition: 'summary',
    canonicalStartSeq: record.seq, canonicalEndSeq: record.seq,
    summaryVersion: `direct-summary-v2:${sourceHash.slice(0, 12)}`,
    summaryCallId: callId,
    ...(visibleTokens === undefined ? {} : { summaryResponseVisibleTokens: visibleTokens }),
    turnStartIndex: 0, turnEndIndex: 1,
  };
}

function summaryCall(
  record: CanonicalRecord,
  content: string,
  visibleTokens: number,
  id = 'summary-call-1',
  retrySuffix = '',
) {
  const sourceHash = createHash('sha256').update(JSON.stringify([record], null, 2)).digest('hex');
  const segmentId = `rc-${createHash('sha256')
    .update(`${thread.id}:${record.seq}:${record.seq}:${sourceHash}`)
    .digest('hex')
    .slice(0, 20)}`;
  return {
    id,
    pluginId: 'pico.rolling-context',
    idempotencyKey: `summary:direct-summary-v2:${segmentId}${retrySuffix}:${sourceHash}`,
    threadId: thread.id, projectId: thread.projectId, purpose: 'rolling-summary', provider: selection.provider,
    model: selection.model, prompt: { tokenAccountingSelection: selection }, status: 'completed' as const,
    response: { content, usage: { outputTokens: visibleTokens, reasoningTokens: 0 } },
    usage: { outputTokens: visibleTokens, reasoningTokens: 0 }, attempts: [], error: null,
    createdAt: new Date(10).toISOString(), updatedAt: new Date(11).toISOString(),
  };
}

describe('provider observed context token history', () => {
  it('uses a durable assistant usage snapshot even when the first input has no provider usage', () => {
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      assistantRecord(2, 'exec-1', { outputTokens: 2 }),
      pluginRecord(3, 'exec-2', prompt([assistantTurn('answer-exec-1')]), [rawProv('rolling:raw:2', 2, 2)]),
      assistantRecord(4, 'exec-2', { inputTokens: 15, outputTokens: 4, reasoningTokens: 1 }),
    ] as unknown as CanonicalRecord[];
    const result = buildProviderObservedContextTokenHistory(
      records,
      projection([assistantTurn('answer-exec-1')], [rawProv('rolling:raw:2', 2, 2)]),
      selection,
    );
    expect(result?.inputTokens).toBe(15);
    expect(result?.baselineExecutionId).toBe('exec-2');
    expect(result?.segmentLedger).toEqual([]);
  });

  it('measures one appended complete raw assistant segment from adjacent provider observations', () => {
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }),
      pluginRecord(3, 'exec-2', prompt([assistantTurn('answer-exec-1')]), [rawProv('rolling:raw:2', 2, 2)]),
      assistantRecord(4, 'exec-2', { inputTokens: 15, outputTokens: 4, reasoningTokens: 1 }),
    ] as unknown as CanonicalRecord[];
    const result = buildProviderObservedContextTokenHistory(
      records,
      projection([assistantTurn('answer-exec-1')], [rawProv('rolling:raw:2', 2, 2)]),
      selection,
    );
    expect(result?.segmentLedger).toEqual([
      expect.objectContaining({ id: 'rolling:raw:2:assistant:exec-1:assistant', startSeq: 2, endSeq: 2, tokenCount: 5 }),
    ]);
  });

  it('replaces a measured raw segment with a provider-counted rolling capsule', () => {
    const firstAssistant = assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      firstAssistant,
      pluginRecord(3, 'exec-2', prompt([assistantTurn('answer-exec-1')]), [rawProv('rolling:raw:2', 2, 2)]),
      assistantRecord(4, 'exec-2', { inputTokens: 15, outputTokens: 4, reasoningTokens: 1 }),
    ] as unknown as CanonicalRecord[];
    const capsule = summaryProvenance(firstAssistant as unknown as CanonicalRecord, 3);
    const summarized = projection([{ kind: 'message', role: 'assistant', content: 'summary text' }], [capsule]);
    const validCall = summaryCall(firstAssistant as unknown as CanonicalRecord, 'summary text', 3);
    const result = buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [validCall],
    );
    expect(result?.inputTokens).toBe(13);
    expect(buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [{ ...validCall, idempotencyKey: 'wrong-segment-key' }],
    )).toBeNull();
    expect(buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [{ ...validCall, purpose: 'other-summary-purpose' }],
    )).toBeNull();
    expect(buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [{ ...validCall, prompt: { tokenAccountingSelection: { ...selection, connectionId: 'another-connection' } } }],
    )).toBeNull();
    expect(buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [{ ...validCall, provider: 'another-provider', prompt: { tokenAccountingSelection: { ...selection, provider: 'another-provider' } } }],
    )).toBeNull();
    expect(buildProviderObservedContextTokenHistory(
      records,
      summarized,
      selection,
      [{ ...validCall, model: 'another-model', prompt: { tokenAccountingSelection: { ...selection, model: 'another-model' } } }],
    )).toBeNull();
    const retryProvenance = summaryProvenance(firstAssistant as unknown as CanonicalRecord, 3, 'summary-call-retry');
    const retryProjection = projection([{ kind: 'message', role: 'assistant', content: 'summary text' }], [retryProvenance]);
    const validRetry = summaryCall(
      firstAssistant as unknown as CanonicalRecord,
      'summary text',
      3,
      'summary-call-retry',
      '-retry-12abcdef',
    );
    expect(buildProviderObservedContextTokenHistory(records, retryProjection, selection, [validRetry])?.inputTokens).toBe(13);
    expect(buildProviderObservedContextTokenHistory(
      records,
      retryProjection,
      selection,
      [{ ...validRetry, idempotencyKey: validRetry.idempotencyKey.replace('12abcdef', '12abcdeg') }],
    )).toBeNull();
    expect(buildProviderObservedContextTokenHistory(
      records,
      retryProjection,
      selection,
      [{ ...validRetry, idempotencyKey: validRetry.idempotencyKey.replace('12abcdef', '1234567') }],
    )).toBeNull();
  });

  it('returns null for user or plugin changes and unknown summary/reasoning counts', () => {
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }),
      pluginRecord(3, 'exec-2', prompt([assistantTurn('answer-exec-1')]), [rawProv('rolling:raw:2', 2, 2)]),
      assistantRecord(4, 'exec-2', { inputTokens: 15, outputTokens: 4 }),
    ] as unknown as CanonicalRecord[];
    const extraUser = projection(
      [assistantTurn('answer-exec-1'), { kind: 'message', role: 'user', content: 'new user' }],
      [rawProv('rolling:raw:2', 2, 2)],
    );
    expect(buildProviderObservedContextTokenHistory(records, extraUser, selection)).toBeNull();
    const capsule = summaryProvenance(records[1]!, undefined);
    expect(buildProviderObservedContextTokenHistory(
      records,
      projection([{ kind: 'message', role: 'assistant', content: 'summary' }], [capsule]),
      selection,
    )).toBeNull();
  });

  it('rejects legacy snapshots without a persisted full model selection identity', () => {
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }),
    ] as unknown as CanonicalRecord[];
    const payload = records[0]!.payload as unknown as Record<string, unknown>;
    delete payload.tokenAccountingSelection;
    expect(buildProviderObservedContextTokenHistory(records, projection([], []), selection)).toBeNull();
  });

  it('rejects snapshots with opaque replay marker inside the prompt envelope', () => {
    const inputPrompt = { ...prompt([]), opaqueReplayPresent: true };
    const records = [
      pluginRecord(1, 'exec-1', inputPrompt, []),
      assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }),
    ] as unknown as CanonicalRecord[];
    expect(buildProviderObservedContextTokenHistory(records, projection([], []), selection)).toBeNull();
  });

  it('rejects snapshots from another provider connection or changed selection options', () => {
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 }),
    ] as unknown as CanonicalRecord[];
    const payload = records[0]!.payload as unknown as Record<string, unknown>;
    payload.tokenAccountingSelection = { ...selection, connectionId: 'other-connection' };
    expect(buildProviderObservedContextTokenHistory(records, projection([], []), selection)).toBeNull();
    payload.tokenAccountingSelection = { ...selection, parameters: { temperature: 0.7, options: { reasoning: 'high' } } };
    expect(buildProviderObservedContextTokenHistory(records, projection([], []), selection)).toBeNull();
  });

  it('splits user and assistant turns inside ordinary canonical provenance when Rolling is disabled', () => {
    const user1 = userRecord(1, 'user-1', 'first user request');
    const user2 = userRecord(4, 'user-2', 'second user request');
    const assistant1 = assistantRecord(3, 'exec-1', { inputTokens: 10, outputTokens: 4, reasoningTokens: 0 });
    const assistant2 = assistantRecord(6, 'exec-2', { inputTokens: 20, outputTokens: 5, reasoningTokens: 1 });
    const assistant3 = assistantRecord(8, 'exec-3', { inputTokens: 35, outputTokens: 2, reasoningTokens: 0 });
    const firstProv: ProjectionProvenance = {
      id: 'canonical:user-1', sourcePluginId: 'pico.core', label: 'first round',
      kind: 'canonical', disposition: 'raw', canonicalStartSeq: 1, canonicalEndSeq: 1,
      turnStartIndex: 0, turnEndIndex: 1,
    };
    const secondProv: ProjectionProvenance = {
      id: 'canonical:user-2', sourcePluginId: 'pico.core', label: 'second round',
      kind: 'canonical', disposition: 'raw', canonicalStartSeq: 4, canonicalEndSeq: 4,
      turnStartIndex: 2, turnEndIndex: 3,
    };
    const records = [
      user1,
      pluginRecord(2, 'exec-1', prompt([{ kind: 'message', role: 'user', content: 'first user request' }]), [firstProv]),
      assistant1,
      user2,
      pluginRecord(5, 'exec-2', prompt([
        { kind: 'message', role: 'user', content: 'first user request' }, assistantTurn('answer-exec-1'),
        { kind: 'message', role: 'user', content: 'second user request' },
      ]), [
        { ...firstProv, canonicalEndSeq: 3, turnEndIndex: 2 }, secondProv,
      ]),
      assistant2,
      pluginRecord(7, 'exec-3', prompt([
        { kind: 'message', role: 'user', content: 'first user request' }, assistantTurn('answer-exec-1'),
        { kind: 'message', role: 'user', content: 'second user request' }, assistantTurn('answer-exec-2'),
      ]), [
        { ...firstProv, canonicalEndSeq: 3, turnEndIndex: 2 },
        { ...secondProv, canonicalEndSeq: 6, turnEndIndex: 4 },
      ]),
      assistant3,
    ] as unknown as CanonicalRecord[];
    const targetTurns = [
      { kind: 'message' as const, role: 'user' as const, content: 'first user request' },
      assistantTurn('answer-exec-1'),
      { kind: 'message' as const, role: 'user' as const, content: 'second user request' },
      assistantTurn('answer-exec-2'),
    ];
    const targetProvenance = [
      { ...firstProv, canonicalEndSeq: 3, turnEndIndex: 2 },
      { ...secondProv, canonicalEndSeq: 6, turnEndIndex: 4 },
    ];
    const ledger = buildProviderObservedSegmentLedger(records, thread, selection);
    expect(ledger?.baselineInputTokens).toBe(35);
    expect(ledger?.segmentLedger).toEqual([
      expect.objectContaining({ startSeq: 6, endSeq: 6, tokenCount: 15, turnKinds: ['assistant'] }),
    ]);
    expect(buildProviderObservedContextTokenHistory(records, projection(targetTurns, targetProvenance), selection)?.inputTokens).toBe(35);
  });

  it('rejects a canonical snapshot whose recorded turns do not match its source mapping', () => {
    const user = userRecord(1, 'user-1', 'canonical user text');
    const responseRecord = assistantRecord(3, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
    const provenance: ProjectionProvenance = {
      id: 'canonical:user-1', sourcePluginId: 'pico.core', label: 'round', kind: 'canonical', disposition: 'raw',
      canonicalStartSeq: 1, canonicalEndSeq: 3, turnStartIndex: 0, turnEndIndex: 2,
    };
    const records = [
      user,
      pluginRecord(2, 'exec-1', prompt([
        { kind: 'message', role: 'user', content: 'tampered text' }, assistantTurn('answer-exec-1'),
      ]), [provenance]),
      responseRecord,
    ] as unknown as CanonicalRecord[];
    expect(buildProviderObservedSegmentLedger(records, thread, selection)).toBeNull();
  });

  it('rejects moving a raw model segment across a fixed plugin turn', () => {
    const assistant = assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
    const pluginTurn = { kind: 'message' as const, role: 'user' as const, content: 'plugin context' };
    const raw = rawProv('rolling:raw:2', 2, 2, 0);
    const plugin = {
      id: 'plugin-context', sourcePluginId: 'test.plugin', label: 'plugin context', kind: 'plugin' as const,
      disposition: 'raw' as const, turnIndex: 1,
    };
    const records = [
      pluginRecord(1, 'exec-1', prompt([assistantTurn('answer-exec-1'), pluginTurn]), [raw, plugin]),
      assistant,
    ] as unknown as CanonicalRecord[];
    const movedProjection = projection(
      [pluginTurn, assistantTurn('answer-exec-1')],
      [{ ...plugin, turnIndex: 0 }, { ...raw, turnStartIndex: 1, turnEndIndex: 2 }],
    );
    expect(buildProviderObservedContextTokenHistory(records, movedProjection, selection)).toBeNull();
  });

  it('rejects moving a summary away from its verified raw source position', () => {
    const sourceAssistant = assistantRecord(2, 'exec-0', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
    const baselineAssistant = assistantRecord(4, 'exec-1', { inputTokens: 15, outputTokens: 3, reasoningTokens: 0 });
    const summary = summaryProvenance(sourceAssistant as unknown as CanonicalRecord, 3);
    const pluginTurn = { kind: 'message' as const, role: 'user' as const, content: 'plugin context' };
    const plugin = {
      id: 'plugin-context', sourcePluginId: 'test.plugin', label: 'plugin context', kind: 'plugin' as const,
      disposition: 'raw' as const, turnIndex: 1,
    };
    const records = [
      pluginRecord(1, 'exec-0', prompt([]), []),
      sourceAssistant,
      pluginRecord(3, 'exec-1', prompt([assistantTurn('answer-exec-0'), pluginTurn]), [rawProv('rolling:raw:2', 2, 2), plugin]),
      baselineAssistant,
    ] as unknown as CanonicalRecord[];
    const movedSummary = { ...summary, turnStartIndex: 1, turnEndIndex: 2 };
    const movedPlugin = { ...plugin, turnIndex: 0 };
    const target = projection([pluginTurn, { kind: 'message', role: 'assistant', content: 'summary text' }], [movedPlugin, movedSummary]);
    expect(buildProviderObservedContextTokenHistory(
      records,
      target,
      selection,
      [summaryCall(sourceAssistant as unknown as CanonicalRecord, 'summary text', 3)],
    )).toBeNull();
  });

  it('accepts a verified summary replacement followed by the latest assistant output', () => {
    const firstAssistant = assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 2, reasoningTokens: 0 });
    const secondAssistant = assistantRecord(4, 'exec-2', { inputTokens: 15, outputTokens: 4, reasoningTokens: 1 });
    const records = [
      pluginRecord(1, 'exec-1', prompt([]), []),
      firstAssistant,
      pluginRecord(3, 'exec-2', prompt([assistantTurn('answer-exec-1')]), [rawProv('rolling:raw:2', 2, 2)]),
      secondAssistant,
    ] as unknown as CanonicalRecord[];
    const summary = summaryProvenance(firstAssistant as unknown as CanonicalRecord, 3);
    const target = projection(
      [{ kind: 'message', role: 'assistant', content: 'summary text' }, assistantTurn('answer-exec-2')],
      [summary, rawProv('rolling:raw:4', 4, 4, 1)],
    );
    const result = buildProviderObservedContextTokenHistory(
      records,
      target,
      selection,
      [summaryCall(firstAssistant as unknown as CanonicalRecord, 'summary text', 3)],
    );
    expect(result?.inputTokens).toBe(16);
  });

  it('counts a trusted latest assistant tool batch before tool results are written', () => {
    const pendingAssistant = assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 });
    const payload = pendingAssistant.payload as unknown as Record<string, unknown>;
    const calls = [
      { id: 'call-1', name: 'example_tool', arguments: {} },
      { id: 'call-2', name: 'example_tool', arguments: {} },
    ];
    payload.toolCalls = calls;
    payload.batchId = 'batch-1';
    const records = [pluginRecord(1, 'exec-1', prompt([]), []), pendingAssistant] as unknown as CanonicalRecord[];
    const target = projection(
      [assistantToolsTurn('answer-exec-1', calls)],
      [rawProv('rolling:raw:2', 2, 2)],
    );
    expect(buildProviderObservedContextTokenHistory(records, target, selection)?.inputTokens).toBe(13);
  });

  it('ignores only matching partial tool results and rejects malformed or unrelated incomplete tails', () => {
    const pendingAssistant = assistantRecord(2, 'exec-1', { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 });
    const payload = pendingAssistant.payload as unknown as Record<string, unknown>;
    const calls = [
      { id: 'call-1', name: 'example_tool', arguments: {} },
      { id: 'call-2', name: 'example_tool', arguments: {} },
    ];
    payload.toolCalls = calls;
    payload.batchId = 'batch-1';
    const matchingResult = {
      id: 'tool-exec-1:result', threadId: thread.id, seq: 3, kind: 'tool_result' as const,
      payload: { executionId: 'tool-exec-1', toolCallId: 'call-1', batchId: 'batch-1', toolName: 'example_tool', status: 'completed', result: 'ignored' },
      createdAt: new Date(3).toISOString(),
    };
    const records = [pluginRecord(1, 'exec-1', prompt([]), []), pendingAssistant, matchingResult] as unknown as CanonicalRecord[];
    const target = projection(
      [assistantToolsTurn('answer-exec-1', calls), { kind: 'tool_result', callId: 'call-1', toolName: 'example_tool', batchId: 'batch-1', content: JSON.stringify('ignored') }],
      [{ ...rawProv('rolling:raw:2', 2, 3), turnEndIndex: 2 }],
    );
    expect(buildProviderObservedContextTokenHistory(records, target, selection)?.inputTokens).toBe(13);

    const mismatchedResult = {
      ...matchingResult,
      payload: { ...matchingResult.payload, toolCallId: 'unrelated-call' },
    };
    expect(buildProviderObservedContextTokenHistory(
      [records[0]!, records[1]!, mismatchedResult] as unknown as CanonicalRecord[],
      target,
      selection,
    )).toBeNull();

    const trailingUser = userRecord(3, 'late-user', 'must not follow pending batch');
    expect(buildProviderObservedContextTokenHistory(
      [records[0]!, records[1]!, trailingUser] as unknown as CanonicalRecord[],
      projection(
        [assistantToolsTurn('answer-exec-1', calls), { kind: 'message', role: 'user', content: 'must not follow pending batch' }],
        [rawProv('rolling:raw:2', 2, 3)],
      ),
      selection,
    )).toBeNull();
  });

  it('breaks the observed delta chain if an existing rolling summary body or call changes', () => {
    const summarizedSource = assistantRecord(2, 'source-exec', { inputTokens: 8, outputTokens: 2, reasoningTokens: 0 });
    const assistant1 = assistantRecord(4, 'exec-1', { inputTokens: 10, outputTokens: 3, reasoningTokens: 0 });
    const assistant2 = assistantRecord(6, 'exec-2', { inputTokens: 15, outputTokens: 2, reasoningTokens: 0 });
    const oldSummary = summaryProvenance(summarizedSource as unknown as CanonicalRecord, 3, 'summary-call-old');
    const newSummary = summaryProvenance(summarizedSource as unknown as CanonicalRecord, 3, 'summary-call-new');
    const records = [
      summarizedSource,
      pluginRecord(3, 'exec-1', prompt([{ kind: 'message', role: 'assistant', content: 'old summary body' }]), [oldSummary]),
      assistant1,
      pluginRecord(5, 'exec-2', prompt([
        { kind: 'message', role: 'assistant', content: 'new summary body' }, assistantTurn('answer-exec-1'),
      ]), [newSummary, rawProv('rolling:raw:4', 4, 4, 1)]),
      assistant2,
    ] as unknown as CanonicalRecord[];
    const calls = [
      summaryCall(summarizedSource as unknown as CanonicalRecord, 'old summary body', 3, 'summary-call-old'),
      summaryCall(summarizedSource as unknown as CanonicalRecord, 'new summary body', 3, 'summary-call-new'),
    ];
    const ledger = buildProviderObservedSegmentLedger(records, thread, selection, calls);
    expect(ledger?.baselineExecutionId).toBe('exec-2');
    expect(ledger?.snapshots).toHaveLength(1);
    expect(ledger?.segmentLedger).toEqual([]);
  });
});
