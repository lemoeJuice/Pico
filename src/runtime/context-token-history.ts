import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectionInput } from '../contracts/plugin-pipeline.js';
import type { ModelInputPromptSnapshot, ProjectionProvenance } from '../contracts/runtime.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import { canonicalBlockToPromptTurns, completedCanonicalModelInvocationBlocks } from '../contracts/canonical-projection.js';
import type { AssistantPayload, CanonicalRecord, Thread, ThreadModelSelection } from '../core/types.js';
import {
  countObservedAppendDelta,
  replaceSegmentTokenLedger,
  type ExactSegmentRange,
  type ObservedPromptSnapshot,
  type PromptLayoutEntry,
  type SegmentTokenEntry,
} from './context-token-accounting.js';

export interface ProviderObservedContextTokenHistory {
  /** Exact provider input count for the target projection, when reconstructable. */
  inputTokens: number;
  source: 'provider';
  baselineExecutionId: string;
  snapshots: ObservedPromptSnapshot[];
  segmentLedger: SegmentTokenEntry[];
}

export interface ProviderObservedSegmentLedger {
  snapshots: ObservedPromptSnapshot[];
  segmentLedger: SegmentTokenEntry[];
  baselineExecutionId: string;
  baselineInputTokens: number;
}

type RecordObject = Record<string, unknown>;
interface BoundSnapshot {
  executionId: string;
  recordSeq: number;
  prompt: ModelInputPromptSnapshot;
  provenance: ProjectionProvenance[];
  assistant: AssistantPayload;
  assistantSeq: number;
  observed: ObservedPromptSnapshot;
  summaries: SummaryEvidence[];
}

interface SummaryEvidence {
  callId: string;
  range: ExactSegmentRange;
  version: string;
  count: number;
  body: unknown[];
}

function object(value: unknown): RecordObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordObject) : null;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stable(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as RecordObject)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function rollingSourceHash(records: readonly CanonicalRecord[]): string {
  return createHash('sha256').update(JSON.stringify(records, null, 2)).digest('hex');
}

function rollingId(threadId: string, records: readonly CanonicalRecord[], source: string): string {
  return `rc-${createHash('sha256')
    .update(`${threadId}:${records[0]?.seq}:${records.at(-1)?.seq}:${source}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function usageInput(assistant: AssistantPayload): number | null {
  const usage = object(assistant.usage);
  return count(usage?.inputTokens) ? usage.inputTokens : null;
}

function observedAppendDelta(previous: ObservedPromptSnapshot, current: ObservedPromptSnapshot): number | null {
  const appended = current.segments.slice(previous.segments.length).map(({ id, sourceHash, startSeq, endSeq }) => ({
    id, sourceHash, startSeq, endSeq,
  }));
  if (appended.length !== 1) return null;
  return countObservedAppendDelta(previous, current, appended);
}

function sourceRecords(records: readonly CanonicalRecord[], start: number, end: number): CanonicalRecord[] | null {
  if (!count(start) || !count(end) || start < 1 || end < start) return null;
  // Canonical records arrive ordered by sequence. Locate the range rather than
  // scanning the entire Thread for every provenance segment in every snapshot.
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle]!.seq < start) low = middle + 1;
    else high = middle;
  }
  const selected: CanonicalRecord[] = [];
  for (let index = low; index < records.length && records[index]!.seq <= end; index += 1) {
    const record = records[index]!;
    if (record.kind !== 'plugin') selected.push(record);
  }
  if (selected.length === 0 || selected[0]?.seq !== start || selected.at(-1)?.seq !== end) return null;
  return selected;
}

function observedSnapshot(
  prompt: ModelInputPromptSnapshot,
  provenance: ProjectionProvenance[],
  inputTokens: number,
  selection: ThreadModelSelection,
  records: readonly CanonicalRecord[],
  thread: Pick<Thread, 'id' | 'parentThreadId'>,
  allowPendingAssistantTools = false,
): ObservedPromptSnapshot | null {
  if (
    !count(inputTokens) ||
    prompt.version !== 1 ||
    prompt.model !== selection.model ||
    prompt.temperature !== (selection.parameters.temperature ?? 0.7) ||
    prompt.turns.some((turn) => Object.hasOwn(turn, 'reasoningReplay'))
  ) return null;
  if (prompt.turns.some((turn) => turn.kind === 'tool_result' && turn.images?.length)) return null;
  const segments: ObservedPromptSnapshot['segments'] = [];
  const covered = new Set<number>();
  const segmentByTurn = new Map<number, { segment: ObservedPromptSnapshot['segments'][number]; localIndex: number }>();
  for (const item of provenance) {
    if (item.disposition !== 'raw' || (item.kind !== 'rolling_segment' && item.kind !== 'canonical')) continue;
    const first = item.turnStartIndex;
    const last = item.turnEndIndex;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first! < 0 || last! <= first! || last! > prompt.turns.length)
      return null;
    if (!count(item.canonicalStartSeq) || !count(item.canonicalEndSeq)) return null;
    const source = sourceRecords(records, item.canonicalStartSeq!, item.canonicalEndSeq!);
    if (!source) return null;
    const projectedTurns = canonicalBlockToPromptTurns(source, thread);
    const actualTurns = prompt.turns.slice(first!, last!);
    if (!isDeepStrictEqual(projectedTurns, actualTurns)) return null;
    const blocks = completedCanonicalModelInvocationBlocks(source);
    const coveredSource = new Set(blocks.flat().map((record) => record.id));
    let blockTurnOffset = 0;
    for (const block of blocks) {
      const blockTurns = canonicalBlockToPromptTurns(block, thread);
      const assistantRecords = block.filter((record) => record.kind === 'assistant');
      const modelTurnIndexes = blockTurns
        .map((turn, index) => ({ turn, index }))
        .filter(({ turn }) => turn.kind === 'assistant_tools' || turn.kind === 'tool_result' || (turn.kind === 'message' && turn.role === 'assistant'))
        .map(({ index }) => index);
      if (assistantRecords.length !== 1 || modelTurnIndexes.length === 0) return null;
      const turnIndexes = modelTurnIndexes.map((index) => first! + blockTurnOffset + index);
      if (turnIndexes.some((index) => covered.has(index))) return null;
      for (const index of turnIndexes) covered.add(index);
      const accountingRecords = block.filter((record) => record.kind === 'assistant' || record.kind === 'tool_result');
      const startSeq = accountingRecords[0]?.seq;
      const endSeq = accountingRecords.at(-1)?.seq;
      if (!count(startSeq) || !count(endSeq)) return null;
      const sourceHash = rollingSourceHash(accountingRecords);
      const segment = {
        id: `${item.id}:assistant:${assistantRecords[0]!.id}`,
        sourceHash,
        startSeq,
        endSeq,
        turnKinds: blockTurns
          .filter((turn) => turn.kind === 'assistant_tools' || turn.kind === 'tool_result' || (turn.kind === 'message' && turn.role === 'assistant'))
          .map((turn) => turn.kind === 'tool_result' ? 'tool' as const : 'assistant' as const),
      };
      segments.push(segment);
      turnIndexes.forEach((turnIndex, localIndex) => segmentByTurn.set(turnIndex, { segment, localIndex }));
      blockTurnOffset += blockTurns.length;
    }
    const residual = source.filter((record) => !coveredSource.has(record.id));
    const residualTurns = canonicalBlockToPromptTurns(residual, thread);
    if (!isDeepStrictEqual(residualTurns, actualTurns.slice(blockTurnOffset))) return null;
    const residualAssistants = residual.filter((record) => record.kind === 'assistant');
    if (residualAssistants.length === 0) {
      if (residual.some((record) => record.kind !== 'message' || (record.payload as { role?: unknown }).role !== 'user')) return null;
    } else {
      if (!allowPendingAssistantTools || residualAssistants.length !== 1) return null;
      const assistant = residualAssistants[0]!;
      const assistantPosition = residual.findIndex((record) => record.id === assistant.id);
      if (
        assistantPosition < 0 ||
        residual.slice(0, assistantPosition).some((record) => record.kind !== 'message' || (record.payload as { role?: unknown }).role !== 'user')
      ) return null;
      const assistantPayload = object(assistant.payload);
      const batchId = typeof assistantPayload?.batchId === 'string' ? assistantPayload.batchId : '';
      const rawCalls = Array.isArray(assistantPayload?.toolCalls) ? assistantPayload.toolCalls : [];
      const callIds = rawCalls.map((raw) => object(raw)?.id);
      if (!batchId || callIds.length === 0 || callIds.some((id) => typeof id !== 'string' || !id)) return null;
      const expectedCallIds = new Set(callIds as string[]);
      if (expectedCallIds.size !== callIds.length) return null;
      const resultRecords = residual.slice(assistantPosition + 1);
      const seenResults = new Set<string>();
      for (const result of resultRecords) {
        if (result.kind !== 'tool_result') return null;
        const resultPayload = object(result.payload);
        const callId = typeof resultPayload?.toolCallId === 'string' ? resultPayload.toolCallId : '';
        if (resultPayload?.batchId !== batchId || !expectedCallIds.has(callId) || seenResults.has(callId)) return null;
        seenResults.add(callId);
      }
      if (seenResults.size >= expectedCallIds.size) return null;
      const pendingModelIndexes = residualTurns
        .map((turn, index) => ({ turn, index }))
        .filter(({ turn }) => turn.kind === 'assistant_tools' || turn.kind === 'tool_result');
      if (
        pendingModelIndexes.length !== resultRecords.length + 1 ||
        pendingModelIndexes.filter(({ turn }) => turn.kind === 'assistant_tools').length !== 1 ||
        pendingModelIndexes[0]?.turn.kind !== 'assistant_tools'
      ) return null;
      const accountingRecords = [assistant, ...resultRecords];
      const startSeq = assistant.seq;
      const endSeq = accountingRecords.at(-1)!.seq;
      const segment = {
        id: `${item.id}:assistant:${assistant.id}`,
        sourceHash: rollingSourceHash(accountingRecords),
        startSeq,
        endSeq,
        turnKinds: pendingModelIndexes.map(({ turn }) => turn.kind === 'tool_result' ? 'tool' as const : 'assistant' as const),
      };
      segments.push(segment);
      let localIndex = 0;
      for (let turnIndex = 0; turnIndex < residualTurns.length; turnIndex++) {
        const turn = residualTurns[turnIndex]!;
        const globalIndex = first! + blockTurnOffset + turnIndex;
        if (turn.kind === 'message' && turn.role === 'user') continue;
        if (turn.kind !== 'assistant_tools' && turn.kind !== 'tool_result') return null;
        if (covered.has(globalIndex)) return null;
        covered.add(globalIndex);
        segmentByTurn.set(globalIndex, { segment, localIndex });
        localIndex += 1;
      }
    }
    for (let index = first!; index < last!; index++) {
      if (!covered.has(index)) {
        const turn = prompt.turns[index]!;
        if (turn.kind !== 'message' || turn.role !== 'user') return null;
      }
    }
  }
  segments.sort((a, b) => a.startSeq - b.startSeq || a.endSeq - b.endSeq);
  const excludedTurns = new Set<number>();
  for (const item of provenance) {
    if (!(item.kind === 'rolling_segment' && item.disposition === 'summary')) continue;
    const first = item.turnStartIndex ?? item.turnIndex;
    const last = item.turnEndIndex ?? (item.turnIndex === undefined ? undefined : item.turnIndex + 1);
    if (first === undefined && last === undefined) continue;
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first! < 0 || last! < first! || last! > prompt.turns.length)
      return null;
    for (let index = first!; index < last!; index++) excludedTurns.add(index);
  }
  const layout: ObservedPromptSnapshot['layout'] = prompt.turns.map((turn, turnIndex) => {
    const mapped = segmentByTurn.get(turnIndex);
    return mapped
      ? {
          kind: 'segment' as const,
          segmentId: mapped.segment.id,
          sourceHash: mapped.segment.sourceHash,
          startSeq: mapped.segment.startSeq,
          endSeq: mapped.segment.endSeq,
          turnIndex: mapped.localIndex,
        }
      : { kind: 'fixed' as const, fingerprint: hash(turn) };
  });
  return {
    inputTokens,
    identity: {
      model: `${selection.provider}:${selection.modelId}:${selection.adapterId}:${prompt.model}`,
      connection: selection.provider,
      system: hash(prompt.system),
      tools: hash(prompt.tools),
      parameters: hash(prompt.temperature),
      // Per-turn fixed fingerprints and raw segment markers are represented in layout.
      fixedPrompt: hash('prompt-layout-v1'),
    },
    segments,
    layout,
  };
}

function readPrompt(value: unknown): ModelInputPromptSnapshot | null {
  const prompt = object(value);
  if (
    prompt?.version !== 1 || typeof prompt.system !== 'string' || !Array.isArray(prompt.turns) ||
    !Array.isArray(prompt.tools) || typeof prompt.model !== 'string' || typeof prompt.temperature !== 'number' ||
    prompt.opaqueReplayPresent === true
  ) return null;
  return prompt as unknown as ModelInputPromptSnapshot;
}

function pairedSnapshots(
  records: readonly CanonicalRecord[],
  selection: ThreadModelSelection,
  thread: Pick<Thread, 'id' | 'parentThreadId'>,
  summaryCalls: readonly PluginModelCallRecord[],
): Array<BoundSnapshot | null> {
  const assistants = new Map<string, { payload: AssistantPayload; seq: number }>();
  for (const record of records) {
    if (record.kind === 'assistant' && record.id.endsWith(':assistant')) {
      assistants.set(record.id.slice(0, -':assistant'.length), {
        payload: record.payload as unknown as AssistantPayload,
        seq: record.seq,
      });
    }
  }
  const result: Array<BoundSnapshot | null> = [];
  for (const record of records) {
    if (record.kind !== 'plugin') continue;
    const payload = object(record.payload);
    if (payload?.pluginId !== 'pico.runtime' || payload.action !== 'model-input-recorded') continue;
    const executionId = typeof payload.executionId === 'string' ? payload.executionId : '';
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const assistantRecord = assistants.get(executionId);
    const assistant = assistantRecord?.payload;
    const prompt = readPrompt(payload.prompt);
    const tokenAccountingSelection = object(payload.tokenAccountingSelection);
    if (
      !executionId || !requestId || !assistant || !assistantRecord || !prompt || !Array.isArray(payload.projectionProvenance) ||
      !tokenAccountingSelection || !isDeepStrictEqual(tokenAccountingSelection, selection) ||
      assistant.provider !== selection.provider || assistant.modelId !== selection.modelId ||
      assistant.adapterId !== selection.adapterId
    ) {
      result.push(null);
      continue;
    }
    const inputTokens = usageInput(assistant);
    if (inputTokens === null) {
      result.push(null);
      continue;
    }
    const provenance = payload.projectionProvenance as ProjectionProvenance[];
    const summaries = summaryTurns(prompt, provenance, records, thread.id, summaryCalls, selection);
    if (!summaries) {
      result.push(null);
      continue;
    }
    const observed = observedSnapshot(prompt, provenance, inputTokens, selection, records, thread);
    if (!observed) {
      result.push(null);
      continue;
    }
    result.push({
      executionId, recordSeq: record.seq, prompt, provenance, assistant, assistantSeq: assistantRecord.seq, observed,
      summaries: [...summaries.values()],
    });
  }
  return result;
}

function targetPrompt(projection: ProjectionInput, selection: ThreadModelSelection): ModelInputPromptSnapshot {
  return {
    version: 1,
    system: projection.systemPrompt,
    turns: projection.turns as ModelInputPromptSnapshot['turns'],
    tools: projection.tools,
    model: selection.model,
    temperature: selection.parameters.temperature ?? 0.7,
  };
}

function summaryTurns(
  prompt: ModelInputPromptSnapshot,
  provenance: ProjectionProvenance[],
  records: readonly CanonicalRecord[],
  threadId: string,
  summaryCalls: readonly PluginModelCallRecord[],
  selection: ThreadModelSelection,
): Map<string, SummaryEvidence> | null {
  const summaries = new Map<string, SummaryEvidence>();
  for (const item of provenance) {
    if (item.disposition !== 'summary') continue;
    if (item.kind !== 'rolling_segment') return null;
    const start = item.canonicalStartSeq;
    const end = item.canonicalEndSeq;
    const version = item.summaryVersion;
    const visible = item.summaryResponseVisibleTokens;
    const first = item.turnStartIndex;
    const last = item.turnEndIndex;
    const body =
      Number.isSafeInteger(first) && Number.isSafeInteger(last) && first! >= 0 && last! > first! && last! <= prompt.turns.length
        ? prompt.turns.slice(first!, last!)
        : null;
    if (
      !count(start) || !count(end) || start < 1 || end < start || !version || !count(visible) ||
      !body || body.length !== 1 || body[0]?.kind !== 'message' ||
      body[0].role !== 'assistant' || !body[0].content.trim() || !item.summaryCallId
    ) return null;
    const source = sourceRecords(records, start, end);
    if (!source || source.some((record) => record.kind !== 'assistant' && record.kind !== 'tool_result' && record.kind !== 'message')) return null;
    const sourceDigest = rollingSourceHash(source);
    const segmentId = rollingId(threadId, source, sourceDigest);
    const expectedId = `rolling:${segmentId}`;
    const validSegmentId = item.id === expectedId || item.id === `rolling:raw:${start}`;
    if (!validSegmentId || version !== `direct-summary-v2:${sourceDigest.slice(0, 12)}`) return null;
    const call = summaryCalls.find((candidate) => candidate.id === item.summaryCallId);
    const response = object(call?.response);
    const callPrompt = object(call?.prompt);
    const callSelection = object(callPrompt?.tokenAccountingSelection);
    const responseUsage = object(response?.usage);
    const callUsage = object(call?.usage);
    const output = responseUsage?.outputTokens;
    const reasoning = responseUsage?.reasoningTokens;
    const directKey = `summary:direct-summary-v2:${segmentId}:${sourceDigest}`;
    const retryPrefix = `summary:direct-summary-v2:${segmentId}-retry-`;
    const retrySuffix = `:${sourceDigest}`;
    const idempotencyKey = call?.idempotencyKey ?? '';
    const retryNonce = idempotencyKey.startsWith(retryPrefix) && idempotencyKey.endsWith(retrySuffix)
      ? idempotencyKey.slice(retryPrefix.length, -retrySuffix.length)
      : '';
    const validIdempotencyKey = idempotencyKey === directKey || /^[0-9a-f]{8}$/.test(retryNonce);
    if (
      !call || call.pluginId !== 'pico.rolling-context' || call.threadId !== threadId || call.status !== 'completed' ||
      call.purpose !== 'rolling-summary' ||
      !callSelection || !isDeepStrictEqual(callSelection, selection) ||
      call.provider !== selection.provider || call.model !== selection.model ||
      !validIdempotencyKey ||
      response?.content !== body[0].content || !count(output) || !count(reasoning) || reasoning > output ||
      output - reasoning !== visible || callUsage?.outputTokens !== output || callUsage?.reasoningTokens !== reasoning
    ) return null;
    if (summaries.has(item.id)) return null;
    summaries.set(item.id, {
      callId: item.summaryCallId,
      range: { id: item.id, sourceHash: sourceDigest, startSeq: start, endSeq: end },
      version,
      count: visible,
      body,
    });
  }
  return summaries;
}

function summaryReplacementLayout(
  baseline: BoundSnapshot,
  capsules: SummaryEvidence[],
  records: readonly CanonicalRecord[],
  thread: Pick<Thread, 'id' | 'parentThreadId'>,
): PromptLayoutEntry[] | null {
  const layout = [...baseline.observed.layout];
  const replacements: Array<{ indexes: number[]; entry: PromptLayoutEntry }> = [];
  for (const capsule of capsules) {
    const rawItems = baseline.provenance.filter((item) =>
      item.disposition === 'raw' && (item.kind === 'canonical' || item.kind === 'rolling_segment') &&
      count(item.canonicalStartSeq) && count(item.canonicalEndSeq) &&
      item.canonicalStartSeq! >= capsule.range.startSeq && item.canonicalEndSeq! <= capsule.range.endSeq,
    );
    if (rawItems.length === 0) return null;
    const sources: CanonicalRecord[] = [];
    const indexes: number[] = [];
    for (const item of rawItems) {
      const source = sourceRecords(records, item.canonicalStartSeq!, item.canonicalEndSeq!);
      const first = item.turnStartIndex;
      const last = item.turnEndIndex;
      if (!source || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first! < 0 || last! <= first!) return null;
      sources.push(...source);
      const mapped = canonicalBlockToPromptTurns(source, thread);
      const actual = baseline.prompt.turns.slice(first!, last!);
      if (!isDeepStrictEqual(mapped, actual)) return null;
      const blocks = completedCanonicalModelInvocationBlocks(source);
      const covered = new Set(blocks.flat().map((record) => record.id));
      if (source.some((record) => !covered.has(record.id) && (record.kind !== 'message' || (record.payload as { role?: unknown }).role !== 'user'))) return null;
      let blockOffset = 0;
      for (const block of blocks) {
        const turns = canonicalBlockToPromptTurns(block, thread);
        const modelTurns = turns
          .map((turn, index) => ({ turn, index }))
          .filter(({ turn }) => turn.kind === 'assistant_tools' || turn.kind === 'tool_result' || (turn.kind === 'message' && turn.role === 'assistant'));
        const assistant = block.find((record) => record.kind === 'assistant');
        if (!assistant || modelTurns.length === 0) return null;
        const segmentId = `${item.id}:assistant:${assistant.id}`;
        const segment = baseline.observed.segments.find((entry) => entry.id === segmentId);
        if (!segment) return null;
        let localIndex = 0;
        for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
          const globalIndex = first! + blockOffset + turnIndex;
          const turn = turns[turnIndex]!;
          const layoutEntry = baseline.observed.layout[globalIndex];
          if (turn.kind === 'message' && turn.role === 'user') {
            if (!layoutEntry || layoutEntry.kind !== 'fixed' || layoutEntry.fingerprint !== hash(turn)) return null;
            indexes.push(globalIndex);
          } else if (turn.kind === 'assistant_tools' || turn.kind === 'tool_result' || (turn.kind === 'message' && turn.role === 'assistant')) {
            const expected: PromptLayoutEntry = {
              kind: 'segment', segmentId, sourceHash: segment.sourceHash,
              startSeq: segment.startSeq, endSeq: segment.endSeq, turnIndex: localIndex++,
            };
            if (!layoutEntry || !isDeepStrictEqual(layoutEntry, expected)) return null;
            indexes.push(globalIndex);
          } else return null;
        }
        blockOffset += turns.length;
      }
      for (let index = first! + blockOffset; index < last!; index++) {
        const turn = baseline.prompt.turns[index]!;
        const entry = baseline.observed.layout[index];
        if (turn.kind !== 'message' || turn.role !== 'user' || entry?.kind !== 'fixed' || entry.fingerprint !== hash(turn)) return null;
        indexes.push(index);
      }
    }
    const expectedSource = sourceRecords(records, capsule.range.startSeq, capsule.range.endSeq);
    const uniqueSources = new Map(sources.map((record) => [record.id, record]));
    if (!expectedSource || !isDeepStrictEqual([...uniqueSources.keys()], expectedSource.map((record) => record.id))) return null;
    indexes.sort((a, b) => a - b);
    if (indexes.length === 0 || indexes.some((index, offset) => offset > 0 && index !== indexes[offset - 1]! + 1)) return null;
    replacements.push({ indexes, entry: { kind: 'fixed', fingerprint: hash(capsule.body[0]) } });
  }
  replacements.sort((a, b) => b.indexes[0]! - a.indexes[0]!);
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements) {
    const first = replacement.indexes[0]!;
    const last = replacement.indexes.at(-1)!;
    if (last >= previousStart) return null;
    previousStart = first;
    layout.splice(first, replacement.indexes.length, replacement.entry);
  }
  return layout;
}

/**
 * Reconstruct exact provider-observed history only when durable snapshots establish
 * a stable request prefix and every token replacement has a provider-reported source.
 */
export function buildProviderObservedContextTokenHistory(
  records: readonly CanonicalRecord[],
  projection: ProjectionInput,
  selection: ThreadModelSelection,
  summaryCalls: readonly PluginModelCallRecord[] = [],
): ProviderObservedContextTokenHistory | null {
  const ledger = buildProviderObservedSegmentLedger(records, projection.thread, selection, summaryCalls);
  if (!ledger) return null;
  const baseline = pairedSnapshots(records, selection, projection.thread, summaryCalls)
    .find((item) => item?.executionId === ledger.baselineExecutionId);
  if (!baseline) return null;
  const segmentLedger = ledger.segmentLedger;
  const observed = ledger.snapshots;
  const target = targetPrompt(projection, selection);
  const targetProv = projection.provenance ?? [];
  const baselineSummaries = summaryTurns(baseline.prompt, baseline.provenance, records, projection.thread.id, summaryCalls, selection);
  const targetSummaries = summaryTurns(target, targetProv, records, projection.thread.id, summaryCalls, selection);
  if (!baselineSummaries || !targetSummaries) return null;
  for (const [id, previous] of baselineSummaries) {
    const next = targetSummaries.get(id);
    if (!next || !isDeepStrictEqual(previous, next)) return null;
  }
  const targetObserved = observedSnapshot(target, targetProv, baseline.observed.inputTokens, selection, records, projection.thread, true);
  if (!targetObserved) return null;
  if (isDeepStrictEqual(target.turns, baseline.prompt.turns) &&
      target.system === baseline.prompt.system && isDeepStrictEqual(target.tools, baseline.prompt.tools) &&
      isDeepStrictEqual(targetObserved.layout, baseline.observed.layout)) {
    return {
      inputTokens: baseline.observed.inputTokens,
      source: 'provider',
      baselineExecutionId: baseline.executionId,
      snapshots: observed,
      segmentLedger,
    };
  }
  const sameNonHistory =
    targetObserved.identity.model === baseline.observed.identity.model &&
    targetObserved.identity.connection === baseline.observed.identity.connection &&
    targetObserved.identity.system === baseline.observed.identity.system &&
    targetObserved.identity.tools === baseline.observed.identity.tools &&
    targetObserved.identity.parameters === baseline.observed.identity.parameters &&
    targetObserved.identity.fixedPrompt === baseline.observed.identity.fixedPrompt;
  if (!sameNonHistory) return null;

  const baselineById = new Map(baseline.observed.segments.map((segment) => [segment.id, segment]));
  const targetById = new Map(targetObserved.segments.map((segment) => [segment.id, segment]));
  const capsules = [...targetSummaries.entries()]
    .filter(([id]) => !baselineSummaries.has(id))
    .map(([, summary]) => summary);
  const removed: ExactSegmentRange[] = [];
  for (const prior of baseline.observed.segments) {
    if (targetById.has(prior.id)) {
      if (!isDeepStrictEqual(targetById.get(prior.id), prior)) return null;
      continue;
    }
    const replacing = capsules.filter((item) =>
      item.range.startSeq <= prior.startSeq && item.range.endSeq >= prior.endSeq,
    );
    if (replacing.length !== 1) return null;
    removed.push(prior);
  }
  for (const capsule of capsules) {
    const covered = baseline.observed.segments.filter((segment) =>
      segment.startSeq >= capsule.range.startSeq && segment.endSeq <= capsule.range.endSeq,
    );
    if (covered.length === 0 || covered.some((segment) => targetById.has(segment.id))) return null;
    if (covered[0]!.startSeq !== capsule.range.startSeq || covered.at(-1)!.endSeq !== capsule.range.endSeq) return null;
  }

  const replacementLayout = summaryReplacementLayout(baseline, capsules, records, projection.thread);
  if (!replacementLayout) return null;

  const appended = targetObserved.segments.filter((segment) => !baselineById.has(segment.id));
  if (appended.length > 1) return null;
  let appendedVisibleTokens = 0;
  if (appended.length === 1) {
    const segment = appended[0]!;
    const provenance = targetProv.find((item) => segment.id.startsWith(`${item.id}:assistant:`));
    const source = sourceRecords(records, segment.startSeq, segment.endSeq);
    if (!provenance || provenance.disposition !== 'raw' || !source) return null;
    const assistantsInRange = source.filter((record) => record.kind === 'assistant');
    if (
      assistantsInRange.length !== 1 || assistantsInRange[0]!.seq !== baseline.assistantSeq ||
      source.some((record) => record.kind !== 'assistant' && record.kind !== 'tool_result')
    ) return null;
    const usage = object(baseline.assistant.usage);
    const output = usage?.outputTokens;
    const reasoning = usage?.reasoningTokens;
    // Some adapters replay reasoning content as input. Its input cost cannot be
    // inferred by subtracting reasoning from the previous output usage.
    if (baseline.assistant.reasoningReplay !== undefined ||
        (typeof baseline.assistant.reasoningContent === 'string' && baseline.assistant.reasoningContent.length > 0)) return null;
    if (!count(output) || !count(reasoning) || reasoning > output) return null;
    appendedVisibleTokens = output - reasoning;
  }
  const appendedLayout: PromptLayoutEntry[] = appended.flatMap((segment) =>
    segment.turnKinds.map((_, turnIndex): PromptLayoutEntry => ({
      kind: 'segment',
      segmentId: segment.id,
      sourceHash: segment.sourceHash,
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
      turnIndex,
    })),
  );
  const expectedLayout = [...replacementLayout, ...appendedLayout];
  if (!isDeepStrictEqual(expectedLayout, targetObserved.layout)) return null;
  const capsulesForAccounting = capsules.map((item) => ({
    id: item.range.id,
    sourceHash: item.range.sourceHash,
    visibleTokenCount: item.count,
  }));
  const replaced = replaceSegmentTokenLedger(
    baseline.observed.inputTokens,
    segmentLedger,
    removed,
    capsulesForAccounting,
  );
  if (replaced === null || !count(replaced + appendedVisibleTokens)) return null;
  return {
    inputTokens: replaced + appendedVisibleTokens,
    source: 'provider',
    baselineExecutionId: baseline.executionId,
    snapshots: observed,
    segmentLedger,
  };
}

export function buildProviderObservedSegmentLedger(
  records: readonly CanonicalRecord[],
  thread: Pick<Thread, 'id' | 'parentThreadId'>,
  selection: ThreadModelSelection,
  summaryCalls: readonly PluginModelCallRecord[] = [],
): ProviderObservedSegmentLedger | null {
  const entries = pairedSnapshots(records, selection, thread, summaryCalls);
  if (entries.length === 0 || entries.at(-1) === null) return null;
  const activeSnapshots: BoundSnapshot[] = [];
  const activeObserved: ObservedPromptSnapshot[] = [];
  const activeLedger: SegmentTokenEntry[] = [];
  for (const snapshot of entries) {
    if (!snapshot) {
      activeSnapshots.length = 0;
      activeObserved.length = 0;
      activeLedger.length = 0;
      continue;
    }
    const previous = activeObserved.at(-1);
    if (previous) {
      const previousBound = activeSnapshots.at(-1)!;
      const sameSummaries = isDeepStrictEqual(previousBound.summaries, snapshot.summaries);
      const delta = sameSummaries ? observedAppendDelta(previous, snapshot.observed) : null;
      if (delta === null) {
        activeSnapshots.length = 0;
        activeObserved.length = 0;
        activeLedger.length = 0;
      } else {
        const segment = snapshot.observed.segments.at(-1)!;
        const provenance = snapshot.provenance.find((item) => segment.id.startsWith(`${item.id}:assistant:`));
        if (!provenance || provenance.disposition !== 'raw') return null;
        activeLedger.push({ ...segment, tokenCount: delta });
      }
    }
    activeSnapshots.push(snapshot);
    activeObserved.push(snapshot.observed);
  }
  const baseline = activeSnapshots.at(-1);
  if (!baseline) return null;
  return {
    snapshots: activeObserved,
    segmentLedger: activeLedger,
    baselineExecutionId: baseline.executionId,
    baselineInputTokens: baseline.observed.inputTokens,
  };
}

