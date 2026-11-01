import { describe, expect, it } from 'vitest';
import type { CanonicalRecord } from '../../../core/types.js';
import type { PluginContext } from '../../host.js';
import type { Thread } from '../../../core/types.js';
import type { ProjectionInput } from '../../../runtime/stages.js';
import {
  completedModelRounds,
  estimateCompactEconomics,
  rollingContextPlugin,
  sourceHash,
  segmentId,
  type RollingSegment,
} from '../../rolling-context.js';

function record(seq: number, kind: CanonicalRecord['kind'], payload: Record<string, unknown>): CanonicalRecord {
  return { id: `r-${seq}`, threadId: 'thread', seq, kind, payload, createdAt: '2026-10-29T00:00:00.000Z' };
}

const modelRound = [
  record(2, 'assistant', {
    content: 'Checked the test.',
    toolCalls: [{ id: 'call-1', name: 'test', arguments: {} }],
    batchId: 'batch-1',
    projectionThrough: 1,
    usage: null,
    model: 'test',
  }),
  record(3, 'tool_result', {
    executionId: 'exec-1',
    toolCallId: 'call-1',
    batchId: 'batch-1',
    toolName: 'test',
    status: 'completed',
    result: { passed: true },
  }),
  record(4, 'assistant', {
    content: 'The test passes.',
    toolCalls: [],
    batchId: null,
    projectionThrough: 3,
    usage: null,
    model: 'test',
  }),
];

const economics = {
  provider: 'provider-a',
  model: 'model-a',
  inputPerMillion: 10,
  cachedInputPerMillion: 2,
  cacheWritePerMillion: 4,
  expectedFutureCalls: 3,
};

describe('Rolling Context v2 model rounds and cost gate', () => {
  it('keeps user capsules outside model-round summaries and excludes interleaved rounds', () => {
    const user = record(1, 'message', { role: 'user', source: 'user', content: 'Private instruction capsule.' });
    const nextUser = record(5, 'message', { role: 'user', source: 'user', content: 'Next request.' });
    const rounds = completedModelRounds([user, ...modelRound, nextUser]);
    expect(rounds).toEqual([modelRound.slice(0, 2), modelRound.slice(2)]);
    expect(rounds.flat().some((item) => item.kind === 'message')).toBe(false);

    const interleaved = [
      modelRound[0]!,
      record(3, 'message', { role: 'user', source: 'child', content: 'Child result.' }),
      record(4, 'tool_result', {
        executionId: 'exec-1',
        toolCallId: 'call-1',
        batchId: 'batch-1',
        toolName: 'test',
        status: 'completed',
        result: {},
      }),
      record(5, 'assistant', {
        content: 'Done.',
        toolCalls: [],
        batchId: null,
        projectionThrough: 4,
        usage: null,
        model: 'test',
      }),
    ];
    expect(completedModelRounds(interleaved)).toEqual([[interleaved.at(-1)!]]);
  });

  it('estimates only with complete configured assumptions and reports a positive cache-cost path', () => {
    const result = estimateCompactEconomics({
      economics,
      currentProjection: {
        systemPrompt: 'system',
        tools: [],
        turns: [{ kind: 'message', role: 'user', content: 'A'.repeat(400) }],
      },
      candidateProjection: {
        systemPrompt: 'system',
        tools: [],
        turns: [{ kind: 'message', role: 'user', content: 'short summary' }],
      },
      keepRecentRounds: 0,
      candidateCount: 1,
    });
    expect(result.status).toBe('estimated');
    if (result.status === 'estimated') {
      expect(result.estimatedSavings).toBeGreaterThan(0);
      expect(result.firstChangedTurnIndex).toBe(0);
      expect(result.oldSuffixChars).toBeGreaterThan(result.newSuffixChars);
      expect(result.unit).toBe('price-weighted-million-characters');
      expect(result.limitations.join(' ')).toContain('not a monetary amount');
    }
  });

  it('does not claim savings for negative economics, unknown projection, or images', () => {
    const projection = {
      systemPrompt: 'system',
      tools: [],
      turns: [{ kind: 'message' as const, role: 'user' as const, content: 'A'.repeat(100) }],
    };
    const negative = estimateCompactEconomics({
      economics: { ...economics, cacheWritePerMillion: 1_000_000 },
      currentProjection: projection,
      candidateProjection: { ...projection, turns: [{ kind: 'message', role: 'user', content: 'short' }] },
      keepRecentRounds: 0,
      candidateCount: 1,
    });
    expect(negative.status).toBe('not_profitable');
    expect(
      estimateCompactEconomics({
        economics,
        currentProjection: null,
        candidateProjection: projection,
        keepRecentRounds: 0,
        candidateCount: 1,
      }),
    ).toMatchObject({ status: 'cannot_estimate' });
    expect(
      estimateCompactEconomics({
        economics,
        currentProjection: {
          ...projection,
          turns: [
            {
              kind: 'tool_result',
              callId: 'x',
              toolName: 'image',
              content: 'image',
              images: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
            },
          ],
        },
        candidateProjection: projection,
        keepRecentRounds: 0,
        candidateCount: 1,
      }),
    ).toMatchObject({ status: 'cannot_estimate' });
  });

  it.each([
    { allowCommit: true, serviceAvailable: true, visibleTokens: 17, expected: 'compacted' },
    { allowCommit: false, serviceAvailable: true, visibleTokens: 17, expected: 'cannot_estimate' },
    { allowCommit: true, serviceAvailable: true, visibleTokens: null, expected: 'cannot_estimate' },
    { allowCommit: true, serviceAvailable: false, visibleTokens: 17, expected: 'cannot_estimate' },
  ])('warms an older round only after positive estimate and atomic Runtime approval (%o)', async (scenario) => {
    const thread = { id: 'thread', projectId: 'project', state: 'running' } as Thread;
    const oldRoundText = 'Detailed response evidence. '.repeat(80);
    const history = [
      record(1, 'message', { role: 'user', source: 'user', content: 'Keep this capsule exact.' }),
      record(2, 'assistant', {
        content: oldRoundText,
        toolCalls: [{ id: 'old-call', name: 'inspect', arguments: {} }],
        batchId: 'old-batch',
        projectionThrough: 1,
        usage: null,
        model: 'model-a',
      }),
      record(3, 'tool_result', {
        executionId: 'old-execution',
        toolCallId: 'old-call',
        batchId: 'old-batch',
        toolName: 'inspect',
        status: 'completed',
        result: 'tool evidence',
      }),
      record(4, 'assistant', {
        content: 'The older tool round is complete.',
        toolCalls: [],
        batchId: null,
        projectionThrough: 3,
        usage: null,
        model: 'model-a',
      }),
      record(5, 'message', { role: 'user', source: 'user', content: 'Current request.' }),
      record(6, 'assistant', {
        content: 'Current round response.',
        toolCalls: [],
        batchId: null,
        projectionThrough: 5,
        usage: null,
        model: 'model-a',
      }),
    ];
    const oldRecords = history.slice(1, 3);
    const hash = sourceHash(oldRecords);
    const middleRecords = [history[3]!];
    const middleHash = sourceHash(middleRecords);
    const recentRecords = [history[5]!];
    const recentHash = sourceHash(recentRecords);
    const segment: RollingSegment = {
      id: segmentId(thread.id, oldRecords, hash),
      threadId: thread.id,
      startSeq: 2,
      endSeq: 3,
      sourceRecordIds: oldRecords.map((record) => record.id),
      sourceHash: hash,
      tier: 'hot',
      summary: 'A short sufficient summary.',
      summaryResponseVisibleTokens: scenario.visibleTokens,
      summaryVersion: `direct-summary-v2:${hash.slice(0, 12)}`,
      summaryStatus: 'completed',
      summaryCallId: 'summary-call',
      evaluator: {
        status: 'skipped',
        recommendation: null,
        reason: null,
        confidence: null,
        expectedSavings: null,
        cacheCostDataKnown: false,
        callId: null,
      },
      transitions: [],
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    const middleSegment: RollingSegment = {
      ...segment,
      id: segmentId(thread.id, middleRecords, middleHash),
      startSeq: 4,
      endSeq: 4,
      sourceRecordIds: middleRecords.map((record) => record.id),
      sourceHash: middleHash,
      tier: 'hot',
      summary: 'Middle round summary.',
      summaryResponseVisibleTokens: 14,
      summaryVersion: `direct-summary-v2:${middleHash.slice(0, 12)}`,
      summaryCallId: 'middle-summary-call',
    };
    const recentWarm: RollingSegment = {
      ...segment,
      id: segmentId(thread.id, recentRecords, recentHash),
      startSeq: 6,
      endSeq: 6,
      sourceRecordIds: ['r-6'],
      sourceHash: recentHash,
      tier: 'warm',
      summary: 'Existing recent summary.',
      summaryResponseVisibleTokens: 20,
      summaryVersion: `direct-summary-v2:${recentHash.slice(0, 12)}`,
      summaryCallId: 'recent-summary-call',
    };
    const values = new Map<string, unknown>([
      ['rolling-context-v1', { byThread: { thread: [segment, middleSegment, recentWarm] } }],
      ['rolling-context-economics-v1', { byThread: { thread: economics } }],
    ]);
    const tools = new Map<
      string,
      (args: Record<string, unknown>, context: { thread: Thread; executionId: string }) => Promise<unknown>
    >();
    const routes = new Map<
      string,
      (request: { body: unknown; query: URLSearchParams }) => Promise<unknown> | unknown
    >();
    let transactionCount = 0;
    const preview: ProjectionInput = {
      thread,
      records: history,
      through: 6,
      systemPrompt: 'system',
      tools: [],
      turns: [
        { kind: 'message', role: 'user', content: 'Keep this capsule exact.' },
        {
          kind: 'assistant_tools',
          content: oldRoundText,
          calls: [{ id: 'old-call', name: 'inspect', arguments: {} }],
        },
        { kind: 'tool_result', callId: 'old-call', toolName: 'inspect', content: 'tool evidence' },
        { kind: 'message', role: 'assistant', content: 'The older tool round is complete.' },
        { kind: 'message', role: 'user', content: 'Current request.' },
        {
          kind: 'message',
          role: 'assistant',
          content: 'Existing recent summary.',
        },
      ],
      provenance: [
        {
          id: 'user-1',
          sourcePluginId: 'pico.core',
          label: 'User',
          kind: 'canonical',
          disposition: 'raw',
          turnStartIndex: 0,
          turnEndIndex: 1,
        },
        {
          id: 'rolling:raw:2',
          sourcePluginId: 'pico.rolling-context',
          label: 'Round 1',
          kind: 'rolling_segment',
          disposition: 'raw',
          canonicalStartSeq: 2,
          canonicalEndSeq: 3,
          turnStartIndex: 1,
          turnEndIndex: 3,
        },
        {
          id: 'rolling:raw:4',
          sourcePluginId: 'pico.rolling-context',
          label: 'Round 2',
          kind: 'rolling_segment',
          disposition: 'raw',
          canonicalStartSeq: 4,
          canonicalEndSeq: 4,
          turnStartIndex: 3,
          turnEndIndex: 4,
        },
        {
          id: 'user-3',
          sourcePluginId: 'pico.core',
          label: 'User',
          kind: 'canonical',
          disposition: 'raw',
          turnStartIndex: 4,
          turnEndIndex: 5,
        },
        {
          id: 'rolling:recent',
          sourcePluginId: 'pico.rolling-context',
          label: 'Round 2',
          kind: 'rolling_segment',
          disposition: 'summary',
          canonicalStartSeq: 6,
          canonicalEndSeq: 6,
          turnStartIndex: 5,
          turnEndIndex: 6,
          summaryVersion: recentWarm.summaryVersion!,
          summaryCallId: recentWarm.summaryCallId!,
          summaryResponseVisibleTokens: recentWarm.summaryResponseVisibleTokens!,
        },
      ],
    };
    let commitCalls = 0;
    const context = {
      threads: {
        get: () => thread,
        modelSelection: () => ({ provider: economics.provider, model: economics.model }),
        previewModelInput: async () => preview,
        commitContextReplacement: scenario.serviceAvailable ? async (
          _threadId: string,
          _preview: ProjectionInput,
          candidate: ProjectionInput,
          commit: () => boolean,
        ) => {
          commitCalls += 1;
          expect(candidate.turns).toContainEqual({ kind: 'message', role: 'assistant', content: segment.summary });
          expect(candidate.provenance).toContainEqual(
            expect.objectContaining({
              id: 'rolling:raw:2',
              disposition: 'summary',
              turnStartIndex: 1,
              turnEndIndex: 2,
              summaryVersion: segment.summaryVersion,
              summaryCallId: segment.summaryCallId,
              summaryResponseVisibleTokens: 17,
            }),
          );
          expect(candidate.provenance).toContainEqual(
            expect.objectContaining({ id: 'rolling:raw:4', disposition: 'raw', turnStartIndex: 2, turnEndIndex: 3 }),
          );
          expect(candidate.provenance).toContainEqual(
            expect.objectContaining({ id: 'user-3', turnStartIndex: 3, turnEndIndex: 4 }),
          );
          expect(candidate.provenance).toContainEqual(
            expect.objectContaining({ id: 'rolling:recent', turnStartIndex: 4, turnEndIndex: 5 }),
          );
          if (!scenario.allowCommit) return { committed: false, reason: 'A newer context revision won the commit race.' };
          return { committed: commit() };
        } : undefined,
      },
    };
    Object.assign(context, {
      canonical: {
        list: () => history,
        append: (_threadId: string, payload: Record<string, unknown>) => {
          const entry = record(history.length + 1, 'plugin', payload);
          history.push(entry);
          return entry;
        },
      },
      executions: { get: () => null },
      state: {
        get<T>(key: string, fallback: T): T {
          return (values.has(key) ? values.get(key) : fallback) as T;
        },
        set<T>(key: string, value: T) {
          values.set(key, structuredClone(value));
        },
        transaction<T>(run: () => T): T {
          transactionCount += 1;
          return run();
        },
      },
      models: {
        complete: async () => {
          throw new Error('No summary should be generated by rolling_compact.');
        },
      },
      pipelines: { use() {} },
      tools: {
        register: (
          definition: { name: string },
          execute: (
            args: Record<string, unknown>,
            context: { thread: Thread; executionId: string },
          ) => Promise<unknown>,
        ) => tools.set(definition.name, execute),
      },
      http: {
        register: (
          method: string,
          path: string,
          handler: (request: { body: unknown; query: URLSearchParams }) => Promise<unknown> | unknown,
        ) => routes.set(`${method} ${path}`, handler),
      },
      commands: { register() {} },
      ui: { contribute() {}, registerPage() {} },
    });
    const pluginContext = context as unknown as PluginContext;
    rollingContextPlugin.activate?.(pluginContext);

    const legacySegments = (await routes.get('GET /segments')!({
      body: {},
      query: new URLSearchParams('threadId=thread'),
    })) as { segments: RollingSegment[] };
    expect(legacySegments.segments.find((item) => item.id === recentWarm.id)?.summaryResponseVisibleTokens).toBe(20);

    const compact = tools.get('rolling_compact');
    expect(compact).toBeDefined();
    const result = (await compact!({ keep_recent_rounds: 2 }, { thread, executionId: 'exec' })) as {
      status: string;
      reason?: string;
      estimate: { estimatedSavings: number };
      skipped?: Array<{ reason: string }>;
    };
    expect(result.status, JSON.stringify(result)).toBe(scenario.expected);
    if (result.status === 'compacted') expect(result.estimate.estimatedSavings).toBeGreaterThan(0);
    if (scenario.visibleTokens === null)
      expect(result.skipped?.some((item) => item.reason.includes('token count'))).toBe(true);
    if (!scenario.serviceAvailable) expect(result.reason).toContain('atomic context replacement is unavailable');
    expect(commitCalls).toBe(scenario.visibleTokens === null || !scenario.serviceAvailable ? 0 : 1);
    expect(
      (values.get('rolling-context-v1') as { byThread: Record<string, RollingSegment[]> }).byThread.thread?.map(
        (item) => item.tier,
      ),
    ).toEqual(scenario.expected === 'compacted' ? ['warm', 'hot', 'warm'] : ['hot', 'hot', 'warm']);
    expect(
      (values.get('rolling-context-v1') as { byThread: Record<string, RollingSegment[]> }).byThread.thread?.find(
        (item) => item.id === recentWarm.id,
      )?.summaryResponseVisibleTokens,
    ).toBe(20);
    expect(transactionCount).toBe(scenario.expected === 'compacted' ? 1 : 0);
  });
});
