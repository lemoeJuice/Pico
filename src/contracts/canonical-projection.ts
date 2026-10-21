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
  sourceRecordIds: string[];
  sourceHash: string;
  summary: string;
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

export function canonicalConversationRecords(records: readonly CanonicalRecord[]): CanonicalRecord[] {
  return records.filter((record) => record.kind !== 'plugin');
}

/** Reads the latest valid Runtime-owned compaction fact without changing Canonical History. */
export function runtimeContextCompaction(records: readonly CanonicalRecord[]): RuntimeContextCompaction | null {
  const conversation = canonicalConversationRecords(records);
  const byId = new Set(conversation.map((record) => record.id));
  for (const record of [...records].reverse()) {
    if (record.kind !== 'plugin') continue;
    const payload = recordObject(record.payload);
    const sourceIds = payload.sourceRecordIds;
    if (
      payload.pluginId !== 'pico.runtime' ||
      payload.action !== 'context-compacted' ||
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
    return {
      version: 1,
      throughSeq,
      sourceRecordIds: [...sourceIds],
      sourceHash: payload.sourceHash,
      summary: payload.summary,
    };
  }
  return null;
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
      if (assistant.toolCalls.length > 0) {
        turns.push({
          kind: 'assistant_tools',
          content: assistant.content,
          calls: assistant.toolCalls,
          ...(typeof assistantReasoning === 'string' ? { reasoningContent: assistantReasoning } : {}),
          ...(assistant.reasoningReplay === undefined ? {} : { reasoningReplay: assistant.reasoningReplay }),
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
