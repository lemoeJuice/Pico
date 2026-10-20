import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import type { ProjectionInput } from '../src/runtime/stages.js';
import {
  callKey,
  completedTurnBlocks,
  rollingContextPlugin,
  segmentId,
  sourceHash,
  summarizeAndEvaluate,
  transition,
  type RollingSegment,
} from '../src/plugins/rolling-context.js';

function record(seq: number, kind: CanonicalRecord['kind'], payload: Record<string, unknown>): CanonicalRecord {
  return {
    id: `record-${seq}`,
    threadId: 'thread-1',
    seq,
    kind,
    payload,
    createdAt: `2026-10-15T00:00:${String(seq).padStart(2, '0')}.000Z`,
  };
}
const fullTurn = [
  record(1, 'message', { role: 'user', source: 'user', content: 'Fix the failing test.' }),
  record(2, 'assistant', {
    content: 'I will inspect the failure.',
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
    result: { passed: false },
  }),
  record(4, 'assistant', {
    content: 'The test passed after the fix.',
    toolCalls: [],
    batchId: null,
    projectionThrough: 3,
    usage: null,
    model: 'test',
  }),
];
function sampleSegment(records = fullTurn): RollingSegment {
  const hash = sourceHash(records);
  return {
    id: segmentId('thread-1', records, hash),
    threadId: 'thread-1',
    startSeq: records[0]!.seq,
    endSeq: records.at(-1)!.seq,
    sourceRecordIds: records.map((item) => item.id),
    sourceHash: hash,
    tier: 'hot',
    summary: null,
    summaryVersion: null,
    summaryStatus: 'pending',
    summaryCallId: null,
    evaluator: {
      status: 'pending',
      recommendation: null,
      reason: null,
      confidence: null,
      expectedSavings: null,
      cacheCostDataKnown: false,
      callId: null,
    },
    transitions: [],
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
}

describe('Rolling Context plugin', () => {
  it('seals only complete full-turn blocks and keeps incomplete tool batches hot', () => {
    const incomplete = [
      ...fullTurn.slice(0, 3),
      record(5, 'message', { role: 'user', source: 'user', content: 'Another request' }),
    ];
    expect(completedTurnBlocks(incomplete)).toEqual([]);
    expect(completedTurnBlocks(fullTurn.slice(0, 3))).toEqual([]);
    expect(
      completedTurnBlocks([...fullTurn, record(5, 'message', { role: 'user', source: 'user', content: 'Next turn' })]),
    ).toEqual([fullTurn]);
  });

  it('uses stable hashes and stable but purpose-separated idempotency keys', () => {
    const segment = sampleSegment();
    expect(sourceHash(fullTurn)).toBe(sourceHash(structuredClone(fullTurn)));
    expect(segmentId('thread-1', fullTurn, segment.sourceHash)).toBe(segment.id);
    expect(callKey('summary', segment)).toBe(callKey('summary', segment));
    expect(callKey('summary', segment)).not.toBe(callKey('rolling-tier-review', segment));
    expect(sourceHash([...fullTurn, record(5, 'plugin', { audit: true })])).not.toBe(segment.sourceHash);
  });

  it('summarizes each segment and skips review when a complete net-savings estimate is unavailable', async () => {
    const requests: Array<{ purpose: string; idempotencyKey: string; prompt: { turns: Array<{ content: string }> } }> =
      [];
    const context = {
      models: {
        complete: async (request: (typeof requests)[number]) => {
          requests.push(request);
          if (request.purpose !== 'rolling-summary') throw new Error(`Unexpected model purpose: ${request.purpose}`);
          return {
            id: `call-${requests.length}`,
            response: {
              content: JSON.stringify({ summary: 'Verified: the test passed after a fix (canonical seq 4).' }),
            },
          };
        },
      },
    } as unknown as PluginContext;
    const thread = { id: 'thread-1', projectId: 'project-1' } as Thread;
    const segment = sampleSegment();
    const processed = await summarizeAndEvaluate(context, thread, segment, 'the exact original source');
    expect(requests.map((request) => request.purpose)).toEqual(['rolling-summary']);
    expect(requests[0]?.prompt.turns[0]?.content).toContain('the exact original source');
    expect(processed.summaryStatus).toBe('completed');
    expect(processed.tier).toBe('hot');
    expect(processed.evaluator.status).toBe('skipped');
    expect(processed.evaluator.callId).toBeNull();
    expect(processed.evaluator.cacheCostDataKnown).toBe(false);
    expect(processed.evaluator.expectedSavings).toBeNull();
    expect(processed.transitions).toEqual([]);
  });

  it('records manual tier transitions while preserving the original source hash', () => {
    const segment = sampleSegment();
    const warm = transition({ ...segment, summary: 'summary', summaryVersion: 'v1' }, 'warm', 'manual compact');
    const cold = transition(warm, 'cold', 'manual cold');
    expect(cold.sourceHash).toBe(segment.sourceHash);
    expect(cold.transitions.map((item) => [item.from, item.to])).toEqual([
      ['hot', 'warm'],
      ['warm', 'cold'],
    ]);
  });

  it('registers the visible fallback command and isolated panel contribution', () => {
    const commands: string[] = [];
    const contributions: string[] = [];
    const context = {
      canonical: { list: () => [] },
      state: {
        get: (_key: string, fallback: unknown) => fallback,
        set() {},
        transaction: (run: () => unknown) => run(),
      },
      pipelines: { use() {} },
      tools: { register() {} },
      http: { register() {} },
      commands: { register: (command: { name: string }) => commands.push(command.name) },
      ui: { contribute: (item: { id: string }) => contributions.push(item.id), registerPage() {} },
    } as unknown as PluginContext;
    rollingContextPlugin.activate?.(context);
    expect(commands).toContain('compact');
    expect(contributions).toContain('rolling-context');
  });

  it('keeps a segment hot automatically, then uses its saved direct summary after explicit /compact', async () => {
    const values = new Map<string, unknown>();
    const modelPurposes: string[] = [];
    const records = [
      ...fullTurn,
      record(5, 'message', { role: 'user', source: 'user', content: 'Continue with the next request.' }),
    ];
    const thread = { id: 'thread-1', projectId: 'project-1', state: 'idle' } as Thread;
    let projection:
      | ((
          input: ProjectionInput,
          next: (input: ProjectionInput) => Promise<ProjectionInput>,
        ) => Promise<ProjectionInput>)
      | null = null;
    type CompactCommand = {
      execute: (_args: string[], command: { thread: Thread }) => Promise<{ text: string }>;
    };
    let compactCommand: CompactCommand | null = null;
    const context = {
      threads: { get: () => thread, pause: () => thread },
      canonical: {
        list: () => records,
        append: (_threadId: string, payload: Record<string, unknown>) => {
          const audit = record(records.length + 1, 'plugin', payload);
          records.push(audit);
          return audit;
        },
      },
      state: {
        get<T>(key: string, fallback: T): T {
          return (values.has(key) ? values.get(key) : fallback) as T;
        },
        set<T>(key: string, value: T) {
          values.set(key, structuredClone(value));
        },
        transaction<T>(run: () => T): T {
          return run();
        },
      },
      models: {
        complete: async (request: { purpose: string }) => {
          modelPurposes.push(request.purpose);
          if (request.purpose !== 'rolling-summary') throw new Error(`Unexpected model purpose: ${request.purpose}`);
          return {
            id: request.purpose,
            response: { content: JSON.stringify({ summary: 'Verified result: the test passed (canonical seq 4).' }) },
          };
        },
      },
      pipelines: {
        use: (_stage: string, handler: typeof projection) => {
          projection = handler;
        },
      },
      tools: { register() {} },
      http: { register() {} },
      commands: {
        register: (command: CompactCommand) => {
          compactCommand = command;
        },
      },
      ui: { contribute() {}, registerPage() {} },
    } as unknown as PluginContext;
    rollingContextPlugin.activate?.(context);
    const input: ProjectionInput = {
      thread,
      records,
      through: 5,
      systemPrompt: 'system',
      tools: [],
      turns: [
        { kind: 'message', role: 'user', content: 'Fix the failing test.' },
        {
          kind: 'assistant_tools',
          content: 'I will inspect the failure.',
          calls: [{ id: 'call-1', name: 'test', arguments: {} }],
        },
        { kind: 'tool_result', callId: 'call-1', toolName: 'test', content: '{"passed":false}' },
        { kind: 'message', role: 'assistant', content: 'The test passed after the fix.' },
        { kind: 'message', role: 'user', content: 'Continue with the next request.' },
      ],
    };
    const runProjection = () => projection!(input, async (value) => value);
    const automatic = await runProjection();
    expect(automatic.turns[0]).toMatchObject({ kind: 'message', role: 'user', content: 'Fix the failing test.' });
    expect(automatic.provenance).toContainEqual(
      expect.objectContaining({ disposition: 'raw', canonicalStartSeq: 1, canonicalEndSeq: 4 }),
    );
    const command = compactCommand as unknown as CompactCommand;
    await command.execute([], { thread });
    const manual = await runProjection();
    expect(manual.turns[0]).toMatchObject({ kind: 'message', role: 'user' });
    expect(manual.turns[0]?.kind === 'message' && manual.turns[0].content).toContain(
      'Verified result: the test passed',
    );
    expect(manual.provenance).toContainEqual(
      expect.objectContaining({ disposition: 'summary', canonicalStartSeq: 1, canonicalEndSeq: 4 }),
    );
    expect(modelPurposes).toEqual(['rolling-summary']);
  });
});
