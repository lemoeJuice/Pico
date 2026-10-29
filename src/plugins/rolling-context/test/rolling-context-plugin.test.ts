import { describe, expect, it } from 'vitest';
import type { CanonicalRecord, Thread } from '../../../core/types.js';
import type { PluginContext } from '../../../plugins/host.js';
import type { ProjectionInput } from '../../../runtime/stages.js';
import {
  canonicalRecordsToPromptTurns,
  completedCanonicalTurnBlocks,
} from '../../../contracts/canonical-projection.js';
import {
  callKey,
  rollingContextPlugin,
  segmentId,
  sourceHash,
  summarizeAndEvaluate,
  transition,
  type RollingSegment,
} from '../../../plugins/rolling-context.js';

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

function repeatedCompleteTurns(count: number): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  for (let turnIndex = 0; turnIndex < count; turnIndex += 1) {
    for (const item of fullTurn) {
      const seq = turnIndex * fullTurn.length + item.seq;
      records.push({
        ...item,
        id: `record-${seq}`,
        seq,
        createdAt: `2026-10-15T00:00:${String(seq).padStart(2, '0')}.000Z`,
      });
    }
  }
  records.push(record(count * fullTurn.length + 1, 'message', { role: 'user', source: 'user', content: 'Next turn.' }));
  return records;
}

describe('Rolling Context plugin', () => {
  it('seals only complete full-turn blocks and keeps incomplete tool batches hot', () => {
    const incomplete = [
      ...fullTurn.slice(0, 3),
      record(5, 'message', { role: 'user', source: 'user', content: 'Another request' }),
    ];
    expect(completedCanonicalTurnBlocks(incomplete)).toEqual([]);
    expect(completedCanonicalTurnBlocks(fullTurn.slice(0, 3))).toEqual([]);
    expect(
      completedCanonicalTurnBlocks([
        ...fullTurn,
        record(5, 'message', { role: 'user', source: 'user', content: 'Next turn' }),
      ]),
    ).toEqual([fullTurn]);
  });

  it('keeps late tool results paired across a new user message and projects every hot turn through Core', async () => {
    const parent = { id: 'parent-thread', parentThreadId: 'grandparent-thread', projectId: 'project-1' } as Thread;
    const replay = [{ type: 'opaque-replay-state', payload: { token: 'keep-verbatim' } }];
    const block = [
      record(1, 'message', { role: 'user', source: 'user', content: 'Inspect the issue.' }),
      record(2, 'assistant', {
        content: 'I need two checks.',
        reasoningContent: 'Reasoning retained for capable adapters.',
        reasoningReplay: replay,
        toolCalls: [
          { id: 'read-call', name: 'read_file', arguments: { path: 'x.txt' } },
          { id: 'image-call', name: 'read_image', arguments: { path: 'screen.png' } },
        ],
        batchId: 'batch-late-results',
        projectionThrough: 1,
      }),
      record(3, 'message', {
        role: 'user',
        source: 'user',
        content: 'While those checks run, preserve the exact failure guidance.',
      }),
      record(4, 'message', {
        role: 'user',
        source: 'child',
        senderThreadId: 'sibling-thread',
        senderLabel: 'Scout',
        content: 'Child result arrived.',
      }),
      record(5, 'message', {
        role: 'user',
        source: 'child',
        senderThreadId: 'grandparent-thread',
        senderLabel: 'Parent',
        content: 'Parent constraint arrived.',
      }),
      record(6, 'tool_result', {
        executionId: 'read-execution',
        toolCallId: 'read-call',
        batchId: 'batch-late-results',
        toolName: 'read_file',
        status: 'failed',
        error: 'Permission denied.',
        result: { modelGuidance: 'Ask for approval before retrying.' },
      }),
      record(7, 'tool_result', {
        executionId: 'image-execution',
        toolCallId: 'image-call',
        batchId: 'batch-late-results',
        toolName: 'read_image',
        status: 'completed',
        result: {
          kind: 'pico.multimodal-tool-result',
          version: 1,
          text: 'Read image screen.png (image/png, 8 bytes).',
          images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'screen.png' }],
        },
      }),
      record(8, 'assistant', {
        content: 'Both checks are accounted for.',
        toolCalls: [],
        batchId: null,
        reasoningReplay: replay,
        projectionThrough: 7,
      }),
    ];
    const records = [...block, record(9, 'message', { role: 'user', source: 'user', content: 'Next turn.' })];
    const segment = sampleSegment(block);
    const values = new Map<string, unknown>([['rolling-context-v1', { byThread: { 'parent-thread': [segment] } }]]);
    let projection:
      | ((
          input: ProjectionInput,
          next: (input: ProjectionInput) => Promise<ProjectionInput>,
        ) => Promise<ProjectionInput>)
      | null = null;
    const context = {
      threads: { get: () => parent, pause: () => parent },
      canonical: { list: () => records, append: () => undefined },
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
        complete: async () => {
          return { id: 'summary', response: { content: JSON.stringify({ summary: 'Assistant response summary.' }) } };
        },
      },
      pipelines: {
        use: (_stage: string, handler: typeof projection) => {
          projection = handler;
        },
      },
      tools: { register() {} },
      http: { register() {} },
      commands: { register() {} },
      ui: { contribute() {}, registerPage() {} },
    } as unknown as PluginContext;
    rollingContextPlugin.activate?.(context);
    const expected = canonicalRecordsToPromptTurns(block, parent);
    const input: ProjectionInput = {
      thread: parent,
      records,
      through: 9,
      systemPrompt: 'system',
      tools: [],
      turns: canonicalRecordsToPromptTurns(records, parent),
      modelStep: true,
    };
    const projected = await projection!(input, async (value) => value);

    expect(completedCanonicalTurnBlocks(records)).toEqual([block]);
    expect(segment.sourceRecordIds).toEqual(block.map((item) => item.id));
    expect(projected.turns).toEqual([...expected, ...canonicalRecordsToPromptTurns([records.at(-1)!], parent)]);
    expect(projected.provenance).toContainEqual(
      expect.objectContaining({
        sourcePluginId: 'pico.core',
        disposition: 'raw',
        canonicalStartSeq: 1,
        canonicalEndSeq: 7,
      }),
    );
    expect(projected.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          callId: 'read-call',
          content: 'Tool failed: Permission denied.\nModel guidance: Ask for approval before retrying.',
        }),
        expect.objectContaining({
          kind: 'tool_result',
          callId: 'image-call',
          content: 'Read image screen.png (image/png, 8 bytes).\n[image image/png: screen.png]',
        }),
        expect.objectContaining({ kind: 'message', content: expect.stringContaining('[Message from Child Thread') }),
        expect.objectContaining({ kind: 'message', content: expect.stringContaining('[Message from Parent Thread') }),
      ]),
    );
    const assistant = projected.turns.find((turn) => turn.kind === 'assistant_tools');
    expect(assistant).toMatchObject({
      reasoningContent: 'Reasoning retained for capable adapters.',
      reasoningReplay: replay,
    });
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

  it('rejects a summary response that also requests a tool', async () => {
    const context = {
      models: {
        complete: async () => ({
          id: 'summary-call',
          response: {
            content: JSON.stringify({ summary: 'An apparently valid summary.' }),
            toolCalls: [{ id: 'call', name: 'unexpected', arguments: {} }],
          },
        }),
      },
    } as unknown as PluginContext;
    const processed = await summarizeAndEvaluate(context, { id: 'thread-1' } as Thread, sampleSegment(), 'source');
    expect(processed.summaryStatus).toBe('failed');
    expect(processed.summary).toBeNull();
    expect(processed.tier).toBe('hot');
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

  it('leaves /compact to Runtime and registers the isolated panel contribution', () => {
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
    expect(commands).not.toContain('compact');
    expect(contributions).toContain('rolling-context');
  });

  it('summarizes only the last completed model round and rejects legacy compact-all bypass', async () => {
    const values = new Map<string, unknown>();
    const modelPurposes: string[] = [];
    const segmentCount = 4;
    const records = repeatedCompleteTurns(segmentCount);
    let canonicalListReads = 0;
    const thread = { id: 'thread-1', projectId: 'project-1', state: 'idle' } as Thread;
    let projection:
      | ((
          input: ProjectionInput,
          next: (input: ProjectionInput) => Promise<ProjectionInput>,
        ) => Promise<ProjectionInput>)
      | null = null;
    let compactAll: ((request: { body: unknown }) => Promise<unknown>) | null = null;
    const context = {
      threads: { get: () => thread, pause: () => thread },
      canonical: {
        list: () => {
          canonicalListReads += 1;
          return [...records];
        },
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
        complete: async (request: { purpose: string; prompt?: { turns: Array<{ content: string }> } }) => {
          modelPurposes.push(request.purpose);
          if (request.purpose !== 'rolling-summary') throw new Error(`Unexpected model purpose: ${request.purpose}`);
          expect(request.prompt?.turns[0]?.content).not.toContain('Fix the failing test.');
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
      http: {
        register: (method: string, path: string, handler: (request: { body: unknown }) => Promise<unknown>) => {
          if (method === 'POST' && path === '/action') compactAll = handler;
        },
      },
      commands: { register() {} },
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
      modelStep: true,
    };
    const runProjection = () => projection!(input, async (value) => value);
    const automatic = await runProjection();
    expect(automatic.turns[0]).toMatchObject({ kind: 'message', role: 'user', content: 'Fix the failing test.' });
    expect(modelPurposes).toHaveLength(1);
    const action = compactAll as unknown as (request: { body: unknown }) => Promise<unknown>;
    canonicalListReads = 0;
    expect(await action({ body: { action: 'compact-all', threadId: thread.id } })).toMatchObject({
      status: 'cannot_estimate',
    });
    expect(canonicalListReads).toBe(0);
    const manual = await runProjection();
    expect(manual.turns[0]).toMatchObject({ kind: 'message', role: 'user' });
    expect(manual.turns[0]?.kind === 'message' && manual.turns[0].content).toBe('Fix the failing test.');
    expect(manual.turns.some((turn) => turn.kind === 'message' && turn.content.includes('Verified result'))).toBe(
      false,
    );
    expect(modelPurposes).toHaveLength(1);
  });

  it('preserves the Runtime compaction prefix when projecting later turns', async () => {
    const records: CanonicalRecord[] = [
      ...fullTurn,
      record(5, 'plugin', {
        pluginId: 'pico.runtime',
        action: 'context-compacted',
        version: 1,
        throughSeq: 4,
        sourceRecordIds: fullTurn.map((item) => item.id),
        sourceHash: 'a'.repeat(64),
        summary: 'Core summary: the failing test passed.',
      }),
      record(6, 'message', { role: 'user', source: 'user', content: 'Now inspect the next issue.' }),
      record(7, 'assistant', {
        content: 'I will inspect the next issue.',
        toolCalls: [],
        batchId: null,
        projectionThrough: 6,
        usage: null,
        model: 'test',
      }),
    ];
    const thread = { id: 'thread-1', projectId: 'project-1', state: 'idle' } as Thread;
    let projection:
      | ((
          input: ProjectionInput,
          next: (input: ProjectionInput) => Promise<ProjectionInput>,
        ) => Promise<ProjectionInput>)
      | null = null;
    const context = {
      threads: { get: () => thread, pause: () => thread },
      canonical: { list: () => records, append() {} },
      state: {
        get: (_key: string, fallback: unknown) => fallback,
        set() {},
        transaction: <T>(run: () => T) => run(),
      },
      models: {
        complete: async () => {
          throw new Error('No summary is needed for the preserved prefix.');
        },
      },
      pipelines: {
        use: (_stage: string, handler: typeof projection) => {
          projection = handler;
        },
      },
      tools: { register() {} },
      http: { register() {} },
      commands: { register() {} },
      ui: { contribute() {}, registerPage() {} },
    } as unknown as PluginContext;
    rollingContextPlugin.activate?.(context);
    const input: ProjectionInput = {
      thread,
      records,
      through: 7,
      systemPrompt: 'system',
      tools: [],
      turns: [
        {
          kind: 'message',
          role: 'user',
          content:
            'Runtime compaction summary for Canonical seq 1-4 (source aaaaaaaaaaaaaaaa):\nCore summary: the failing test passed.',
        },
        ...canonicalRecordsToPromptTurns(
          records.filter((item) => item.seq > 5),
          thread,
        ),
      ],
      provenance: [
        {
          id: 'runtime-compaction:test',
          sourcePluginId: 'pico.runtime',
          label: 'Runtime compaction 1-4',
          kind: 'canonical',
          disposition: 'summary',
          canonicalStartSeq: 1,
          canonicalEndSeq: 4,
          turnIndex: 0,
        },
      ],
    };
    const projected = await projection!(input, async (value) => value);

    expect(projected.turns[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Core summary') });
    expect(
      projected.turns.some((turn) => turn.kind === 'message' && turn.content.includes('Fix the failing test')),
    ).toBe(false);
    expect(projected.turns.at(-2)).toMatchObject({ role: 'user', content: 'Now inspect the next issue.' });
  });
});
