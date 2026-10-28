import { createHash } from 'node:crypto';
import type { AssistantPayload, CanonicalRecord, MessagePayload, Thread, ToolResultPayload } from '../core/types.js';
import type { PromptTurn } from './model.js';
import {
  isMultimodalToolResultEnvelope,
  multimodalToolResultText,
  sanitizeMultimodalResultValue,
} from './multimodal.js';

/** Stable, provider-neutral Canonical-to-prompt projection contract. */
export const CANONICAL_PROMPT_PROJECTION_VERSION = 'canonical-prompt-v1';
export const CANONICAL_PROMPT_PROJECTION_SOURCE = 'core.canonical-prompt';

export interface CanonicalProjectionContext {
  threadId: string;
  parentThreadId: string | null;
}

export interface RuntimeContextCompaction {
  version: 1;
  throughSeq: number;
  /** Highest Canonical seq omitted from the active prompt after a checkpoint restore. */
  contextThroughSeq: number;
  /** Compaction or restore fact that established the active model projection. */
  projectionRecordSeq: number;
  sourceRecordIds: string[];
  sourceHash: string;
  summary: string;
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function canonicalSourceHash(records: readonly CanonicalRecord[]): string {
  return createHash('sha256')
    .update(JSON.stringify(records.map(({ id, seq, kind, payload }) => ({ id, seq, kind, payload }))))
    .digest('hex');
}

function isLegacyRewindCompactionReset(records: readonly CanonicalRecord[], index: number): boolean {
  const reset = records[index];
  const rewind = records[index - 1];
  if (!reset || !rewind || reset.seq !== rewind.seq + 1 || !reset.id.startsWith('pico:runtime-context-rewind-reset:')) {
    return false;
  }

  const resetPayload = reset.kind === 'plugin' ? recordObject(reset.payload) : {};
  const rewindPayload = rewind.kind === 'plugin' ? recordObject(rewind.payload) : {};
  if (
    resetPayload.pluginId !== 'pico.runtime' ||
    resetPayload.action !== 'context-compaction-reset' ||
    resetPayload.version !== 1 ||
    rewindPayload.pluginId !== 'pico.runtime' ||
    rewindPayload.action !== 'context-rewound' ||
    rewindPayload.version !== 1 ||
    !Number.isSafeInteger(rewindPayload.targetSeq) ||
    resetPayload.resetThroughSeq !== rewindPayload.targetSeq ||
    typeof rewindPayload.targetRecordId !== 'string' ||
    typeof resetPayload.resetSourceHash !== 'string'
  ) {
    return false;
  }

  const beforeReset = records.slice(0, index);
  const target = beforeReset.find((record) => record.id === rewindPayload.targetRecordId);
  const targetSeq = rewindPayload.targetSeq as number;
  const conversation = canonicalConversationRecords(beforeReset);
  return Boolean(
    target &&
      canonicalRewindThroughSeq(conversation, target) === targetSeq &&
      resetPayload.resetSourceHash === canonicalSourceHash(conversation.filter((record) => record.seq <= targetSeq)),
  );
}

function latestRuntimeContextCompactionResetSeq(records: readonly CanonicalRecord[]): number {
  return records.reduce((latest, record, index) => {
    const payload = record.kind === 'plugin' ? recordObject(record.payload) : {};
    if (
      payload.pluginId === 'pico.runtime' &&
      payload.action === 'context-compaction-reset' &&
      !isLegacyRewindCompactionReset(records, index)
    ) {
      return Math.max(latest, record.seq);
    }
    return latest;
  }, 0);
}

/** Return only the conversation input/output for each Canonical seq in history-tool results. */
export function projectThreadHistoryIo(value: unknown, depth = 0): { records: Array<Record<string, unknown>> } {
  if (depth > 8) return { records: [] };
  const source = recordObject(value);
  const rawRecords = Array.isArray(value) ? value : Array.isArray(source.records) ? source.records : [];
  const records: Array<Record<string, unknown>> = [];

  for (const rawRecord of rawRecords) {
    const record = recordObject(rawRecord);
    if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) continue;
    const projected: Record<string, unknown> = { seq: record.seq };
    const payload = recordObject(record.payload);

    if (record.kind === 'message' && typeof payload.content === 'string') {
      if (payload.role === 'user') projected.input = payload.content;
      else if (payload.role === 'assistant') projected.output = payload.content;
    } else if (record.kind === 'assistant') {
      const toolCalls = Array.isArray(payload.toolCalls)
        ? payload.toolCalls.map((rawCall) => {
            const call = recordObject(rawCall);
            return {
              name: typeof call.name === 'string' ? call.name : 'unknown',
              arguments: recordObject(call.arguments),
            };
          })
        : [];
      if (typeof payload.content === 'string' && payload.content) {
        projected.output = toolCalls.length > 0 ? { text: payload.content, tool_calls: toolCalls } : payload.content;
      } else if (toolCalls.length > 0) {
        projected.output = { tool_calls: toolCalls };
      } else {
        projected.output = '';
      }
    } else if (record.kind === 'tool_result') {
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
      const result =
        toolName === 'read_thread_history'
          ? { omitted: 'Nested read_thread_history results are available by calling the tool directly.' }
          : sanitizeMultimodalResultValue(payload.result ?? null);
      projected.output = {
        tool: toolName,
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
        result,
      };
    } else if (record.kind === undefined && ('input' in record || 'output' in record)) {
      // Keep the projection idempotent when a prior read_thread_history result is read again.
      if (typeof record.input === 'string') projected.input = record.input;
      if ('output' in record) {
        const output = recordObject(record.output);
        projected.output =
          output.tool === 'read_thread_history' && 'result' in output
            ? {
                ...output,
                result: { omitted: 'Nested read_thread_history results are available by calling the tool directly.' },
              }
            : sanitizeMultimodalResultValue(record.output);
      }
    }

    if ('input' in projected || 'output' in projected) records.push(projected);
  }
  return { records };
}

/** Hide successful history reads after a later Model response has seen them once. */
export function omitConsumedThreadHistoryResults(records: readonly CanonicalRecord[]): CanonicalRecord[] {
  const consumedThrough = records.reduce((latest, record) => {
    if (record.kind !== 'assistant') return latest;
    const payload = recordObject(record.payload);
    return Number.isSafeInteger(payload.projectionThrough)
      ? Math.max(latest, payload.projectionThrough as number)
      : latest;
  }, 0);
  if (consumedThrough === 0) return [...records];
  return records.map((record) => {
    if (record.kind !== 'tool_result' || record.seq > consumedThrough) return record;
    const payload = recordObject(record.payload);
    if (payload.toolName !== 'read_thread_history' || payload.status !== 'completed') return record;
    return {
      ...record,
      payload: {
        ...payload,
        result: {
          omitted:
            'This history result was already provided to the Model. Call read_thread_history again to inspect it.',
        },
      },
    };
  });
}

function reasoningContent(payload: AssistantPayload): string | undefined {
  return typeof payload.reasoningContent === 'string' ? payload.reasoningContent : undefined;
}

function isUserMessage(record: CanonicalRecord): boolean {
  const payload = recordObject(record.payload);
  return record.kind === 'message' && payload.role === 'user';
}

/** Splits Canonical History at user-message boundaries without separating pending Tool Call/Result pairs. */
export function canonicalTurnBlocks(records: readonly CanonicalRecord[]): CanonicalRecord[][] {
  const relevant = records.filter((record) => record.kind !== 'plugin');
  const blocks: CanonicalRecord[][] = [];
  let current: CanonicalRecord[] = [];
  const pendingResults = new Set<string>();
  for (const record of relevant) {
    if (isUserMessage(record) && current.length && pendingResults.size === 0) {
      blocks.push(current);
      current = [];
    }
    current.push(record);
    if (record.kind === 'assistant') {
      const payload = recordObject(record.payload);
      const batchId = typeof payload.batchId === 'string' ? payload.batchId : null;
      const calls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
      if (batchId) {
        for (const rawCall of calls) {
          const call = recordObject(rawCall);
          if (typeof call.id === 'string') pendingResults.add(`${batchId}:${call.id}`);
        }
      }
    } else if (record.kind === 'tool_result') {
      const result = recordObject(record.payload);
      if (typeof result.batchId === 'string' && typeof result.toolCallId === 'string') {
        pendingResults.delete(`${result.batchId}:${result.toolCallId}`);
      }
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

export function completedCanonicalTurnBlocks(records: readonly CanonicalRecord[]): CanonicalRecord[][] {
  return canonicalTurnBlocks(records).filter((block) => {
    const last = block.at(-1);
    if (!last || last.kind !== 'assistant') return false;
    const payload = recordObject(last.payload);
    return Array.isArray(payload.toolCalls) && payload.toolCalls.length === 0;
  });
}

/**
 * Splits history into complete model-invocation units for Runtime compaction.
 * Messages before a response attach to that invocation; tool calls and every
 * matching result remain together. An incomplete or malformed suffix is not
 * exposed as a safe compaction boundary.
 */
export function completedCanonicalModelInvocationBlocks(records: readonly CanonicalRecord[]): CanonicalRecord[][] {
  const blocks: CanonicalRecord[][] = [];
  let current: CanonicalRecord[] = [];
  let pendingResults: Set<string> | null = null;

  for (const record of records) {
    if (record.kind === 'plugin') continue;

    if (record.kind === 'assistant') {
      if (pendingResults) break;
      const payload = recordObject(record.payload);
      const rawCalls = payload.toolCalls;
      if (!Array.isArray(rawCalls)) break;
      current.push(record);

      if (rawCalls.length === 0) {
        blocks.push(current);
        current = [];
        continue;
      }

      const batchId = typeof payload.batchId === 'string' && payload.batchId ? payload.batchId : null;
      if (!batchId) break;
      const expected = new Set<string>();
      for (const rawCall of rawCalls) {
        const call = recordObject(rawCall);
        if (typeof call.id !== 'string' || !call.id) return blocks;
        const key = `${batchId}:${call.id}`;
        if (expected.has(key)) return blocks;
        expected.add(key);
      }
      pendingResults = expected;
      continue;
    }

    current.push(record);
    if (record.kind !== 'tool_result') continue;

    const result = recordObject(record.payload);
    if (
      !pendingResults ||
      typeof result.batchId !== 'string' ||
      typeof result.toolCallId !== 'string' ||
      !pendingResults.delete(`${result.batchId}:${result.toolCallId}`)
    ) {
      break;
    }
    if (pendingResults.size === 0) {
      blocks.push(current);
      current = [];
      pendingResults = null;
    }
  }

  return blocks;
}

export function canonicalConversationRecords(records: readonly CanonicalRecord[]): CanonicalRecord[] {
  return records.filter((record) => record.kind !== 'plugin');
}

/** Return the last seq that belongs to a stable, visible conversation message. */
export function canonicalRewindThroughSeq(
  records: readonly CanonicalRecord[],
  target: CanonicalRecord,
): number | null {
  const conversation = canonicalConversationRecords(records);
  const targetIndex = conversation.findIndex((record) => record.id === target.id);
  if (targetIndex < 0) return null;

  if (target.kind === 'message') {
    return recordObject(target.payload).role === 'user' ? target.seq : null;
  }
  if (target.kind !== 'assistant') return null;

  const payload = recordObject(target.payload);
  if (!Array.isArray(payload.toolCalls)) return null;
  if (payload.toolCalls.length === 0) return target.seq;
  if (typeof payload.batchId !== 'string' || !payload.batchId) return null;

  const expectedCallIds = new Set<string>();
  for (const rawCall of payload.toolCalls) {
    const callId = recordObject(rawCall).id;
    if (typeof callId !== 'string' || !callId || expectedCallIds.has(callId)) return null;
    expectedCallIds.add(callId);
  }

  const expectedResultIds = new Set<string>();
  let throughSeq = target.seq;
  for (const record of conversation.slice(targetIndex + 1)) {
    if (record.kind !== 'tool_result') continue;
    const result = recordObject(record.payload);
    if (result.batchId !== payload.batchId || typeof result.toolCallId !== 'string') continue;
    if (!expectedCallIds.has(result.toolCallId) || expectedResultIds.has(result.toolCallId)) return null;
    expectedResultIds.add(result.toolCallId);
    throughSeq = Math.max(throughSeq, record.seq);
  }
  if (expectedResultIds.size !== expectedCallIds.size) return null;

  for (const record of conversation) {
    if (record.seq <= target.seq || record.seq > throughSeq) continue;
    const result = recordObject(record.payload);
    if (
      record.kind !== 'tool_result' ||
      result.batchId !== payload.batchId ||
      typeof result.toolCallId !== 'string' ||
      !expectedCallIds.has(result.toolCallId)
    ) {
      return null;
    }
  }
  return throughSeq;
}

export interface RuntimeConversationProjection {
  activeProjectionId: string | null;
  records: CanonicalRecord[];
  historyBranches: RuntimeHistoryBranch[];
  projectionIdForRecord(recordId: string): string | null | undefined;
  recordsForProjection(projectionId: string | null): CanonicalRecord[];
}

export interface RuntimeHistoryBranch {
  id: string;
  parentId: string | null;
  targetRecordId: string;
  targetSeq: number;
  createdAt: string;
  preview: string;
  onActivePath: boolean;
  active: boolean;
}

/**
 * Reconstruct the selected append-only conversation path. A rewind fact points
 * at a visible conversation message and forks from the path that contained it;
 * later canonical records remain available in other paths.
 */
export function runtimeConversationProjection(records: readonly CanonicalRecord[]): RuntimeConversationProjection {
  const byId = new Map(records.map((record) => [record.id, record]));
  const ownerByRecordId = new Map<string, string | null>();
  const recordsByProjection = new Map<string | null, CanonicalRecord[]>([[null, []]]);
  const nodes = new Map<
    string,
    {
      parentProjectionId: string | null;
      targetRecordId?: string;
      throughSeq?: number;
      ownRecords: CanonicalRecord[];
    }
  >();
  let activeProjectionId: string | null = null;

  const recordsForProjection = (projectionId: string | null): CanonicalRecord[] => {
    if (projectionId === null) return [...(recordsByProjection.get(null) ?? [])];
    const node = nodes.get(projectionId);
    if (!node) return [];
    const parent = recordsForProjection(node.parentProjectionId);
    if (node.targetRecordId) {
      const targetIndex = parent.findIndex((record) => record.id === node.targetRecordId);
      const throughSeq = node.throughSeq;
      if (targetIndex < 0 || throughSeq === undefined) return [];
      return [
        ...parent.filter((record) => record.seq <= throughSeq),
        ...(recordsByProjection.get(projectionId) ?? []),
      ];
    }
    if (node.throughSeq !== undefined) {
      return [
        ...parent.filter((record) => record.seq <= node.throughSeq!),
        ...(recordsByProjection.get(projectionId) ?? []),
      ];
    }
    return [];
  };

  const projectionChain = (projectionId: string | null): string[] => {
    const chain: string[] = [];
    let current = projectionId;
    while (current !== null) {
      const node = nodes.get(current);
      if (!node) break;
      chain.push(current);
      current = node.parentProjectionId;
    }
    return chain.reverse();
  };

  for (const record of records) {
    if (record.kind === 'plugin') {
      const payload = recordObject(record.payload);
      const isRewind =
        payload.pluginId === 'pico.runtime' &&
        payload.action === 'context-rewound' &&
        payload.version === 1 &&
        typeof payload.targetRecordId === 'string' &&
        Number.isSafeInteger(payload.targetSeq) &&
        (payload.targetSeq as number) >= 1 &&
        (payload.parentProjectionId === null || typeof payload.parentProjectionId === 'string');
      if (payload.pluginId === 'pico.runtime' && payload.action === 'context-rewound') {
        if (!isRewind) continue;
        const targetRecordId = payload.targetRecordId as string;
        const parentProjectionId = payload.parentProjectionId as string | null;
        const targetSeq = payload.targetSeq as number;
        const target = byId.get(targetRecordId);
        if (
          !target ||
          (target.kind !== 'message' && target.kind !== 'assistant') ||
          targetSeq < target.seq ||
          targetSeq >= record.seq ||
          !ownerByRecordId.has(targetRecordId) ||
          ownerByRecordId.get(targetRecordId) !== parentProjectionId
        ) {
          continue;
        }
        const parentRecords = recordsForProjection(parentProjectionId);
        if (
          canonicalRewindThroughSeq(parentRecords, target) !== targetSeq ||
          !parentRecords.some((item) => item.id === targetRecordId)
        ) {
          continue;
        }

        const ownRecords: CanonicalRecord[] = [];
        nodes.set(record.id, { parentProjectionId, targetRecordId, throughSeq: targetSeq, ownRecords });
        recordsByProjection.set(record.id, ownRecords);
        ownerByRecordId.set(record.id, record.id);
        ownRecords.push(record);
        activeProjectionId = record.id;
        continue;
      }

      if (
        payload.pluginId === 'pico.runtime' &&
        payload.action === 'context-restored' &&
        payload.version === 1 &&
        Number.isSafeInteger(payload.checkpointThroughSeq) &&
        (payload.checkpointThroughSeq as number) >= 1 &&
        typeof payload.checkpointSourceHash === 'string' &&
        /^[a-f0-9]{64}$/i.test(payload.checkpointSourceHash) &&
        Number.isSafeInteger(payload.contextThroughSeq) &&
        (payload.contextThroughSeq as number) >= (payload.checkpointThroughSeq as number)
      ) {
        const checkpointThroughSeq = payload.checkpointThroughSeq as number;
        const contextThroughSeq = payload.contextThroughSeq as number;
        const parentRecords = recordsForProjection(activeProjectionId);
        const parentConversation = canonicalConversationRecords(parentRecords);
        const source = parentConversation.filter((item) => item.seq <= checkpointThroughSeq);
        const contextThroughRecord = parentConversation.find((item) => item.seq === contextThroughSeq);
        const contextThroughRecordId =
          typeof payload.contextThroughRecordId === 'string' ? payload.contextThroughRecordId : null;
        const hasContextThroughAnchor = contextThroughRecord
          ? contextThroughRecordId === null || contextThroughRecord.id === contextThroughRecordId
          : contextThroughRecordId !== null;
        const latestResetSeq = latestRuntimeContextCompactionResetSeq(parentRecords);
        const hasMatchingCheckpoint = records.some((candidate) => {
          if (candidate.kind !== 'plugin' || candidate.seq <= latestResetSeq || candidate.seq >= record.seq) return false;
          const candidatePayload = recordObject(candidate.payload);
          const sourceIds = candidatePayload.sourceRecordIds;
          return (
            candidatePayload.pluginId === 'pico.runtime' &&
            candidatePayload.action === 'context-compacted' &&
            candidatePayload.version === 1 &&
            candidatePayload.throughSeq === checkpointThroughSeq &&
            candidatePayload.sourceHash === payload.checkpointSourceHash &&
            typeof candidatePayload.summary === 'string' &&
            Boolean(candidatePayload.summary.trim()) &&
            Array.isArray(sourceIds) &&
            sourceIds.length === source.length &&
            sourceIds.every((id, index) => id === source[index]?.id)
          );
        });
        if (hasMatchingCheckpoint && hasContextThroughAnchor && source.length > 0) {
          const ownRecords = [record];
          nodes.set(record.id, {
            parentProjectionId: activeProjectionId,
            throughSeq: checkpointThroughSeq,
            ownRecords,
          });
          recordsByProjection.set(record.id, ownRecords);
          ownerByRecordId.set(record.id, record.id);
          activeProjectionId = record.id;
          continue;
        }
      }
    }

    if (!recordsByProjection.has(activeProjectionId)) recordsByProjection.set(activeProjectionId, []);
    ownerByRecordId.set(record.id, activeProjectionId);
    recordsByProjection.get(activeProjectionId)!.push(record);
  }

  const activeRewindIds = projectionChain(activeProjectionId).filter((id) => nodes.get(id)?.targetRecordId);
  const activeRewindIdSet = new Set(activeRewindIds);
  const historyBranches: RuntimeHistoryBranch[] = [...nodes.entries()].flatMap(([id, node]) => {
    if (!node.targetRecordId || node.throughSeq === undefined) return [];
    const ancestors = projectionChain(node.parentProjectionId).filter((ancestorId) =>
      nodes.get(ancestorId)?.targetRecordId,
    );
    const target = byId.get(node.targetRecordId);
    if (!target) return [];
    const payload = recordObject(target.payload);
    const preview = typeof payload.content === 'string'
      ? payload.content.replace(/\s+/g, ' ').trim().slice(0, 240)
      : '';
    return [{
      id,
      parentId: ancestors.at(-1) ?? null,
      targetRecordId: node.targetRecordId,
      targetSeq: target.seq,
      createdAt: byId.get(id)?.createdAt ?? '',
      preview,
      onActivePath: activeRewindIdSet.has(id),
      active: activeRewindIds.at(-1) === id,
    }];
  }).sort((left, right) => {
    const leftRecord = byId.get(left.id);
    const rightRecord = byId.get(right.id);
    return (leftRecord?.seq ?? 0) - (rightRecord?.seq ?? 0);
  });

  return {
    activeProjectionId,
    records: recordsForProjection(activeProjectionId),
    historyBranches,
    projectionIdForRecord(recordId) {
      return ownerByRecordId.get(recordId);
    },
    recordsForProjection,
  };
}

/** Reads the latest valid Runtime-owned compaction fact without changing Canonical History. */
export function runtimeContextCompaction(records: readonly CanonicalRecord[]): RuntimeContextCompaction | null {
  const activeProjection = runtimeConversationProjection(records).records;
  const activeProjectionIds = new Set(activeProjection.map((record) => record.id));
  const conversation = canonicalConversationRecords(activeProjection);
  const byId = new Set(conversation.map((record) => record.id));
  const latestResetSeq = latestRuntimeContextCompactionResetSeq(activeProjection);
  const restoreFacts: Array<{
    recordId: string;
    recordSeq: number;
    checkpointThroughSeq: number;
    checkpointSourceHash?: string;
    contextThroughSeq: number;
  }> = activeProjection.flatMap((record) => {
    if (record.kind !== 'plugin' || record.seq <= latestResetSeq) return [];
    const payload = recordObject(record.payload);
    if (
      payload.pluginId === 'pico.runtime' &&
      payload.action === 'context-restored' &&
      payload.version === 1 &&
      Number.isSafeInteger(payload.checkpointThroughSeq) &&
      (payload.checkpointThroughSeq as number) >= 1 &&
      typeof payload.checkpointSourceHash === 'string' &&
      /^[a-f0-9]{64}$/i.test(payload.checkpointSourceHash) &&
      Number.isSafeInteger(payload.contextThroughSeq) &&
      (payload.contextThroughSeq as number) >= (payload.checkpointThroughSeq as number)
    ) {
      return [{
        recordId: record.id,
        recordSeq: record.seq,
        checkpointThroughSeq: payload.checkpointThroughSeq as number,
        checkpointSourceHash: payload.checkpointSourceHash,
        contextThroughSeq: payload.contextThroughSeq as number,
      }];
    }
    const recovery = recordObject(payload.recovery);
    if (
      payload.pluginId === 'pico.runtime' &&
      payload.action === 'context-compacted' &&
      recovery.mode === 'restore-latest-checkpoint' &&
      Number.isSafeInteger(recovery.checkpointThroughSeq) &&
      (recovery.checkpointThroughSeq as number) >= 1 &&
      Number.isSafeInteger(payload.throughSeq) &&
      (payload.throughSeq as number) >= (recovery.checkpointThroughSeq as number)
    ) {
      return [{
        recordId: record.id,
        recordSeq: record.seq,
        checkpointThroughSeq: recovery.checkpointThroughSeq as number,
        contextThroughSeq: payload.throughSeq as number,
      }];
    }
    return [];
  });
  for (const record of [...records].reverse()) {
    if (record.kind !== 'plugin' || record.seq <= latestResetSeq) continue;
    const payload = recordObject(record.payload);
    const recovery = recordObject(payload.recovery);
    if (
      payload.pluginId === 'pico.runtime' &&
      payload.action === 'context-compacted' &&
      recovery.mode === 'restore-latest-checkpoint' &&
      Number.isSafeInteger(recovery.checkpointThroughSeq) &&
      (recovery.checkpointThroughSeq as number) >= 1 &&
      Number.isSafeInteger(payload.throughSeq) &&
      (payload.throughSeq as number) >= (recovery.checkpointThroughSeq as number)
    ) continue;
    const sourceIds = payload.sourceRecordIds;
    const candidateThroughSeq = payload.throughSeq;
    const sourceHash = payload.sourceHash;
    const matchesActiveRestore = restoreFacts.some(
      (candidate) =>
        candidate.recordSeq > record.seq &&
        candidate.checkpointThroughSeq === candidateThroughSeq &&
        (candidate.checkpointSourceHash === undefined || candidate.checkpointSourceHash === sourceHash),
    );
    if (
      payload.pluginId !== 'pico.runtime' ||
      payload.action !== 'context-compacted' ||
      (!activeProjectionIds.has(record.id) &&
        !matchesActiveRestore &&
        !sourceIdsMatchConversation(sourceIds, conversation, candidateThroughSeq)) ||
      payload.version !== 1 ||
      !Number.isSafeInteger(payload.throughSeq) ||
      (payload.throughSeq as number) < 1 ||
      typeof payload.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(payload.sourceHash) ||
      typeof payload.summary !== 'string' ||
      !payload.summary.trim() ||
      !Array.isArray(sourceIds) ||
      !sourceIds.every((id): id is string => typeof id === 'string')
    ) {
      continue;
    }
    const throughSeq = payload.throughSeq as number;
    const source = conversation.filter((item) => item.seq <= throughSeq);
    if (
      source.length !== sourceIds.length ||
      source.some((item, index) => item.id !== sourceIds[index]) ||
      source.some((item) => !byId.has(item.id))
    ) {
      continue;
    }
    const restore = restoreFacts.find(
      (candidate) =>
        candidate.recordSeq > record.seq &&
        activeProjectionIds.has(candidate.recordId) &&
        candidate.checkpointThroughSeq === throughSeq &&
        (candidate.checkpointSourceHash === undefined || candidate.checkpointSourceHash === payload.sourceHash),
    );
    return {
      version: 1,
      throughSeq,
      contextThroughSeq: restore?.contextThroughSeq ?? throughSeq,
      projectionRecordSeq: restore?.recordSeq ?? record.seq,
      sourceRecordIds: [...sourceIds],
      sourceHash: payload.sourceHash,
      summary: payload.summary,
    };
  }
  return null;
}

function sourceIdsMatchConversation(
  sourceIds: unknown,
  conversation: readonly CanonicalRecord[],
  throughSeq: unknown,
): boolean {
  if (
    !Number.isSafeInteger(throughSeq) ||
    !Array.isArray(sourceIds) ||
    !sourceIds.every((id): id is string => typeof id === 'string')
  ) {
    return false;
  }
  const source = conversation.filter((item) => item.seq <= (throughSeq as number));
  return source.length === sourceIds.length && source.every((item, index) => item.id === sourceIds[index]);
}

export function runtimeCompactionTurn(compaction: RuntimeContextCompaction): PromptTurn {
  return {
    kind: 'message',
    role: 'user',
    content: `Runtime compaction summary for Canonical seq 1-${compaction.throughSeq} (source ${compaction.sourceHash.slice(0, 16)}):\n${compaction.summary}`,
  };
}

function messageContent(message: MessagePayload, context: CanonicalProjectionContext): string {
  if (message.source === 'user') return message.content;
  const source =
    message.senderThreadId && message.senderThreadId === context.parentThreadId
      ? 'Parent Thread'
      : message.source === 'child'
        ? 'Child Thread'
        : 'Agent Thread';
  const label = message.senderLabel?.trim();
  const senderLabel = label ? ` ${JSON.stringify(label)}` : '';
  const senderId = message.senderThreadId ? ` (Thread ID: ${JSON.stringify(message.senderThreadId)})` : '';
  return `[Message from ${source}${senderLabel}${senderId}]\n${message.content}`;
}

function toolResultContent(payload: ToolResultPayload): string {
  if (payload.status === 'interrupted') {
    return `Execution interrupted. ${payload.error ?? ''} Its real-world side effects may be partial or unknown. Inspect the environment before retrying.`;
  }
  if (payload.status === 'failed') {
    const guidance = recordObject(payload.result).modelGuidance;
    return `Tool failed: ${payload.error ?? 'Unknown error'}${typeof guidance === 'string' ? `\nModel guidance: ${guidance}` : ''}`;
  }
  if (payload.toolName === 'read_thread_history') {
    const result = recordObject(payload.result);
    if (typeof result.omitted === 'string') return JSON.stringify({ omitted: result.omitted });
    return JSON.stringify(projectThreadHistoryIo(payload.result));
  }
  if (isMultimodalToolResultEnvelope(payload.result)) return multimodalToolResultText(payload.result);
  try {
    return JSON.stringify(sanitizeMultimodalResultValue(payload.result ?? null));
  } catch {
    return String(payload.result);
  }
}

/** Converts a complete canonical record block into prompt turns, preserving result pairing within that block. */
export function canonicalBlockToPromptTurns(
  records: readonly CanonicalRecord[],
  thread: CanonicalProjectionContext | Pick<Thread, 'id' | 'parentThreadId'>,
): PromptTurn[] {
  const context: CanonicalProjectionContext = {
    threadId: 'id' in thread ? thread.id : thread.threadId,
    parentThreadId: thread.parentThreadId,
  };
  const recordIds = new Set(records.map((record) => record.id));
  const results = new Map<string, ToolResultPayload>();
  for (const record of records) {
    if (record.kind !== 'tool_result') continue;
    const result = record.payload as unknown as ToolResultPayload;
    results.set(`${result.batchId}:${result.toolCallId}`, result);
  }
  const consumedResults = new Set<string>();
  const turns: PromptTurn[] = [];
  for (const record of records) {
    if (record.kind === 'message') {
      const message = record.payload as unknown as MessagePayload;
      if (message.role === 'user' && typeof message.content === 'string') {
        turns.push({ kind: 'message', role: 'user', content: messageContent(message, context) });
      }
    } else if (record.kind === 'assistant') {
      const assistant = record.payload as unknown as AssistantPayload;
      const assistantReasoning = reasoningContent(assistant);
      const replaySource = {
        model: assistant.model,
        ...(assistant.provider ? { provider: assistant.provider } : {}),
        ...(assistant.modelId ? { modelId: assistant.modelId } : {}),
        ...(assistant.adapterId ? { adapterId: assistant.adapterId } : {}),
      };
      if (assistant.toolCalls.length > 0) {
        turns.push({
          kind: 'assistant_tools',
          content: assistant.content,
          calls: assistant.toolCalls,
          ...(typeof assistantReasoning === 'string' ? { reasoningContent: assistantReasoning } : {}),
          ...(assistant.reasoningReplay === undefined ? {} : { reasoningReplay: assistant.reasoningReplay }),
          ...(assistant.reasoningReplay !== undefined || typeof assistantReasoning === 'string' ? { reasoningReplaySource: replaySource } : {}),
        });
        for (const call of assistant.toolCalls) {
          const result = assistant.batchId ? results.get(`${assistant.batchId}:${call.id}`) : undefined;
          if (!result) continue;
          const resultRecordId = `${result.executionId}:result`;
          if (recordIds.has(resultRecordId)) consumedResults.add(resultRecordId);
          turns.push({
            kind: 'tool_result',
            callId: call.id,
            toolName: call.name,
            ...(assistant.batchId ? { batchId: assistant.batchId } : {}),
            content: toolResultContent(result),
          });
        }
      } else if (
        assistant.content ||
        typeof assistantReasoning === 'string' ||
        assistant.reasoningReplay !== undefined
      ) {
        turns.push({
          kind: 'message',
          role: 'assistant',
          content: assistant.content,
          ...(typeof assistantReasoning === 'string' ? { reasoningContent: assistantReasoning } : {}),
          ...(assistant.reasoningReplay === undefined ? {} : { reasoningReplay: assistant.reasoningReplay }),
          ...(assistant.reasoningReplay !== undefined || typeof assistantReasoning === 'string' ? { reasoningReplaySource: replaySource } : {}),
        });
      }
    } else if (record.kind === 'tool_result' && !consumedResults.has(record.id)) {
      const result = record.payload as unknown as ToolResultPayload;
      turns.push({
        kind: 'tool_result',
        callId: result.toolCallId,
        toolName: result.toolName,
        batchId: result.batchId,
        content: toolResultContent(result),
      });
    }
  }
  return turns;
}

export function canonicalRecordsToPromptTurns(
  records: readonly CanonicalRecord[],
  thread: CanonicalProjectionContext | Pick<Thread, 'id' | 'parentThreadId'>,
): PromptTurn[] {
  return canonicalBlockToPromptTurns(
    records.filter((record) => record.kind !== 'plugin'),
    thread,
  );
}

export type CanonicalPromptTurn = PromptTurn;
