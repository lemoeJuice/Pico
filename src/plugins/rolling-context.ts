import { createHash, randomUUID } from 'node:crypto';
import type { CanonicalRecord, Thread } from '../core/types.js';
import type { ModelPrompt, PromptTurn } from '../contracts/model.js';
import {
  canonicalBlockToPromptTurns,
  canonicalConversationRecords,
  canonicalTurnBlocks,
  completedCanonicalTurnBlocks,
  runtimeCompactionTurn,
  runtimeContextCompaction,
} from '../contracts/canonical-projection.js';
import { sanitizeMultimodalResultValue } from '../contracts/multimodal.js';
import type { ProjectionInput, ProjectionProvenance } from '../runtime/stages.js';
import type { PicoPlugin, PluginContext, PluginHttpRequest } from './host.js';

export type RollingTier = 'hot' | 'warm' | 'cold';
export interface RollingSegment {
  id: string;
  threadId: string;
  startSeq: number;
  endSeq: number;
  sourceRecordIds: string[];
  sourceHash: string;
  tier: RollingTier;
  summary: string | null;
  summaryVersion: string | null;
  summaryStatus: 'pending' | 'completed' | 'failed';
  summaryCallId: string | null;
  evaluator: {
    status: 'pending' | 'completed' | 'failed' | 'skipped';
    recommendation: 'warm' | 'hot' | 'cold' | null;
    reason: string | null;
    confidence: number | null;
    expectedSavings: number | null;
    cacheCostDataKnown: boolean;
    callId: string | null;
  };
  transitions: Array<{ from: RollingTier; to: RollingTier; at: string; reason: string; summaryVersion: string | null }>;
  updatedAt: string;
}
interface RollingState {
  byThread: Record<string, RollingSegment[]>;
}
type ToolContext = Parameters<Parameters<PluginContext['tools']['register']>[1]>[1];
const STATE_KEY = 'rolling-context-v1';
const SUMMARY_VERSION = 'direct-summary-v1';
const MAX_SOURCE_CHARS = 60_000;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function readState(context: PluginContext): RollingState {
  const value = object(context.state.get<unknown>(STATE_KEY, { byThread: {} }));
  return { byThread: object(value.byThread) as Record<string, RollingSegment[]> };
}
function getSegments(context: PluginContext, threadId: string): RollingSegment[] {
  const segments = readState(context).byThread[threadId];
  return Array.isArray(segments) ? segments.filter((segment) => segment && typeof segment.id === 'string') : [];
}
function saveSegments(
  context: PluginContext,
  threadId: string,
  segments: RollingSegment[],
  audit?: Record<string, unknown>,
): void {
  context.state.transaction(() => {
    const state = readState(context);
    context.state.set(STATE_KEY, { byThread: { ...state.byThread, [threadId]: segments } });
    if (audit) context.canonical.append(threadId, { type: 'rolling-context.transition', ...audit });
  });
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
export function sourceHash(records: readonly CanonicalRecord[]): string {
  return createHash('sha256').update(stableJson(records)).digest('hex');
}
export function segmentId(threadId: string, records: readonly CanonicalRecord[], hash: string): string {
  return `rc-${createHash('sha256')
    .update(`${threadId}:${records[0]?.seq}:${records.at(-1)?.seq}:${hash}`)
    .digest('hex')
    .slice(0, 20)}`;
}
function describeRecords(records: readonly CanonicalRecord[]): string {
  return records
    .map((record) => {
      const payload = sanitizeMultimodalResultValue(record.payload);
      return `Canonical seq ${record.seq} (${record.kind}, id ${record.id}):\n${stableJson(payload)}`;
    })
    .join('\n\n');
}
function parseJsonResponse(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Expected a JSON object from the model.');
  return parsed as Record<string, unknown>;
}
function summaryPrompt(segment: RollingSegment, source: string, model: string): ModelPrompt {
  return {
    system:
      'Summarize exactly one sealed Canonical History segment. Return only JSON: {"summary":"..."}. Preserve user goals and constraints, verified facts with source sequence references, decisions and reasons, unresolved questions, failures/risks, tool evidence, and next actions. Clearly label uncertainty; never turn an inference into a verified fact. Do not use prior summaries or information outside this segment. Keep the result concise but sufficient to continue the work.',
    turns: [
      {
        kind: 'message',
        role: 'user',
        content: `Segment ${segment.id}, canonical seq ${segment.startSeq}-${segment.endSeq}, source sha256 ${segment.sourceHash}.\n\n${source}`,
      },
    ],
    tools: [],
    model,
    temperature: 0,
  };
}
export function callKey(purpose: string, segment: RollingSegment): string {
  return `${purpose}:${segment.id}:${segment.sourceHash}`;
}
export async function summarizeAndEvaluate(
  context: PluginContext,
  thread: Thread,
  segment: RollingSegment,
  source: string,
): Promise<RollingSegment> {
  let updated = segment;
  const model = '';
  try {
    const summaryCall = await context.models.complete({
      threadId: thread.id,
      projectId: thread.projectId,
      purpose: 'rolling-summary',
      idempotencyKey: callKey('summary', segment),
      prompt: summaryPrompt(segment, source, model),
    });
    const parsed = parseJsonResponse(summaryCall.response.content);
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (!summary || summary.length > 12_000) throw new Error('Summary was empty or exceeded the safe size limit.');
    updated = {
      ...updated,
      summary,
      summaryVersion: `${SUMMARY_VERSION}:${segment.sourceHash.slice(0, 12)}`,
      summaryStatus: 'completed',
      summaryCallId: summaryCall.id,
      updatedAt: new Date().toISOString(),
    };
    // Fail closed until Runtime can provide a complete pre-review net-savings estimate.
    // Usage rates alone do not establish per-segment token savings, cache-prefix loss,
    // expected future reuse, or summary/reviewer call costs. Calling the reviewer here
    // would spend money to confirm that those required inputs are still unknown.
    updated = {
      ...updated,
      evaluator: {
        status: 'skipped',
        recommendation: null,
        reason:
          'Skipped: net savings cannot be estimated from current Runtime data (segment token savings, cache-prefix impact, future reuse, and summary/reviewer costs are incomplete).',
        confidence: null,
        expectedSavings: null,
        cacheCostDataKnown: false,
        callId: null,
      },
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updated =
      updated.summaryStatus === 'completed'
        ? {
            ...updated,
            evaluator: { ...updated.evaluator, status: 'failed', reason: message, callId: updated.evaluator.callId },
            updatedAt: new Date().toISOString(),
          }
        : {
            ...updated,
            summaryStatus: 'failed',
            evaluator: { ...updated.evaluator, status: 'failed', reason: message },
            updatedAt: new Date().toISOString(),
          };
  }
  return updated;
}
export function transition(segment: RollingSegment, tier: RollingTier, reason: string): RollingSegment {
  if (segment.tier === tier) return segment;
  const now = new Date().toISOString();
  return {
    ...segment,
    tier,
    transitions: [
      ...segment.transitions,
      { from: segment.tier, to: tier, at: now, reason, summaryVersion: segment.summaryVersion },
    ],
    updatedAt: now,
  };
}
function isRecordPresent(records: readonly CanonicalRecord[], segment: RollingSegment): boolean {
  const ids = new Set(records.map((record) => record.id));
  return segment.sourceRecordIds.every((id) => ids.has(id));
}
function latestRewindTargetSeq(records: readonly CanonicalRecord[]): number | null {
  for (const record of [...records].reverse()) {
    if (record.kind !== 'plugin') continue;
    const payload = object(record.payload);
    if (
      payload.pluginId === 'pico.runtime' &&
      payload.action === 'context-rewound' &&
      payload.version === 1 &&
      Number.isSafeInteger(payload.targetSeq) &&
      (payload.targetSeq as number) >= 1
    ) {
      return payload.targetSeq as number;
    }
  }
  return null;
}
function allTurns(
  context: PluginContext,
  input: ProjectionInput,
  state: RollingSegment[],
): { turns: PromptTurn[]; provenance: ProjectionProvenance[] } {
  const consumed = new Set<string>();
  const replacementByStart = new Map<number, RollingSegment>();
  const runtimeCompaction = runtimeContextCompaction(input.records);
  const rewindTargetSeq = latestRewindTargetSeq(input.records);
  for (const segment of state)
    if (
      segment.tier !== 'hot' &&
      segment.summary &&
      (!runtimeCompaction || segment.startSeq > runtimeCompaction.contextThroughSeq) &&
      (rewindTargetSeq === null || rewindTargetSeq < segment.startSeq || rewindTargetSeq > segment.endSeq)
    ) {
      replacementByStart.set(segment.startSeq, segment);
    }
  const turns: PromptTurn[] = [];
  const provenance: ProjectionProvenance[] = [];
  if (runtimeCompaction) {
    turns.push(runtimeCompactionTurn(runtimeCompaction));
    const sourceStartSeq = input.records.find((record) => record.id === runtimeCompaction.sourceRecordIds[0])?.seq ?? 1;
    provenance.push({
      id: `runtime-compaction:${runtimeCompaction.sourceHash}`,
      sourcePluginId: 'pico.runtime',
      label: `Runtime compaction ${sourceStartSeq}-${runtimeCompaction.throughSeq}`,
      kind: 'canonical',
      disposition: 'summary',
      canonicalStartSeq: sourceStartSeq,
      canonicalEndSeq: runtimeCompaction.throughSeq,
      reason: 'A Runtime-owned summary replaces this preserved Canonical prefix.',
      turnIndex: 0,
    });
  }
  const relevant = canonicalConversationRecords(input.records);
  const blocks = canonicalTurnBlocks(input.records);
  const blockByStart = new Map(blocks.map((block) => [block[0]!.seq, block]));
  for (const record of relevant) {
    if (runtimeCompaction && record.seq <= runtimeCompaction.contextThroughSeq) continue;
    if (consumed.has(record.id)) continue;
    const segment = replacementByStart.get(record.seq);
    const block = blockByStart.get(record.seq);
    if (segment && block && isRecordPresent(input.records, segment)) {
      for (const id of segment.sourceRecordIds) consumed.add(id);
      if (segment.tier === 'warm') {
        turns.push({
          kind: 'message',
          role: 'user',
          content: `Rolling Context summary for canonical seq ${segment.startSeq}-${segment.endSeq} (summary ${segment.summaryVersion}; source ${segment.sourceHash.slice(0, 16)}):\n${segment.summary}`,
        });
        provenance.push({
          id: `rolling:${segment.id}`,
          sourcePluginId: 'pico.rolling-context',
          label: `Rolling summary ${segment.startSeq}-${segment.endSeq}`,
          kind: 'rolling_segment',
          disposition: 'summary',
          canonicalStartSeq: segment.startSeq,
          canonicalEndSeq: segment.endSeq,
          ...(segment.summaryVersion ? { summaryVersion: segment.summaryVersion } : {}),
          reason: 'Stable direct summary replaces this sealed Canonical segment.',
        });
      } else {
        provenance.push({
          id: `rolling:${segment.id}`,
          sourcePluginId: 'pico.rolling-context',
          label: `Cold segment ${segment.startSeq}-${segment.endSeq}`,
          kind: 'rolling_segment',
          disposition: 'omitted',
          canonicalStartSeq: segment.startSeq,
          canonicalEndSeq: segment.endSeq,
          ...(segment.summaryVersion ? { summaryVersion: segment.summaryVersion } : {}),
          reason: 'Cold segment is retained for recall and omitted from this Model Input.',
        });
      }
      continue;
    }
    if (block) {
      const blockTurns = canonicalBlockToPromptTurns(block, input.thread);
      turns.push(...blockTurns);
      block.forEach((item) => consumed.add(item.id));
      provenance.push({
        id: `rolling:raw:${block[0]!.seq}`,
        sourcePluginId: 'pico.rolling-context',
        label: `Canonical segment ${block[0]!.seq}-${block.at(-1)!.seq}`,
        kind: 'rolling_segment',
        disposition: 'raw',
        canonicalStartSeq: block[0]!.seq,
        canonicalEndSeq: block.at(-1)!.seq,
        reason: 'Segment remains hot or has not reached a safe full-turn boundary.',
      });
    } else {
      turns.push(...canonicalBlockToPromptTurns([record], input.thread));
    }
  }
  // Preserve any core projection additions (for example, initial system turns) only when its
  // canonical source cannot be attributed; current Runtime canonical turns are wholly derived.
  if (turns.length === 0 && relevant.length === 0) turns.push(...input.turns);
  void context;
  return { turns, provenance };
}
function requireThread(value: unknown): string {
  const threadId = typeof value === 'string' ? value.trim() : '';
  if (!threadId) throw new Error('threadId is required.');
  return threadId;
}
function canManualCompact(records: readonly CanonicalRecord[], segment: RollingSegment): boolean {
  const block = completedCanonicalTurnBlocks(records).find(
    (items) => items[0]?.seq === segment.startSeq && items.at(-1)?.seq === segment.endSeq,
  );
  return Boolean(block && isRecordPresent(records, segment));
}

export const rollingContextPlugin: PicoPlugin = {
  id: 'pico.rolling-context',
  name: 'Rolling Context',
  version: '0.1.0',
  pipelinePriority: { projection: 0 },
  activate(context) {
    const { canonical, pipelines, tools, http, ui } = context;
    const list = (threadId: string): RollingSegment[] => getSegments(context, threadId);
    const sourceFor = (threadId: string, segment: RollingSegment): string => {
      const records = canonical.list(threadId).filter((record) => segment.sourceRecordIds.includes(record.id));
      if (records.length !== segment.sourceRecordIds.length || sourceHash(records) !== segment.sourceHash)
        throw new Error('Canonical source no longer matches this segment hash.');
      const source = describeRecords(records);
      if (source.length > MAX_SOURCE_CHARS)
        throw new Error('Segment exceeds the safe summary size limit; keep it hot or compact smaller blocks.');
      return source;
    };
    const currentThread = (toolContext: ToolContext): Thread => {
      if (!toolContext.thread) throw new Error('Thread context is unavailable.');
      return toolContext.thread;
    };
    const reconcile = async (
      thread: Thread,
      records: readonly CanonicalRecord[],
      includeLatestComplete = false,
    ): Promise<RollingSegment[]> => {
      const previous = list(thread.id);
      const known = new Set(previous.map((segment) => segment.id));
      const runtimeCompaction = runtimeContextCompaction(records);
      const currentBlock = canonicalTurnBlocks(records).at(-1);
      const currentStart = currentBlock?.[0]?.seq ?? Number.POSITIVE_INFINITY;
      const sealable = completedCanonicalTurnBlocks(records).filter((block) => {
        const endSeq = block.at(-1)?.seq ?? Number.POSITIVE_INFINITY;
        if (runtimeCompaction && endSeq <= runtimeCompaction.contextThroughSeq) return false;
        return (
          endSeq < currentStart ||
          (includeLatestComplete && thread.state === 'idle' && endSeq === currentBlock?.at(-1)?.seq)
        );
      });
      let next = [...previous];
      for (const block of sealable) {
        const hash = sourceHash(block);
        const id = segmentId(thread.id, block, hash);
        if (known.has(id)) continue;
        const segment: RollingSegment = {
          id,
          threadId: thread.id,
          startSeq: block[0]!.seq,
          endSeq: block.at(-1)!.seq,
          sourceRecordIds: block.map((record) => record.id),
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
          updatedAt: new Date().toISOString(),
        };
        next.push(segment);
        saveSegments(context, thread.id, next, {
          threadId: thread.id,
          segmentId: segment.id,
          from: null,
          to: 'hot',
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          sourceHash: hash,
          reason: 'Sealed complete Canonical turn block.',
        });
        const source = describeRecords(block);
        let processed = await summarizeAndEvaluate(context, thread, segment, source);
        if (processed.tier !== segment.tier)
          saveSegments(
            context,
            thread.id,
            next.map((item) => (item.id === segment.id ? processed : item)),
            {
              threadId: thread.id,
              segmentId: segment.id,
              from: segment.tier,
              to: processed.tier,
              reason: processed.transitions.at(-1)?.reason ?? 'Automatic tier review',
              summaryVersion: processed.summaryVersion,
            },
          );
        next = next.map((item) => (item.id === segment.id ? processed : item));
        saveSegments(context, thread.id, next);
      }
      // Repair orphaned rolling metadata conservatively: a source mismatch forces the segment hot.
      next = next.map((segment) =>
        isRecordPresent(records, segment)
          ? segment
          : transition(segment, 'hot', 'Canonical source is unavailable; preserve raw projection where possible.'),
      );
      return next;
    };

    pipelines.use<ProjectionInput, ProjectionInput>('projection', async (input, next) => {
      const segments = await reconcile(input.thread, input.records);
      const projected = allTurns(context, input, segments);
      return next({
        ...input,
        turns: projected.turns,
        provenance: [...(input.provenance ?? []).filter((item) => item.kind !== 'canonical'), ...projected.provenance],
      });
    });

    tools.register(
      {
        name: 'rolling_segments',
        description:
          'List sealed Rolling Context segments, tiers, summary status, and evaluator decision for this Thread.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      (_args, toolContext) => list(currentThread(toolContext).id),
    );
    tools.register(
      {
        name: 'rolling_recall',
        description:
          'Retrieve exact Canonical source for a Rolling Context segment by segment_id. Use source text as evidence; canonical history remains unchanged.',
        parameters: {
          type: 'object',
          properties: { segment_id: { type: 'string' } },
          required: ['segment_id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const thread = currentThread(toolContext);
        const segment = list(thread.id).find((item) => item.id === args.segment_id);
        if (!segment) throw new Error('Rolling segment not found in this Thread.');
        const source = sourceFor(thread.id, segment);
        return {
          segmentId: segment.id,
          tier: segment.tier,
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          sourceHash: segment.sourceHash,
          source,
        };
      },
    );
    tools.register(
      {
        name: 'rolling_pin',
        description:
          'Keep a sealed Rolling Context segment hot so its exact Canonical records remain in future Model Inputs.',
        parameters: {
          type: 'object',
          properties: { segment_id: { type: 'string' } },
          required: ['segment_id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const thread = currentThread(toolContext);
        const segment = list(thread.id).find((item) => item.id === args.segment_id);
        if (!segment) throw new Error('Rolling segment not found in this Thread.');
        const updated = transition(segment, 'hot', 'Pinned hot by the Agent.');
        saveSegments(
          context,
          thread.id,
          list(thread.id).map((item) => (item.id === segment.id ? updated : item)),
          {
            threadId: thread.id,
            segmentId: segment.id,
            from: segment.tier,
            to: 'hot',
            reason: 'Pinned hot by the Agent.',
          },
        );
        return updated;
      },
    );
    tools.register(
      {
        name: 'rolling_warm',
        description:
          'Replace one sealed segment with its saved direct summary. This is an explicit manual compaction action and bypasses automatic cost gating.',
        parameters: {
          type: 'object',
          properties: { segment_id: { type: 'string' } },
          required: ['segment_id'],
          additionalProperties: false,
        },
      },
      (args, toolContext) => {
        const thread = currentThread(toolContext);
        const segment = list(thread.id).find((item) => item.id === args.segment_id);
        if (!segment || !segment.summary || segment.summaryStatus !== 'completed')
          throw new Error('A completed direct summary is required before manual warm compaction.');
        const records = canonical.list(thread.id);
        if (!canManualCompact(records, segment))
          throw new Error('This segment is not at a complete safe-turn boundary.');
        const updated = transition(segment, 'warm', 'Explicit manual compact by the Agent.');
        saveSegments(
          context,
          thread.id,
          list(thread.id).map((item) => (item.id === segment.id ? updated : item)),
          {
            threadId: thread.id,
            segmentId: segment.id,
            from: segment.tier,
            to: 'warm',
            reason: 'Explicit manual compact by the Agent.',
            summaryVersion: segment.summaryVersion,
          },
        );
        return updated;
      },
    );

    http.register('GET', '/segments', ({ query }) => ({ segments: list(requireThread(query.get('threadId'))) }));
    http.register('GET', '/inputs', ({ query }) => {
      const threadId = requireThread(query.get('threadId'));
      if (!context.threads.get(threadId)) throw new Error('Thread not found.');
      const inputs = context.canonical.list(threadId).flatMap((record) => {
        if (record.kind !== 'plugin') return [];
        const payload = object(record.payload);
        if (payload.pluginId !== 'pico.runtime' || payload.action !== 'model-input-recorded') return [];
        if (
          typeof payload.executionId !== 'string' ||
          typeof payload.requestId !== 'string' ||
          !payload.prompt ||
          typeof payload.prompt !== 'object' ||
          Array.isArray(payload.prompt)
        ) {
          return [];
        }
        const execution = context.executions.get(payload.executionId);
        return [
          {
            executionId: payload.executionId,
            attempt: {
              id: payload.requestId,
              prompt: payload.prompt,
              status: execution?.status ?? 'recorded',
              createdAt: record.createdAt,
            },
          },
        ];
      });
      return { inputs };
    });
    http.register('GET', '/source', ({ query }) => {
      const threadId = requireThread(query.get('threadId'));
      const segmentId = requireThread(query.get('segmentId'));
      const segment = list(threadId).find((item) => item.id === segmentId);
      if (!segment) throw new Error('Rolling segment not found.');
      return { source: sourceFor(threadId, segment), sourceHash: segment.sourceHash };
    });
    http.register('POST', '/action', async ({ body }: PluginHttpRequest) => {
      const value = object(body);
      const threadId = requireThread(value.threadId);
      const thread = context.threads.get(threadId);
      if (!thread) throw new Error('Thread not found.');
      const segment = list(threadId).find((item) => item.id === value.segmentId);
      if (value.action === 'refresh') return { segments: await reconcile(thread, canonical.list(threadId)) };
      if (value.action === 'compact-all') {
        if (thread.state !== 'idle')
          throw new Error('Pause or wait for the Thread to reach an idle safe boundary before compacting.');
        await reconcile(thread, canonical.list(threadId), true);
        const segments = list(threadId);
        let warmed = 0;
        for (const item of segments) {
          if (!item.summary || item.summaryStatus !== 'completed' || !canManualCompact(canonical.list(threadId), item))
            continue;
          const updated = transition(item, 'warm', 'Explicit user fallback compact.');
          saveSegments(
            context,
            threadId,
            list(threadId).map((entry) => (entry.id === item.id ? updated : entry)),
            {
              threadId,
              segmentId: item.id,
              from: item.tier,
              to: 'warm',
              reason: 'Explicit user fallback compact.',
              summaryVersion: item.summaryVersion,
            },
          );
          if (item.tier !== 'warm') warmed += 1;
        }
        if (warmed > 0)
          context.threads.pause(
            threadId,
            'Rolling Context was manually compacted. Review the projected context before continuing.',
          );
        return {
          segments: list(threadId),
          message: `Manual compact applied to ${warmed} summarized safe segment(s). Canonical History is unchanged.${warmed > 0 ? ' Thread paused for review.' : ''}`,
        };
      }
      if (!segment) throw new Error('Rolling segment not found.');
      if (value.action === 'retry-summary') {
        if (!canManualCompact(canonical.list(threadId), segment))
          throw new Error('Segment is not at a safe complete-turn boundary.');
        const source = sourceFor(threadId, segment);
        // A retry must have a fresh idempotency key because Runtime keeps failed calls immutable.
        const retry = {
          ...segment,
          id: `${segment.id}-retry-${randomUUID().slice(0, 8)}`,
          sourceHash: segment.sourceHash,
        };
        const processed = await summarizeAndEvaluate(context, thread, retry, source);
        const normalized = {
          ...processed,
          id: segment.id,
          sourceHash: segment.sourceHash,
          threadId: segment.threadId,
          startSeq: segment.startSeq,
          endSeq: segment.endSeq,
          sourceRecordIds: segment.sourceRecordIds,
          transitions: segment.transitions,
        };
        saveSegments(
          context,
          threadId,
          list(threadId).map((item) => (item.id === segment.id ? normalized : item)),
        );
        return normalized;
      }
      if (value.action === 'pin') {
        const updated = transition(segment, 'hot', 'Pinned hot by the user.');
        saveSegments(
          context,
          threadId,
          list(threadId).map((item) => (item.id === segment.id ? updated : item)),
          { threadId, segmentId: segment.id, from: segment.tier, to: 'hot', reason: 'Pinned hot by the user.' },
        );
        return updated;
      }
      if (value.action === 'warm') {
        if (!segment.summary || !canManualCompact(canonical.list(threadId), segment))
          throw new Error('A completed summary and safe turn boundary are required.');
        const updated = transition(segment, 'warm', 'Explicit user fallback compact.');
        saveSegments(
          context,
          threadId,
          list(threadId).map((item) => (item.id === segment.id ? updated : item)),
          {
            threadId,
            segmentId: segment.id,
            from: segment.tier,
            to: 'warm',
            reason: 'Explicit user fallback compact.',
            summaryVersion: segment.summaryVersion,
          },
        );
        return updated;
      }
      if (value.action === 'cold') {
        if (!segment.summary || segment.tier !== 'warm')
          throw new Error('Only a summarized warm segment can move cold.');
        const updated = transition(segment, 'cold', 'Explicit user action moved this segment cold.');
        saveSegments(
          context,
          threadId,
          list(threadId).map((item) => (item.id === segment.id ? updated : item)),
          {
            threadId,
            segmentId: segment.id,
            from: segment.tier,
            to: 'cold',
            reason: 'Explicit user action moved this segment cold.',
            summaryVersion: segment.summaryVersion,
          },
        );
        return updated;
      }
      throw new Error('Unknown Rolling Context action.');
    });
    ui.contribute({
      slot: 'thread.toolbar',
      id: 'rolling-context',
      label: 'Rolling Context',
      description: 'Inspect hot, warm, and cold Canonical segments and the actual projected context.',
      entry: 'webui',
      component: 'RollingContextPanel',
      supportsPopover: true,
    });
  },
};
