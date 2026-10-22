import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { DEFAULT_THREAD_TITLE } from '../core/types.js';
import type {
  AssistantPayload,
  CanonicalRecord,
  ContextManagementSettings,
  Execution,
  ExecutionStatus,
  ExecutorBinding,
  MessagePayload,
  MiscellaneousSettings,
  ModelSettings,
  Project,
  PublicSettings,
  RemoteExecutorConnectionView,
  Thread,
  ThreadModelSelection,
  ThreadState,
  TokenUsage,
  ToolCall,
  ToolDefinition,
  ToolResultPayload,
} from '../core/types.js';
import { PicoStore } from '../core/store.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import {
  isMultimodalToolResultEnvelope,
  redactMultimodalToolResult,
  sanitizeMultimodalResultValue,
} from '../contracts/multimodal.js';
import type {
  ModelInputAttempt,
  ModelInputPromptSnapshot,
  ModelInputResultSummary,
  ModelPromptDiagnostics,
  ContextUsageEstimate,
  ProviderRequestAttempt,
  SubmitResult,
  ThreadSnapshot,
  ThreadToolView,
} from '../contracts/runtime.js';
import { ExecutionPipelines } from '../core/pipeline.js';
import { ContainerExecutor } from '../executor/container-executor.js';
import { HostExecutor, requiresExternalExecutor, type ExecutorAdapter } from '../executor/executor.js';
import { RemoteHostExecutor, inspectRemoteExecutor, validateRemoteWorkspace } from '../executor/remote-executor.js';
import { EXECUTOR_PROTOCOL_VERSION, normalizeRemoteExecutorUrl } from '../executor/remote-protocol.js';
import { currentExecutorBundle, currentExecutorVersion } from '../executor/bundle.js';
import { compareExecutorVersions } from '../executor/version.js';
import { ToolCatalog, type RuntimeToolContext } from '../executor/tool-catalog.js';
import { builtinExecutorToolDefinitions } from '../contracts/executor-tool-definitions.js';
import { ModelCallError, sanitizeModelCallError } from '../contracts/model-error.js';
import { builtinPlugins } from '../plugins/builtin.js';
import { CommandRegistry, PluginHost, type CommandResult, type PluginCatalogEntry } from '../plugins/host.js';
import type { PluginServices } from '../plugins/services.js';
import { OpenAiCompatibleAdapter, type ModelAdapter } from './model.js';
import { ModelProviderRegistry } from './provider-registry.js';
import type {
  ModelPrompt,
  ModelRequestParameters,
  ModelRequestTrace,
  ModelResponse,
  ModelStreamEvent,
  PromptTurn,
  ProviderRequestOutcome,
  ProviderRequestResponse,
  ProviderRequestStart,
  ProviderRequestSummary,
} from '../contracts/model.js';
import type {
  ModelStageInput,
  ProjectionInput,
  ProjectionProvenance,
  ToolBatchInput,
  ToolInvocationInput,
} from './stages.js';
import type { PicoPlugin } from '../plugins/host.js';
import {
  canonicalBlockToPromptTurns,
  canonicalConversationRecords,
  canonicalRecordsToPromptTurns,
  completedCanonicalModelInvocationBlocks,
  runtimeCompactionTurn,
  runtimeContextCompaction,
} from '../contracts/canonical-projection.js';

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

interface StoredThreadToolSurface {
  tools: ToolDefinition[];
  sources: Record<string, 'runtime' | 'executor'>;
}

interface PluginModelCallRequest {
  threadId?: string;
  projectId?: string;
  purpose: string;
  idempotencyKey: string;
  prompt: ModelPrompt;
  signal?: AbortSignal;
  modelTarget?: { provider: string; connectionId?: string; model?: string };
  requestParameters?: ModelRequestParameters;
  onEvent?: (event: ModelStreamEvent) => void;
}

interface PreparedPluginModelCall {
  effectiveSelection: ThreadModelSelection;
  settings: ModelSettings;
  prompt: ModelPrompt;
  requestFingerprint: string;
}

const THREAD_TOOL_SURFACES_SETTING = 'thread-tool-surfaces';
const DISABLED_THREAD_TOOLS_SETTING = 'disabled-thread-tools';
const RUNTIME_COMPACTION_MIN_RECENT_TURNS = 2;
const RUNTIME_COMPACTION_MAX_SUMMARY_CHARS = 12_000;
const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS: ContextManagementSettings = {
  contextWindowTokens: 272_000,
  compactionThresholdTokens: 256_000,
  keepRecentTokens: 16_000,
};
const DEFAULT_MISCELLANEOUS_SETTINGS: MiscellaneousSettings = {
  toolCardsExpandedByDefault: false,
};

function compactionBlockTokenEstimate(
  block: readonly CanonicalRecord[],
  previousBlock: readonly CanonicalRecord[] | undefined,
  thread: Thread,
  limit: number,
): number {
  const assistant = [...block].reverse().find((record) => record.kind === 'assistant');
  const previousAssistant = previousBlock
    ? [...previousBlock].reverse().find((record) => record.kind === 'assistant')
    : undefined;
  const payload = assistant ? objectValue(assistant.payload) : null;
  const previousPayload = previousAssistant ? objectValue(previousAssistant.payload) : null;
  const usage = diagnosticUsage(payload?.usage);
  const previousUsage = diagnosticUsage(previousPayload?.usage);
  // The invocation's provider usage is recorded before its tool results are
  // appended, so also account for the complete unit's retained content.
  const contentEstimate = estimatePromptCharacters(canonicalBlockToPromptTurns(block, thread), limit);
  const sameModel =
    typeof payload?.model === 'string' &&
    typeof previousPayload?.model === 'string' &&
    payload.model === previousPayload.model;
  const providersCompatible =
    typeof payload?.provider !== 'string' ||
    typeof previousPayload?.provider !== 'string' ||
    payload.provider === previousPayload.provider;
  if (
    sameModel &&
    providersCompatible &&
    usage?.inputTokens !== undefined &&
    previousUsage?.inputTokens !== undefined
  ) {
    const delta = usage.inputTokens - previousUsage.inputTokens;
    if (delta > 0) return Math.min(limit, Math.max(delta, contentEstimate));
  }

  // Pico has no universal tokenizer. Character count deliberately errs on the
  // side of retaining more history when comparable provider usage is absent.
  return Math.max(1, contentEstimate);
}

function canonicalSourceHash(records: readonly CanonicalRecord[]): string {
  return createHash('sha256')
    .update(JSON.stringify(records.map(({ id, seq, kind, payload }) => ({ id, seq, kind, payload }))))
    .digest('hex');
}

function activeRuntimeContextCompaction(records: readonly CanonicalRecord[]) {
  let resetIndex = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind !== 'plugin') continue;
    const payload = objectValue(record.payload);
    if (isRuntimeContextCompactionReset(payload)) {
      resetIndex = index;
      break;
    }
  }
  if (resetIndex < 0) return runtimeContextCompaction(records);
  return runtimeContextCompaction(records.filter((record, index) => record.kind !== 'plugin' || index > resetIndex));
}

function isRuntimeContextCompactionReset(payload: Record<string, unknown> | null): boolean {
  return Boolean(
    payload?.pluginId === 'pico.runtime' &&
    payload.action === 'context-compaction-reset' &&
    payload.version === 1 &&
    Number.isSafeInteger(payload.resetThroughSeq) &&
    (payload.resetThroughSeq as number) >= 0 &&
    typeof payload.resetSourceHash === 'string' &&
    /^[a-f0-9]{64}$/i.test(payload.resetSourceHash),
  );
}

function latestRuntimeContextProjectionSeq(records: readonly CanonicalRecord[]): number | null {
  const active = activeRuntimeContextCompaction(records);
  if (active) {
    const marker = [...records].reverse().find((record) => {
      if (record.kind !== 'plugin') return false;
      const payload = objectValue(record.payload);
      return (
        payload?.pluginId === 'pico.runtime' &&
        payload.action === 'context-compacted' &&
        payload.throughSeq === active.throughSeq &&
        payload.sourceHash === active.sourceHash
      );
    });
    if (marker) return marker.seq;
  }

  for (const record of [...records].reverse()) {
    if (record.kind !== 'plugin') continue;
    const payload = objectValue(record.payload);
    if (isRuntimeContextCompactionReset(payload)) return record.seq;
  }
  return null;
}

interface ProjectedCompactionPrefix {
  throughSeq: number;
  turns: PromptTurn[];
}

function projectedCompactionPrefix(
  records: readonly CanonicalRecord[],
  thread: Thread,
  projection: ProjectionInput,
  candidateThroughSeq: number,
): ProjectedCompactionPrefix | null {
  const provenance = projection.provenance ?? [];
  const hasRollingProjection = provenance.some(
    (item) => item.sourcePluginId === 'pico.rolling-context' && item.kind === 'rolling_segment',
  );
  let throughSeq = 0;
  let turnLimit = 0;

  if (hasRollingProjection) {
    const rollingSources = provenance.filter(
      (item) =>
        item.sourcePluginId === 'pico.rolling-context' &&
        Number.isSafeInteger(item.canonicalStartSeq) &&
        Number.isSafeInteger(item.canonicalEndSeq) &&
        (item.canonicalStartSeq as number) > 0 &&
        (item.canonicalEndSeq as number) >= (item.canonicalStartSeq as number),
    );
    const rollingByStartSeq = new Map(rollingSources.map((item) => [item.canonicalStartSeq!, item]));
    const runtimeCompaction = activeRuntimeContextCompaction(records);
    if (runtimeCompaction && runtimeCompaction.throughSeq <= candidateThroughSeq) {
      turnLimit = 1;
      throughSeq = runtimeCompaction.throughSeq;
    }
    for (const record of canonicalConversationRecords(records)) {
      if (record.seq <= throughSeq) continue;
      if (record.seq > candidateThroughSeq) break;

      const projectedSource = rollingByStartSeq.get(record.seq);
      if (projectedSource) {
        const endSeq = projectedSource.canonicalEndSeq!;
        if (endSeq > candidateThroughSeq) break;
        const sourceRecords = canonicalConversationRecords(records).filter(
          (item) => item.seq >= record.seq && item.seq <= endSeq,
        );
        if (projectedSource.disposition === 'summary') turnLimit += 1;
        else if (projectedSource.disposition === 'raw') {
          turnLimit += canonicalBlockToPromptTurns(sourceRecords, thread).length;
        }
        throughSeq = endSeq;
        continue;
      }

      // Rolling Context can pass through records individually when an active
      // Runtime summary ends inside one of its user-turn blocks; those turns
      // remain in the same order in the final projection.
      turnLimit += canonicalBlockToPromptTurns([record], thread).length;
      throughSeq = record.seq;
    }
  } else {
    const runtimeCompaction = activeRuntimeContextCompaction(records);
    const compactedPrefixTurns = runtimeCompaction && runtimeCompaction.throughSeq <= candidateThroughSeq ? 1 : 0;
    const rawPrefix = canonicalConversationRecords(records).filter(
      (record) =>
        record.seq <= candidateThroughSeq && (!runtimeCompaction || record.seq > runtimeCompaction.throughSeq),
    );
    turnLimit = compactedPrefixTurns + canonicalRecordsToPromptTurns(rawPrefix, thread).length;
    throughSeq = candidateThroughSeq;
  }

  if (throughSeq <= 0 || turnLimit <= 0 || turnLimit > projection.turns.length) return null;
  const pluginTurnIndexes = new Set(
    provenance
      .filter(
        (item) => item.kind === 'plugin' && Number.isSafeInteger(item.turnIndex) && (item.turnIndex as number) >= 0,
      )
      .map((item) => item.turnIndex as number),
  );
  return {
    throughSeq,
    turns: projection.turns.slice(0, turnLimit).filter((_turn, index) => !pluginTurnIndexes.has(index)),
  };
}

function validateModelParameters(value: unknown): ModelRequestParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Model parameters must be an object.');
  }
  const parameters = value as { temperature?: unknown; fields?: unknown };
  if (!parameters.fields || typeof parameters.fields !== 'object' || Array.isArray(parameters.fields)) {
    throw new Error('Model parameters must contain a fields object.');
  }
  if (
    parameters.temperature !== undefined &&
    parameters.temperature !== null &&
    (typeof parameters.temperature !== 'number' ||
      !Number.isFinite(parameters.temperature) ||
      parameters.temperature < 0 ||
      parameters.temperature > 2)
  ) {
    throw new Error('Temperature must be between 0 and 2.');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(parameters.fields);
  } catch {
    throw new Error('Model parameters must be JSON values.');
  }
  if (
    serialized === undefined ||
    /"(?:api.?key|authorization|access.?token|refresh.?token|secret|password)"\s*:/i.test(serialized)
  ) {
    throw new Error('Model parameters must be non-sensitive JSON values.');
  }
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new Error('Model parameters must be JSON values.');
  }
  return {
    ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature as number | null }),
    fields,
  };
}

function validateThreadSelectionParameters(value: unknown): ThreadModelSelection['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Thread model parameters must be an object.');
  const source = value as { temperature?: unknown; options?: unknown };
  if (
    source.temperature !== undefined &&
    source.temperature !== null &&
    (typeof source.temperature !== 'number' ||
      !Number.isFinite(source.temperature) ||
      source.temperature < 0 ||
      source.temperature > 2)
  ) {
    throw new Error('Temperature must be between 0 and 2.');
  }
  if (!source.options || typeof source.options !== 'object' || Array.isArray(source.options)) {
    throw new Error('Thread model parameters must contain an options object.');
  }
  const json = JSON.stringify(source.options);
  if (!json || /"(?:api.?key|authorization|access.?token|refresh.?token|secret|password)"\s*:/i.test(json)) {
    throw new Error('Thread model options must be non-sensitive JSON values.');
  }
  const options = JSON.parse(json) as Record<string, unknown>;
  if (Object.values(options).some((item) => !['string', 'number', 'boolean'].includes(typeof item))) {
    throw new Error('Thread model options must contain only scalar values.');
  }
  return {
    ...(source.temperature === undefined ? {} : { temperature: source.temperature as number | null }),
    options: options as ThreadModelSelection['parameters']['options'],
  };
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function modelCallRequestFingerprint(identity: unknown): string {
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}

export const THREAD_HISTORY_PAGE_SIZE = 100;

function redactPublicValue(value: unknown): unknown {
  if (isMultimodalToolResultEnvelope(value)) return redactMultimodalToolResult(value);
  if (Array.isArray(value)) return value.map(redactPublicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPublicValue(child)]));
  }
  return value;
}

function redactReasoningReplay<T>(record: CanonicalRecord<T>): CanonicalRecord<T> {
  const safePayload = redactPublicValue(record.payload) as T;
  if (record.kind !== 'assistant') return safePayload === record.payload ? record : { ...record, payload: safePayload };
  const payload = safePayload;
  if (!payload || typeof payload !== 'object' || !('reasoningReplay' in payload)) return { ...record, payload };
  const { reasoningReplay: _reasoningReplay, ...publicPayload } = payload as Record<string, unknown>;
  return { ...record, payload: publicPayload as T };
}

function redactExecutionImages(execution: Execution): Execution {
  const safe = redactPublicValue(execution) as Execution;
  return safe === execution ? execution : safe;
}

function promptForDiagnostics(prompt: ModelPrompt): ModelPrompt {
  return {
    ...prompt,
    turns: prompt.turns.map((turn): PromptTurn => {
      if (turn.kind === 'tool_result') {
        if (!turn.images?.length) return turn;
        return {
          ...turn,
          images: turn.images.map((image) => ({
            mimeType: image.mimeType,
            ...(image.name ? { name: image.name } : {}),
            byteLength:
              Math.floor((image.data.length * 3) / 4) -
              (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
          })),
        } as unknown as PromptTurn;
      }
      const { reasoningReplay: _reasoningReplay, ...diagnosticTurn } = turn;
      return diagnosticTurn;
    }),
  };
}

function modelInputPromptSnapshotForDiagnostics(prompt: ModelPrompt): ModelInputPromptSnapshot {
  const turns = prompt.turns.map((turn) => {
    if (turn.kind === 'tool_result') {
      return {
        ...turn,
        ...(turn.images?.length
          ? {
              images: turn.images.map((image) => ({
                mimeType: image.mimeType,
                ...(image.name ? { name: image.name } : {}),
                byteLength:
                  Math.floor((image.data.length * 3) / 4) -
                  (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
              })),
            }
          : {}),
      };
    }
    const { reasoningReplay: _reasoningReplay, ...textTurn } = turn;
    return textTurn;
  }) as unknown as ModelInputPromptSnapshot['turns'];
  return {
    version: 1,
    system: prompt.system,
    turns,
    tools: prompt.tools,
    model: prompt.model,
    temperature: prompt.temperature,
  };
}

function modelInputPromptSnapshotFrom(value: unknown): ModelInputPromptSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ModelInputPromptSnapshot> & Partial<ModelPrompt>;
  if (
    typeof candidate.system !== 'string' ||
    !Array.isArray(candidate.turns) ||
    !Array.isArray(candidate.tools) ||
    typeof candidate.model !== 'string' ||
    typeof candidate.temperature !== 'number'
  ) {
    return undefined;
  }
  try {
    if (candidate.version === 1) {
      const validTurns = candidate.turns.every(
        (turn) =>
          Boolean(turn) &&
          typeof turn === 'object' &&
          (turn.kind === 'message' || turn.kind === 'assistant_tools' || turn.kind === 'tool_result') &&
          typeof turn.content === 'string',
      );
      return validTurns ? (structuredClone(candidate) as ModelInputPromptSnapshot) : undefined;
    }
    return modelInputPromptSnapshotForDiagnostics(candidate as ModelPrompt);
  } catch {
    return undefined;
  }
}

function promptSummaryForDiagnostics(prompt: ModelPrompt): ModelPromptDiagnostics {
  const toolsJson = stableJson(prompt.tools);
  return {
    version: 1,
    model: prompt.model,
    temperature: prompt.temperature,
    systemCharacters: prompt.system.length,
    systemFingerprint: createHash('sha256').update(prompt.system).digest('hex'),
    turns: prompt.turns.map((turn) => {
      const summary: ModelPromptDiagnostics['turns'][number] = {
        kind: turn.kind,
        characters: turn.content.length,
      };
      if (turn.kind === 'message') summary.role = turn.role;
      if (turn.kind === 'assistant_tools') summary.toolCallCount = turn.calls.length;
      if (turn.kind === 'tool_result' && turn.images?.length) {
        summary.imageCount = turn.images.length;
        summary.imageBytes = turn.images.reduce(
          (total, image) =>
            total +
            Math.floor((image.data.length * 3) / 4) -
            (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
          0,
        );
      }
      return summary;
    }),
    toolCount: prompt.tools.length,
    toolNames: prompt.tools.map((tool) => tool.name),
    toolDefinitionCharacters: toolsJson.length,
    toolsFingerprint: createHash('sha256').update(toolsJson).digest('hex'),
  };
}

function modelPromptDiagnosticsFrom(value: unknown): ModelPromptDiagnostics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ModelPromptDiagnostics> & Partial<ModelPrompt>;
  if (
    typeof candidate.system === 'string' &&
    Array.isArray(candidate.turns) &&
    Array.isArray(candidate.tools) &&
    typeof candidate.model === 'string' &&
    typeof candidate.temperature === 'number'
  ) {
    try {
      return promptSummaryForDiagnostics(candidate as ModelPrompt);
    } catch {
      return null;
    }
  }
  if (
    candidate.version !== 1 ||
    typeof candidate.model !== 'string' ||
    typeof candidate.temperature !== 'number' ||
    typeof candidate.systemCharacters !== 'number' ||
    typeof candidate.systemFingerprint !== 'string' ||
    !Array.isArray(candidate.turns) ||
    typeof candidate.toolCount !== 'number' ||
    !Array.isArray(candidate.toolNames) ||
    typeof candidate.toolDefinitionCharacters !== 'number' ||
    typeof candidate.toolsFingerprint !== 'string'
  ) {
    return null;
  }
  const safeCount = (number: number): number =>
    Number.isFinite(number) ? Math.max(0, Math.min(Math.floor(number), 1_000_000_000)) : 0;
  const safeFingerprint = (fingerprint: string): string =>
    /^[a-f0-9]{64}$/i.test(fingerprint) ? fingerprint.toLowerCase() : 'unknown';
  const turns: ModelPromptDiagnostics['turns'] = [];
  for (const rawTurn of candidate.turns.slice(0, 10_000)) {
    if (!rawTurn || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) continue;
    const turn = rawTurn as Record<string, unknown>;
    if (turn.kind !== 'message' && turn.kind !== 'assistant_tools' && turn.kind !== 'tool_result') continue;
    const summary: ModelPromptDiagnostics['turns'][number] = {
      kind: turn.kind,
      characters: safeCount(typeof turn.characters === 'number' ? turn.characters : 0),
    };
    if (turn.kind === 'message' && (turn.role === 'user' || turn.role === 'assistant')) summary.role = turn.role;
    if (turn.kind === 'assistant_tools') {
      summary.toolCallCount = safeCount(typeof turn.toolCallCount === 'number' ? turn.toolCallCount : 0);
    }
    if (turn.kind === 'tool_result') {
      if (typeof turn.imageCount === 'number') summary.imageCount = safeCount(turn.imageCount);
      if (typeof turn.imageBytes === 'number') summary.imageBytes = safeCount(turn.imageBytes);
    }
    turns.push(summary);
  }
  return {
    version: 1,
    model: diagnosticText(candidate.model, 160) ?? 'unknown',
    temperature: Number.isFinite(candidate.temperature) ? candidate.temperature : 0,
    systemCharacters: safeCount(candidate.systemCharacters),
    systemFingerprint: safeFingerprint(candidate.systemFingerprint),
    turns,
    toolCount: safeCount(candidate.toolCount),
    toolNames: candidate.toolNames
      .filter((name): name is string => typeof name === 'string')
      .slice(0, 2_000)
      .map((name) => diagnosticText(name, 120) ?? 'unknown'),
    toolDefinitionCharacters: safeCount(candidate.toolDefinitionCharacters),
    toolsFingerprint: safeFingerprint(candidate.toolsFingerprint),
  };
}

function commandResultFromRecord(
  record: CanonicalRecord | null,
  threadId: string,
  requestHash: string,
  commandHash: string,
): CommandResult | null {
  if (
    !record ||
    record.threadId !== threadId ||
    record.kind !== 'plugin' ||
    record.payload.pluginId !== 'pico.commands' ||
    record.payload.action !== 'invocation-completed' ||
    record.payload.requestHash !== requestHash ||
    record.payload.commandHash !== commandHash
  ) {
    return null;
  }

  const result = record.payload.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  const command: CommandResult = {};
  if (typeof value.text === 'string') command.text = value.text;
  if (typeof value.openThreadId === 'string') command.openThreadId = value.openThreadId;
  if (value.severity === 'notice' || value.severity === 'error') command.severity = value.severity;
  if (value.presentation === 'timeline') command.presentation = value.presentation;
  return command;
}

export type {
  ModelInputAttempt,
  ModelInputResultSummary,
  ProviderRequestAttempt,
  SubmitResult,
  ThreadSnapshot,
  ThreadToolView,
} from '../contracts/runtime.js';

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function diagnosticText(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function diagnosticLabel(value: unknown, maxLength = 80): string | undefined {
  const label = diagnosticText(value, maxLength);
  return label && /^[a-z0-9_.:-]+$/i.test(label) ? label : undefined;
}

function diagnosticEndpoint(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown';
    const path = url.pathname
      .split('/')
      .map((segment) => (segment && !/^[a-z0-9._~-]{1,40}$/i.test(segment) ? ':redacted' : segment))
      .join('/');
    return `${url.origin}${path}`.slice(0, 256);
  } catch {
    return 'unknown';
  }
}

function diagnosticMime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime.slice(0, 128) : null;
}

function diagnosticCountMap(value: unknown): Record<string, number> | undefined {
  const entries = objectValue(value);
  if (!entries) return undefined;
  const result: Record<string, number> = {};
  for (const [rawKey, rawCount] of Object.entries(entries).slice(0, 32)) {
    const key = diagnosticText(rawKey, 80);
    if (!key || !/^[a-z0-9_.:-]+$/i.test(key)) continue;
    if (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount) || rawCount < 0) continue;
    result[key] = Math.min(rawCount, 1_000_000_000);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function diagnosticUsage(value: unknown): TokenUsage | null {
  const usage = objectValue(value);
  if (!usage) return null;
  const count = (key: string): number | undefined => {
    const raw = usage[key];
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? Math.min(raw, 1_000_000_000_000)
      : undefined;
  };
  const inputTokens = count('inputTokens');
  const outputTokens = count('outputTokens');
  const totalTokens = count('totalTokens');
  const cachedInputTokens = count('cachedInputTokens');
  const cacheWriteTokens = count('cacheWriteTokens');
  const reasoningTokens = count('reasoningTokens');
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheWriteTokens === undefined &&
    reasoningTokens === undefined
  )
    return null;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function estimatePromptCharacters(turns: readonly PromptTurn[], limit: number): number {
  const pending: unknown[] = [...turns];
  let characters = 0;
  while (pending.length > 0 && characters < limit) {
    const value = pending.pop();
    if (typeof value === 'string') {
      characters = Math.min(limit, characters + value.length);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      characters = Math.min(limit, characters + String(value).length);
    } else if (value === null) {
      characters = Math.min(limit, characters + 4);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        pending.push(entry);
      }
    } else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        characters = Math.min(limit, characters + key.length);
        pending.push((value as Record<string, unknown>)[key]);
        if (characters >= limit) break;
      }
    }
  }
  return characters;
}

function sanitizeRequestStart(details: ProviderRequestStart): ProviderRequestStart {
  const provider = diagnosticText(details.provider, 64);
  const protocol = diagnosticText(details.protocol, 64);
  return {
    provider: provider && /^[a-z0-9_.:-]+$/i.test(provider) ? provider : 'unknown',
    protocol: protocol && /^[a-z0-9_.:+-]+$/i.test(protocol) ? protocol : 'unknown',
    endpoint: diagnosticEndpoint(details.endpoint),
    attempt: Number.isSafeInteger(details.attempt) && details.attempt > 0 ? Math.min(details.attempt, 1000) : 1,
  };
}

function sanitizeRequestResponse(details: ProviderRequestResponse): ProviderRequestResponse {
  const providerRequestId = diagnosticText(details.providerRequestId, 128);
  return {
    status: Number.isInteger(details.status) && details.status >= 100 && details.status <= 599 ? details.status : 0,
    contentType: diagnosticMime(details.contentType),
    ...(providerRequestId && /^[a-z0-9_.:-]+$/i.test(providerRequestId) ? { providerRequestId } : {}),
  };
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
  'aborted',
  'auth',
  'empty_output',
  'empty_stream',
  'fetch_failed',
  'incomplete_function_call',
  'invalid_json',
  'invalid_stream',
  'missing_completion',
  'missing_function_name',
  'protocol',
  'response_failed',
  'transport',
]);

function safeProviderErrorCode(value: unknown): string | undefined {
  const label = diagnosticLabel(value, 80);
  if (!label) return undefined;
  if (/^http_[1-5][0-9]{2}$/i.test(label)) return label.toLowerCase();
  return SAFE_PROVIDER_ERROR_CODES.has(label) ? label : undefined;
}

function sanitizeRequestSummary(details: ProviderRequestSummary): ProviderRequestSummary {
  const durationMs =
    Number.isFinite(details.durationMs) && details.durationMs >= 0
      ? Math.min(Math.round(details.durationMs), 86_400_000)
      : 0;
  const terminalEvent = diagnosticLabel(details.terminalEvent, 80);
  const errorCode = safeProviderErrorCode(details.errorCode);
  const responseId = diagnosticLabel(details.responseId, 128);
  const finishReason = details.finishReason === null ? null : diagnosticLabel(details.finishReason, 80);
  const outcome: ProviderRequestOutcome =
    details.outcome === 'retrying' ||
    details.outcome === 'completed' ||
    details.outcome === 'interrupted' ||
    details.outcome === 'failed'
      ? details.outcome
      : 'failed';
  const errorCategory =
    details.errorCategory === 'http' ||
    details.errorCategory === 'transport' ||
    details.errorCategory === 'protocol' ||
    details.errorCategory === 'aborted'
      ? details.errorCategory
      : undefined;
  const firstTextMs =
    Number.isFinite(details.firstTextMs) && details.firstTextMs! >= 0
      ? Math.min(Math.round(details.firstTextMs!), durationMs)
      : undefined;
  const eventCounts = diagnosticCountMap(details.eventCounts);
  const outputItemCounts = diagnosticCountMap(details.outputItemCounts);
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : undefined;
  const deltaTextCharacters = count(details.deltaTextCharacters);
  const outputTextCharacters = count(details.outputTextCharacters);
  const toolCallCount = count(details.toolCallCount);
  return {
    outcome,
    durationMs,
    ...(terminalEvent ? { terminalEvent } : {}),
    ...(errorCategory ? { errorCategory } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(eventCounts ? { eventCounts } : {}),
    ...(firstTextMs === undefined ? {} : { firstTextMs }),
    ...(deltaTextCharacters === undefined ? {} : { deltaTextCharacters }),
    ...(outputTextCharacters === undefined ? {} : { outputTextCharacters }),
    ...(outputItemCounts ? { outputItemCounts } : {}),
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(responseId ? { responseId } : {}),
    ...(details.usage === undefined ? {} : { usage: diagnosticUsage(details.usage) }),
  };
}

function safeModelError(error: unknown, interrupted = false): string {
  if (interrupted) return 'Model request failed (AbortError).';
  if (error instanceof ModelCallError) return error.message;
  return 'Model request failed (provider_error).';
}

function safeStoredModelError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const safeSummary = /^Model request failed \(([a-z0-9_.:-]{1,80})\)\.$/i.exec(value)?.[1];
  if (safeSummary && ['AbortError', 'provider_error', 'UnknownError'].includes(safeSummary)) {
    return `Model request failed (${safeSummary}).`;
  }
  const safeHttpSummary = /^http_([1-5][0-9]{2})$/i.exec(safeSummary ?? '')?.[1];
  if (safeHttpSummary) return `Model request failed (http_${safeHttpSummary}).`;
  const httpStatus = /\bHTTP ([1-5][0-9]{2})\b/i.exec(value)?.[1];
  return httpStatus ? `Model request failed (http_${httpStatus}).` : 'Model request failed (previous detail redacted).';
}

const defaultModelSettings: ModelSettings = {
  baseUrl: process.env.PICO_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.PICO_MODEL_API_KEY ?? '',
  model: process.env.PICO_MODEL ?? '',
  temperature: 0.2,
  provider: 'openai-compatible',
};

const baseSystemPrompt = `You are Pico, an agent working in one durable Thread. Use the available tools when they help you inspect or change the selected workspace.\n\nTools in one model step may run concurrently. Their results arrive together before the next step. A tool result marked interrupted means its real-world side effects may be partial or unknown: inspect the environment before deciding whether to retry.\n\nA Thread stays bound to its displayed Executor for its lifetime.\n\nNew user messages can arrive while you work. They will appear at the next model step; finish the current tool batch first.`;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function terminalStatus(status: ExecutionStatus): status is 'completed' | 'failed' | 'interrupted' {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  // The abort race may settle before a provider unwinds; keep its later rejection observed.
  void promise.catch(() => undefined);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}

function modelExecutionProjectionThrough(execution: Execution): number | null {
  const value = execution.arguments?.projectionThrough;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export interface RuntimeOptions {
  model?: ModelAdapter;
  plugins?: PicoPlugin[];
  pluginDirectory?: string;
  executorPluginDirectory?: string;
  disabledBuiltinPlugins?: string[];
}

export class PicoRuntime {
  readonly store: PicoStore;
  readonly tools = new ToolCatalog();
  readonly pipelines = new ExecutionPipelines();
  readonly commands = new CommandRegistry();
  readonly plugins: PluginHost;
  private readonly model: ModelAdapter;
  private readonly modelProviderRegistry = new ModelProviderRegistry();
  private readonly additionalPlugins: PicoPlugin[];
  private readonly hostExecutor: HostExecutor;
  private readonly containerExecutor: ContainerExecutor;
  private readonly remoteHostExecutor: RemoteHostExecutor;
  private readonly options: RuntimeOptions;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly executionListeners = new Set<(execution: Execution) => void>();
  private storeUnsubscribers: Array<() => void> = [];
  private readonly loops = new Map<string, Promise<void>>();
  private readonly inFlightThreadOperations = new Map<string, number>();
  private readonly modelSignals = new Map<string, AbortController>();
  private readonly pluginModelCallsInFlight = new Map<
    string,
    { requestFingerprint: string; promise: Promise<PluginModelCallRecord & { response: ModelResponse }> }
  >();
  private readonly pluginModelCallControllers = new Set<AbortController>();
  private readonly runtimeToolRuns = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private readonly invocationRuns = new Map<
    string,
    { promise: Promise<Execution>; controller: AbortController; toolStarted: boolean }
  >();
  private pluginLoadErrors: string[] = [];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(store = new PicoStore(), options: RuntimeOptions = {}) {
    this.store = store;
    this.options = options;
    this.model = options.model ?? new OpenAiCompatibleAdapter();
    this.commands.register('pico.runtime', {
      name: 'compact',
      description: 'Summarize older completed turns while preserving Canonical History and recent context.',
      execute: (_args, commandContext) => this.compactThread(commandContext.thread),
    });
    this.modelProviderRegistry.register(
      'pico.core',
      { id: 'openai-compatible', label: 'OpenAI-compatible API key', supportsImages: true },
      (input, settings) =>
        this.model.complete(
          input.prompt,
          settings,
          input.signal,
          input.onText,
          input.requestTrace,
          input.onEvent,
          input.requestParameters,
        ),
    );
    this.additionalPlugins = [...(options.plugins ?? [])];
    this.hostExecutor = new HostExecutor(
      store,
      (execution) => this.executionChanged(execution),
      options.executorPluginDirectory,
    );
    this.containerExecutor = new ContainerExecutor(
      store,
      (execution) => this.executionChanged(execution),
      undefined,
      undefined,
      undefined,
      undefined,
      options.executorPluginDirectory,
    );
    this.remoteHostExecutor = new RemoteHostExecutor(store, (execution) => this.executionChanged(execution));
    const services: PluginServices = {
      projects: { list: () => this.listProjects() },
      threads: {
        get: (threadId) => this.store.getThread(threadId),
        modelSelection: (threadId) => this.threadModelSelection(threadId),
        validateModelSelection: (selection) => this.validateThreadModelSelection(selection),
        updateModelSelection: (threadId, selection) => this.updateThreadModelSelection(threadId, selection),
        list: (projectId) => this.listThreads(projectId),
        updateTitle: (pluginId, threadId, title) => this.updateThreadTitleFromPlugin(pluginId, threadId, title),
        tools: async (threadId) => {
          const thread = this.store.getThread(threadId);
          if (!thread) throw new Error('Thread not found');
          const surface = await this.toolSurfaceFor(thread);
          return surface.tools.map((definition) => ({
            ...definition,
            source: (surface.sources[definition.name] ?? 'runtime') as 'runtime' | 'executor',
          }));
        },
        binding: (threadId) => this.store.executorForThread(threadId),
        create: (projectId, executorKind, title, options = {}) => {
          if (options.parentThreadId) {
            const parent = this.requireUnarchivedThread(options.parentThreadId);
            if (parent.projectId !== projectId) throw new Error('Parent Thread must belong to the same Project');
          }
          const modelSelection =
            options.modelSelection ??
            (options.parentThreadId
              ? this.threadModelSelection(options.parentThreadId)
              : this.defaultThreadModelSelection());
          const thread = this.store.createThread(projectId, executorKind, title, { ...options, modelSelection });
          this.publish({ type: 'thread.created', thread });
          return thread;
        },
        send: (senderThreadId, targetId, content, messageId) => {
          const sender = this.requireUnarchivedThread(senderThreadId);
          const target = this.requireUnarchivedThread(targetId);
          if (sender.projectId !== target.projectId) {
            throw new Error('Target Thread must belong to the same Project');
          }
          if (sender.id === target.id) throw new Error('Cannot send a message to the current Thread');
          const payload: MessagePayload = {
            role: 'user',
            content,
            source: sender.parentThreadId ? 'child' : 'agent',
            senderThreadId: sender.id,
            senderLabel: sender.title,
          };
          const result = this.postMessage(target, messageId, payload);
          return { delivered: result.inserted, threadId: target.id, messageId: result.record.id };
        },
        pause: (threadId, reason) => this.pauseForPlugin(threadId, reason),
        resume: (threadId) => this.resumeForPlugin(threadId),
      },
      executions: {
        get: (executionId) => this.store.getExecution(executionId),
        subscribe: (listener) => {
          this.executionListeners.add(listener);
          return () => this.executionListeners.delete(listener);
        },
      },
      models: {
        complete: (pluginId, request) => this.completePluginModelCall(pluginId, request),
        history: (filter = {}) => this.store.listPluginModelCalls(filter),
        subscribe: (listener) => this.store.subscribePluginModelCalls(listener),
      },
      continuations: {
        register: (pluginId, hasPendingWork) =>
          this.plugins?.registerContinuation(pluginId, hasPendingWork) ?? (() => undefined),
        hasPendingWork: (threadId) => this.plugins?.hasPendingPluginWork(threadId) ?? false,
      },
    };
    this.plugins = new PluginHost(
      store,
      this.tools,
      this.pipelines,
      this.commands,
      options.pluginDirectory,
      services,
      {
        canReload: () => {
          const activeExecutions = store.listThreads().flatMap((thread) => store.listActiveExecutions(thread.id));
          if (activeExecutions.length > 0 || this.pluginModelCallsInFlight.size > 0) {
            return {
              allowed: false,
              reason:
                'Pause active Threads and wait for Model, Tool, and plugin model calls to settle before changing plugins.',
            };
          }
          return { allowed: true };
        },
        onChange: (pluginId) => this.publish({ type: 'plugin.updated', pluginId }),
      },
      this.modelProviderRegistry,
    );
  }

  async initialize(): Promise<void> {
    this.storeUnsubscribers.push(
      this.store.subscribePluginState((pluginId) => {
        this.publish({ type: 'plugin.updated', pluginId });
        for (const thread of this.store.listThreads()) {
          if (!thread.pauseRequested && this.plugins.hasPendingPluginWork(thread.id)) this.startLoop(thread.id);
        }
      }),
      this.store.subscribePluginModelCalls(() => this.publish({ type: 'models.updated' })),
      this.store.subscribeCanonical((record) => this.publishRecord(record)),
    );
    for (const call of this.store.listPluginModelCalls()) {
      if (call.status !== 'running') continue;
      this.store.savePluginModelCall({
        ...call,
        status: 'interrupted',
        error: 'Runtime restarted while the plugin model request was in progress; it was not repeated.',
        attempts: call.attempts.map((attempt) =>
          attempt.outcome === 'running' ? { ...attempt, outcome: 'interrupted', errorCategory: 'aborted' } : attempt,
        ),
        updatedAt: new Date().toISOString(),
      });
    }
    const disabled = new Set([
      ...(process.env.PICO_DISABLED_PLUGINS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      ...(this.options.disabledBuiltinPlugins ?? []).filter(
        (id) => !this.additionalPlugins.some((plugin) => plugin.id === id),
      ),
    ]);
    await this.plugins.load([...builtinPlugins, ...this.additionalPlugins], [...disabled]);
    this.pluginLoadErrors = [...this.plugins.errors()];
    // A Runtime restart confirms its own unfinished model stream was lost. Pause the
    // Thread before recording the interruption so startup recovery cannot silently
    // submit a replacement Model Execution. Tool state is left untouched until the
    // bound Executor can be queried.
    for (const thread of this.store.listThreads()) {
      const unfinishedModelExecutions = this.store
        .listActiveExecutions(thread.id)
        .filter((execution) => execution.kind === 'model');
      if (unfinishedModelExecutions.length > 0) {
        this.store.setPause(
          thread.id,
          true,
          'Model step interrupted by a Runtime restart. Continue this Thread to start a new attempt.',
        );
      }
      for (const execution of unfinishedModelExecutions) {
        const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
          error: 'Runtime restarted before this Model Step committed.',
          detail: { runtimeRestarted: true },
        });
        this.executionChanged(interrupted);
      }
    }
    // Re-enter durable work through the same loop and Executor submission paths.
    // A disconnected Executor may leave its execution running and pause the Thread;
    // a confirmed-lost Host execution becomes interrupted before the next Model Step.
    for (const thread of this.store.listThreads()) {
      if (!thread.pauseRequested || this.latestActiveBatch(thread.id)) this.startLoop(thread.id);
    }
  }

  async shutdownHostExecutor(): Promise<void> {
    await Promise.all([this.hostExecutor.shutdown(), this.remoteHostExecutor.shutdown()]);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    for (const controller of this.modelSignals.values()) controller.abort();
    for (const controller of this.pluginModelCallControllers) controller.abort();
    for (const active of this.runtimeToolRuns.values()) active.controller.abort();

    await Promise.all([
      this.hostExecutor.shutdown(),
      this.containerExecutor.shutdown(),
      this.remoteHostExecutor.shutdown(),
      Promise.allSettled([...this.runtimeToolRuns.values()].map((active) => active.promise)),
    ]);

    // A pending Tool may be waiting on a plugin workflow decision. Leave its loop
    // suspended so the durable pending fact can be resumed by a fresh Runtime.
    const pendingToolThreads = new Set(
      this.store
        .listThreads()
        .filter((thread) =>
          this.store
            .listActiveExecutions(thread.id)
            .some((execution) => execution.kind === 'tool' && execution.status === 'pending'),
        )
        .map((thread) => thread.id),
    );
    await Promise.allSettled(
      [...this.loops.entries()].filter(([threadId]) => !pendingToolThreads.has(threadId)).map(([, loop]) => loop),
    );
    await this.plugins.shutdown();
    for (const unsubscribe of this.storeUnsubscribers.splice(0)) unsubscribe();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private publishRecord<T>(record: CanonicalRecord<T>): void {
    if (record.threadId === null) return;
    this.publish({ type: 'record', record: redactReasoningReplay(record) });
  }

  private executionChanged(execution: Execution): void {
    this.publish({ type: 'execution.updated', execution: redactExecutionImages(execution) });
    this.publishThreadUpdate(execution.threadId);
    for (const listener of this.executionListeners) listener(execution);
  }

  private publishThreadUpdate(threadId: string): void {
    const thread = this.getThread(threadId);
    if (thread) this.publish({ type: 'thread.updated', thread });
  }

  createProject(name: string | undefined, workspacePath: string): Promise<Project> {
    return this.createProjectChecked(name, workspacePath);
  }

  private async createProjectChecked(name: string | undefined, workspacePath: string): Promise<Project> {
    const path = await realpath(resolve(workspacePath.trim()));
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('Workspace path must be a directory');
    const cleanedName = name?.trim() || basename(path) || 'Project';
    return this.store.createProject(cleanedName, path);
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createThread(projectId: string, executorKind: Thread['executorKind'], title = DEFAULT_THREAD_TITLE): Thread {
    const thread = this.store.createThread(projectId, executorKind, title.trim() || DEFAULT_THREAD_TITLE, {
      modelSelection: this.defaultThreadModelSelection(),
    });
    this.publish({ type: 'thread.created', thread });
    return thread;
  }

  updateThreadTitle(threadId: string, title: string): Thread {
    const cleanedTitle = title.trim();
    if (!cleanedTitle) throw new Error('Thread name is required.');
    let changed = false;
    const thread = this.store.transaction(() => {
      const previous = this.store.getThread(threadId);
      if (!previous) throw new Error('Thread not found');
      if (previous.title === cleanedTitle) return previous;
      const updated = this.store.updateThreadTitle(threadId, cleanedTitle);
      if (!updated) throw new Error('Thread not found');
      changed = true;
      this.store.appendPluginRecord(threadId, 'pico.core', {
        action: 'thread-title-updated',
        actor: 'user',
        previousTitle: previous.title,
        title: cleanedTitle,
      });
      return updated;
    });
    if (changed) this.publish({ type: 'thread.updated', thread });
    return thread;
  }

  private updateThreadTitleFromPlugin(pluginId: string, threadId: string, title: string): Thread {
    const cleanedTitle = title.trim().replace(/\s+/g, ' ').slice(0, 100).trim();
    if (!cleanedTitle) throw new Error('Thread name is required.');
    let changed = false;
    const thread = this.store.transaction(() => {
      const previous = this.store.getThread(threadId);
      if (!previous) throw new Error('Thread not found');
      if (previous.title === cleanedTitle) return previous;
      const updated = this.store.updateThreadTitle(threadId, cleanedTitle);
      if (!updated) throw new Error('Thread not found');
      changed = true;
      this.store.appendPluginRecord(threadId, pluginId, {
        action: 'thread-title-updated',
        previousTitle: previous.title,
        title: cleanedTitle,
      });
      return updated;
    });
    if (changed) this.publish({ type: 'thread.updated', thread });
    return thread;
  }

  async addRemoteExecutorConnection(
    name: string,
    endpointUrl: string,
    accessToken: string,
  ): Promise<RemoteExecutorConnectionView> {
    const cleanedName = name.trim();
    if (!cleanedName) throw new Error('Remote Executor name is required.');
    const normalizedUrl = normalizeRemoteExecutorUrl(endpointUrl);
    const info = await inspectRemoteExecutor(normalizedUrl, accessToken);
    return this.store.createRemoteExecutorConnection(cleanedName, normalizedUrl, accessToken, info.workspaceRoot);
  }

  async updateRemoteExecutorConnection(
    id: string,
    name: string,
    endpointUrl: string,
    accessToken?: string,
  ): Promise<RemoteExecutorConnectionView> {
    const current = this.store.getRemoteExecutorConnection(id);
    if (!current) throw new Error('Remote Executor connection not found.');
    const cleanedName = name.trim();
    if (!cleanedName) throw new Error('Remote Executor name is required.');
    const normalizedUrl = normalizeRemoteExecutorUrl(endpointUrl);
    if (normalizedUrl !== current.endpointUrl) {
      throw new Error(
        'Remote Executor endpoints cannot be changed on an existing connection. Add a new connection and create a new Thread to use another Executor.',
      );
    }
    const token = accessToken?.trim() || current.accessToken;
    const info = await inspectRemoteExecutor(normalizedUrl, token);
    return this.store.updateRemoteExecutorConnection(id, cleanedName, normalizedUrl, token, info.workspaceRoot);
  }

  remoteExecutorConnections(): RemoteExecutorConnectionView[] {
    return this.store.listRemoteExecutorConnections();
  }

  async createRemoteThread(
    projectId: string,
    connectionId: string,
    remoteWorkspacePath: string,
    title = DEFAULT_THREAD_TITLE,
  ): Promise<Thread> {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.');
    const connection = this.store.getRemoteExecutorConnection(connectionId);
    if (!connection) throw new Error('Remote Executor connection not found.');
    const workspacePath = await validateRemoteWorkspace(
      connection.endpointUrl,
      connection.accessToken,
      remoteWorkspacePath,
    );
    const thread = this.store.createThread(projectId, 'host', title.trim() || DEFAULT_THREAD_TITLE, {
      remoteConnectionId: connection.id,
      workspacePath,
      modelSelection: this.defaultThreadModelSelection(),
    });
    this.publish({ type: 'thread.created', thread });
    return thread;
  }

  getThread(threadId: string): Thread | null {
    const thread = this.store.getThread(threadId);
    if (!thread) return null;
    const loopActive = this.loops.has(threadId);
    const executionActive = this.store.listActiveExecutions(threadId).length > 0;
    const state: ThreadState = thread.pauseRequested
      ? loopActive
        ? 'pausing'
        : 'paused'
      : loopActive || executionActive
        ? 'running'
        : 'idle';
    return { ...thread, state };
  }

  listThreads(projectId?: string): Thread[] {
    return this.store.listThreads(projectId).map((thread) => this.getThread(thread.id) ?? thread);
  }

  listArchivedThreads(): Thread[] {
    return this.store.listArchivedThreads().map((thread) => this.getThread(thread.id) ?? thread);
  }

  archiveThread(threadId: string): Thread {
    const current = this.store.getThread(threadId);
    if (!current) throw new Error('Thread not found.');
    if (current.deletedAt) throw new Error('This Thread is hidden and cannot be archived.');
    const tree = this.store.listThreadTree(threadId);
    for (const candidate of tree) {
      if (!candidate.deletedAt) this.assertThreadNotRunning(candidate.id);
    }
    const archived = this.store.archiveThreadTree(threadId);
    for (const candidate of archived) {
      const updated = this.getThread(candidate.id);
      if (updated) this.publish({ type: 'thread.updated', thread: updated });
    }
    const updated = this.getThread(threadId);
    if (!updated) throw new Error('Thread not found.');
    return updated;
  }

  unarchiveThread(threadId: string): Thread {
    const current = this.store.getThread(threadId);
    if (!current) throw new Error('Thread not found.');
    if (current.deletedAt) throw new Error('This Thread is hidden and cannot be restored.');
    this.assertThreadNotRunning(threadId);
    if (!current.archivedAt) return this.getThread(threadId)!;
    const thread = this.store.unarchiveThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const updated = this.getThread(threadId)!;
    this.publish({ type: 'thread.updated', thread: updated });
    return updated;
  }

  hideArchivedThread(threadId: string): Thread {
    const current = this.store.getThread(threadId);
    if (!current) throw new Error('Thread not found.');
    if (!current.archivedAt || current.deletedAt) {
      throw new Error('Only an archived Thread can be hidden.');
    }
    this.assertThreadNotRunning(threadId);
    const thread = this.store.hideArchivedThread(threadId);
    if (!thread?.deletedAt) throw new Error('Only an archived Thread can be hidden.');
    const hidden = this.getThread(threadId)!;
    this.publish({ type: 'thread.hidden', thread: hidden });
    return hidden;
  }

  private assertThreadNotRunning(threadId: string): void {
    if (
      this.loops.has(threadId) ||
      this.store.listActiveExecutions(threadId).length > 0 ||
      (this.inFlightThreadOperations.get(threadId) ?? 0) > 0
    ) {
      throw new Error('Wait for this Thread to stop running before changing its archive state.');
    }
  }

  private beginThreadOperation(threadId: string): () => void {
    this.inFlightThreadOperations.set(threadId, (this.inFlightThreadOperations.get(threadId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.inFlightThreadOperations.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.inFlightThreadOperations.set(threadId, remaining);
      else this.inFlightThreadOperations.delete(threadId);
    };
  }

  private requireUnarchivedThread(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    if (thread.deletedAt !== undefined && thread.deletedAt !== null) {
      throw new Error('This Thread is hidden from Pico.');
    }
    if (thread.archivedAt !== undefined && thread.archivedAt !== null) {
      throw new Error('This Thread is archived. Restore it before continuing.');
    }
    return thread;
  }

  getSnapshot(threadId: string, beforeSeq?: number): ThreadSnapshot | null {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new Error('beforeSeq must be a positive safe integer.');
    }
    const thread = this.getThread(threadId);
    if (!thread) return null;
    const contextUsage = this.estimateContextUsage(thread);
    const page = this.store.listRecordPage(threadId, beforeSeq, THREAD_HISTORY_PAGE_SIZE);
    const executions = this.store.listSnapshotExecutions(threadId, page.records).map((execution) => {
      if (execution.kind !== 'model' || typeof execution.arguments?.model === 'string') return execution;
      const attempts = this.getModelInputAttempts(threadId, execution.id);
      const model = attempts?.at(-1)?.promptSummary.model;
      return typeof model === 'string' && model.trim()
        ? { ...execution, arguments: { ...(execution.arguments ?? {}), model } }
        : execution;
    });
    return {
      thread,
      modelSelection: this.threadModelSelection(threadId),
      contextUsage,
      records: page.records.map(redactReasoningReplay),
      executions: executions.map(redactExecutionImages),
      children: this.listThreads(thread.projectId).filter((candidate) => candidate.parentThreadId === threadId),
      hasEarlierRecords: page.hasEarlierRecords,
      historyPageSize: THREAD_HISTORY_PAGE_SIZE,
    };
  }

  async listThreadTools(threadId: string): Promise<ThreadToolView[]> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');

    const runtimeTools = this.tools.listBySource('runtime').map(({ definition }) => definition);
    const binding = requiresExternalExecutor(thread.executorKind) ? this.store.executorForThread(threadId) : null;
    let executorTools: ToolDefinition[] = [];

    if (binding) {
      const cachedSurface = this.readCachedThreadToolSurface(threadId);
      executorTools = cachedSurface?.tools.filter((tool) => cachedSurface.sources[tool.name] === 'executor') ?? [];
      if (executorTools.length === 0) {
        // Opening the Thread tools panel must not start a Container just to
        // inspect its tool definitions. Built-in Executor schemas are already
        // available in Runtime; dynamic Executor plugins are added once the
        // Executor has been started and its complete surface has been cached.
        executorTools =
          thread.executorKind === 'container'
            ? builtinExecutorToolDefinitions()
            : await this.adapterFor(binding).listTools(binding);
      }
    }

    const known = new Map<string, { definition: ToolDefinition; source: 'runtime' | 'executor' }>();
    for (const definition of runtimeTools) known.set(definition.name, { definition, source: 'runtime' });
    for (const definition of executorTools) {
      if (!known.has(definition.name)) known.set(definition.name, { definition, source: 'executor' });
    }
    const disabled = new Set(this.disabledThreadToolNames(threadId));
    return [...known.values()].map(({ definition, source }) => ({
      name: definition.name,
      description: definition.description,
      source,
      enabled: !disabled.has(definition.name),
    }));
  }

  async setThreadToolEnabled(threadId: string, toolName: string, enabled: boolean): Promise<ThreadToolView[]> {
    if (!toolName.trim()) throw new Error('Tool name is required');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    const tools = await this.listThreadTools(threadId);
    if (!tools.some((tool) => tool.name === toolName)) throw new Error('Tool is not available in this Thread');

    const disabled = new Set(this.disabledThreadToolNames(threadId));
    if (enabled) disabled.delete(toolName);
    else disabled.add(toolName);
    const allDisabled = this.allDisabledThreadTools();
    this.store.setSetting(DISABLED_THREAD_TOOLS_SETTING, {
      ...allDisabled,
      [threadId]: [...disabled],
    });
    return this.listThreadTools(threadId);
  }

  private appendExecutionDiagnostic(executionId: string, kind: string, detail: Record<string, unknown>): void {
    try {
      this.store.appendExecutionLog(executionId, kind, detail);
    } catch {
      try {
        console.warn('Execution diagnostics could not be persisted.');
      } catch {
        // Diagnostic persistence is best-effort and must not change model execution.
      }
    }
  }

  getModelInputAttempts(threadId: string, executionId: string): ModelInputAttempt[] | null {
    const execution = this.store.getExecution(executionId);
    if (!execution || execution.threadId !== threadId || execution.kind !== 'model') return null;
    const outcomes = new Map<
      string,
      {
        status: ModelInputAttempt['status'];
        error?: string;
        result?: ModelInputResultSummary;
        partialOutputCharacters?: number;
      }
    >();
    for (const entry of this.store.listExecutionLog(executionId, 'model-input-settled')) {
      const requestId = entry.detail.requestId;
      const status = entry.detail.status;
      if (
        typeof requestId === 'string' &&
        (status === 'completed' || status === 'failed' || status === 'interrupted')
      ) {
        const safeError = safeStoredModelError(entry.detail.error);
        outcomes.set(requestId, {
          status,
          ...(safeError ? { error: safeError } : {}),
          ...(Number.isSafeInteger(entry.detail.partialOutputCharacters) &&
          (entry.detail.partialOutputCharacters as number) >= 0
            ? { partialOutputCharacters: Math.min(entry.detail.partialOutputCharacters as number, 1_000_000_000) }
            : {}),
          ...(objectValue(entry.detail.result) &&
          Number.isSafeInteger(objectValue(entry.detail.result)!.textCharacters) &&
          Number.isSafeInteger(objectValue(entry.detail.result)!.toolCallCount) &&
          typeof objectValue(entry.detail.result)!.empty === 'boolean'
            ? {
                result: {
                  textCharacters: Math.max(
                    0,
                    Math.min(objectValue(entry.detail.result)!.textCharacters as number, 1_000_000_000),
                  ),
                  toolCallCount: Math.max(
                    0,
                    Math.min(objectValue(entry.detail.result)!.toolCallCount as number, 1_000_000),
                  ),
                  finishReason:
                    objectValue(entry.detail.result)!.finishReason === null
                      ? null
                      : (diagnosticLabel(objectValue(entry.detail.result)!.finishReason, 80) ?? null),
                  usage: diagnosticUsage(objectValue(entry.detail.result)!.usage),
                  empty: objectValue(entry.detail.result)!.empty as boolean,
                },
              }
            : {}),
        });
      }
    }

    const providerRequestsById = new Map<string, ProviderRequestAttempt>();
    for (const entry of this.store.listExecutionLog(executionId, 'provider-request-started')) {
      const requestId = entry.detail.requestId;
      const id = entry.detail.providerAttemptId;
      if (typeof requestId !== 'string' || typeof id !== 'string') continue;
      const start = sanitizeRequestStart({
        provider: typeof entry.detail.provider === 'string' ? entry.detail.provider : 'unknown',
        protocol: typeof entry.detail.protocol === 'string' ? entry.detail.protocol : 'unknown',
        endpoint: typeof entry.detail.endpoint === 'string' ? entry.detail.endpoint : '',
        attempt: typeof entry.detail.attempt === 'number' ? entry.detail.attempt : 1,
      });
      providerRequestsById.set(id, {
        id,
        ...start,
        outcome: 'running',
        createdAt: entry.createdAt,
      });
    }
    for (const entry of this.store.listExecutionLog(executionId, 'provider-request-response')) {
      const id = entry.detail.providerAttemptId;
      const attempt = typeof id === 'string' ? providerRequestsById.get(id) : undefined;
      if (!attempt) continue;
      const response = sanitizeRequestResponse({
        status: typeof entry.detail.status === 'number' ? entry.detail.status : 0,
        contentType: typeof entry.detail.contentType === 'string' ? entry.detail.contentType : null,
        ...(typeof entry.detail.providerRequestId === 'string'
          ? { providerRequestId: entry.detail.providerRequestId }
          : {}),
      });
      if (response.status) attempt.status = response.status;
      attempt.contentType = response.contentType;
      if (response.providerRequestId) attempt.providerRequestId = response.providerRequestId;
    }
    for (const entry of this.store.listExecutionLog(executionId, 'provider-request-settled')) {
      const id = entry.detail.providerAttemptId;
      const attempt = typeof id === 'string' ? providerRequestsById.get(id) : undefined;
      if (!attempt) continue;
      const outcome =
        entry.detail.outcome === 'retrying' ||
        entry.detail.outcome === 'completed' ||
        entry.detail.outcome === 'failed' ||
        entry.detail.outcome === 'interrupted'
          ? entry.detail.outcome
          : 'failed';
      const terminalEvent = typeof entry.detail.terminalEvent === 'string' ? entry.detail.terminalEvent : undefined;
      const errorCategory =
        entry.detail.errorCategory === 'http' ||
        entry.detail.errorCategory === 'transport' ||
        entry.detail.errorCategory === 'protocol' ||
        entry.detail.errorCategory === 'aborted'
          ? entry.detail.errorCategory
          : undefined;
      const errorCode = safeProviderErrorCode(entry.detail.errorCode);
      const eventCounts = objectValue(entry.detail.eventCounts) as Record<string, number> | null;
      const firstTextMs = typeof entry.detail.firstTextMs === 'number' ? entry.detail.firstTextMs : undefined;
      const deltaTextCharacters =
        typeof entry.detail.deltaTextCharacters === 'number' ? entry.detail.deltaTextCharacters : undefined;
      const outputTextCharacters =
        typeof entry.detail.outputTextCharacters === 'number' ? entry.detail.outputTextCharacters : undefined;
      const outputItemCounts = objectValue(entry.detail.outputItemCounts) as Record<string, number> | null;
      const toolCallCount = typeof entry.detail.toolCallCount === 'number' ? entry.detail.toolCallCount : undefined;
      const finishReason =
        entry.detail.finishReason === null
          ? null
          : typeof entry.detail.finishReason === 'string'
            ? entry.detail.finishReason
            : undefined;
      const responseId = typeof entry.detail.responseId === 'string' ? entry.detail.responseId : undefined;
      const usage = objectValue(entry.detail.usage) as TokenUsage | null;
      const summary = sanitizeRequestSummary({
        outcome,
        durationMs: typeof entry.detail.durationMs === 'number' ? entry.detail.durationMs : 0,
        ...(terminalEvent ? { terminalEvent } : {}),
        ...(errorCategory ? { errorCategory } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(eventCounts ? { eventCounts } : {}),
        ...(firstTextMs === undefined ? {} : { firstTextMs }),
        ...(deltaTextCharacters === undefined ? {} : { deltaTextCharacters }),
        ...(outputTextCharacters === undefined ? {} : { outputTextCharacters }),
        ...(outputItemCounts ? { outputItemCounts } : {}),
        ...(toolCallCount === undefined ? {} : { toolCallCount }),
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(responseId ? { responseId } : {}),
        ...(usage ? { usage } : {}),
      });
      Object.assign(attempt, summary);
    }
    const providerRequestsByModelRequestId = new Map<string, ProviderRequestAttempt[]>();
    for (const entry of this.store.listExecutionLog(executionId, 'provider-request-started')) {
      const requestId = entry.detail.requestId;
      const id = entry.detail.providerAttemptId;
      const attempt = typeof id === 'string' ? providerRequestsById.get(id) : undefined;
      if (typeof requestId !== 'string' || !attempt) continue;
      const grouped = providerRequestsByModelRequestId.get(requestId) ?? [];
      grouped.push(attempt);
      providerRequestsByModelRequestId.set(requestId, grouped);
    }

    const attempts = new Map<string, ModelInputAttempt>();
    const attemptFrom = (
      requestId: string,
      createdAt: string,
      promptSource: unknown,
      summarySource: unknown,
      provenanceSource: unknown,
    ): ModelInputAttempt | null => {
      const prompt = modelInputPromptSnapshotFrom(promptSource);
      const promptSummary = modelPromptDiagnosticsFrom(summarySource ?? promptSource);
      if (!promptSummary) return null;
      const outcome = outcomes.get(requestId);
      const status =
        outcome?.status ??
        (execution.status === 'interrupted' || execution.status === 'failed' || execution.status === 'completed'
          ? execution.status
          : 'running');
      return {
        id: requestId,
        ...(prompt ? { prompt } : {}),
        promptSummary,
        ...(Array.isArray(provenanceSource)
          ? { projectionProvenance: provenanceSource as ProjectionProvenance[] }
          : {}),
        status,
        ...(outcome?.error ? { error: outcome.error } : {}),
        ...(outcome?.result ? { result: outcome.result } : {}),
        ...(outcome?.partialOutputCharacters === undefined
          ? {}
          : { partialOutputCharacters: outcome.partialOutputCharacters }),
        providerRequests: providerRequestsByModelRequestId.get(requestId) ?? [],
        createdAt,
      };
    };
    const recordedRequestIds = new Set<string>();
    for (const record of this.store.listRecords(threadId)) {
      if (record.kind !== 'plugin') continue;
      const payload = objectValue(record.payload);
      if (
        payload?.pluginId !== 'pico.runtime' ||
        payload.action !== 'model-input-recorded' ||
        payload.executionId !== executionId ||
        typeof payload.requestId !== 'string'
      ) {
        continue;
      }
      const requestId = payload.requestId;
      const attempt = attemptFrom(
        requestId,
        record.createdAt,
        payload.prompt,
        payload.promptSummary,
        payload.projectionProvenance,
      );
      if (!attempt) continue;
      attempts.set(requestId, attempt);
      recordedRequestIds.add(requestId);
    }

    // Older databases stored the full request in execution diagnostics; read them as a migration path only.
    for (const entry of this.store.listExecutionLog(executionId, 'model-input-requested')) {
      const requestId = entry.detail.requestId;
      if (typeof requestId !== 'string' || recordedRequestIds.has(requestId)) continue;
      const attempt = attemptFrom(
        requestId,
        entry.createdAt,
        entry.detail.prompt,
        entry.detail.promptSummary,
        entry.detail.projectionProvenance,
      );
      if (attempt) attempts.set(requestId, attempt);
    }
    return [...attempts.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async submit(threadId: string, id: string, content: string): Promise<SubmitResult> {
    const thread = this.requireUnarchivedThread(threadId);
    if (content.trimStart().startsWith('/')) {
      const commandText = content.trim();
      const requestHash = createHash('sha256').update(`${threadId}\0${id}`).digest('hex');
      const commandHash = createHash('sha256').update(commandText).digest('hex');
      const receiptId = `pico:command:${requestHash}`;
      const completedId = `${receiptId}:completed`;
      const receipt = this.store.appendCanonical(threadId, receiptId, 'plugin', {
        pluginId: 'pico.commands',
        action: 'invocation-accepted',
        requestHash,
        commandHash,
      });
      if (!receipt.inserted) {
        const completedCommand = commandResultFromRecord(
          this.store.getCanonicalRecordById(completedId),
          threadId,
          requestHash,
          commandHash,
        );
        if (completedCommand) return { accepted: true, duplicate: true, command: completedCommand };
        return {
          accepted: true,
          duplicate: true,
          command: {
            text: 'This command ID was already accepted. Its original handler may still be running or may have finished; it was not started again.',
          },
        };
      }
      const endOperation = this.beginThreadOperation(threadId);
      try {
        const command = await this.commands.execute(commandText, {
          thread: this.getThread(threadId),
          projectId: thread.projectId,
        });
        if (command) {
          this.store.appendCanonical(threadId, completedId, 'plugin', {
            pluginId: 'pico.commands',
            action: 'invocation-completed',
            requestHash,
            commandHash,
            result: command,
          });
          return { accepted: true, duplicate: false, command };
        }
      } finally {
        endOperation();
      }
    }
    const result = this.postMessage(thread, id, {
      role: 'user',
      content,
      source: 'user',
    });
    return { accepted: true, duplicate: !result.inserted };
  }

  private postMessage(
    thread: Thread,
    id: string,
    payload: MessagePayload,
  ): { record: CanonicalRecord<MessagePayload>; inserted: boolean } {
    this.requireUnarchivedThread(thread.id);
    const result = this.store.appendMessage(thread.id, id, payload);
    if (result.inserted) {
      if (!thread.pauseRequested) this.startLoop(thread.id);
    }
    this.publishThreadUpdate(thread.id);
    return result;
  }

  pause(threadId: string): Thread {
    this.requireUnarchivedThread(threadId);
    this.store.setPause(threadId, true, 'Paused by user. Current model and tool executions are allowed to settle.');
    this.publishThreadUpdate(threadId);
    return this.getThread(threadId)!;
  }

  private pauseForPlugin(threadId: string, reason: string): Thread {
    this.requireUnarchivedThread(threadId);
    const cleanedReason = reason.trim().slice(0, 500) || 'Paused by a workflow plugin.';
    this.store.setPause(threadId, true, cleanedReason);
    this.publishThreadUpdate(threadId);
    return this.getThread(threadId)!;
  }

  private resumeForPlugin(threadId: string): Thread {
    this.requireUnarchivedThread(threadId);
    this.recoverOrphanedModelExecutions(threadId, 'plugin-resume');
    this.store.setPause(threadId, false);
    this.publishThreadUpdate(threadId);
    this.startLoop(threadId);
    return this.getThread(threadId)!;
  }

  continue(threadId: string): Thread {
    this.requireUnarchivedThread(threadId);
    this.recoverOrphanedModelExecutions(threadId, 'continue');
    this.store.setPause(threadId, false);
    this.publishThreadUpdate(threadId);
    this.startLoop(threadId);
    return this.getThread(threadId)!;
  }

  retryModelExecution(threadId: string, sourceExecutionId: string): { execution: Execution; thread: Thread } {
    this.requireUnarchivedThread(threadId);
    if (this.loops.has(threadId)) {
      throw new Error('This Thread is already running. Wait for the active step to settle before retrying.');
    }
    const candidate = this.store.getExecution(sourceExecutionId);
    if (!candidate || candidate.threadId !== threadId || candidate.kind !== 'model') {
      throw new Error('Model Execution not found in this Thread.');
    }
    this.recoverOrphanedModelExecutions(threadId, 'retry');
    const source = this.store.getExecution(sourceExecutionId);
    if (!source || source.threadId !== threadId || source.kind !== 'model') {
      throw new Error('Model Execution not found in this Thread.');
    }
    if (this.store.listActiveExecutions(threadId).length > 0) {
      throw new Error('This Thread is already running. Wait for the active step to settle before retrying.');
    }

    const projectionThrough = modelExecutionProjectionThrough(source);
    if (projectionThrough === null) throw new Error('This Model Execution has no saved projection boundary.');
    const records = this.store.listRecords(threadId);
    if (!records.some((record) => record.kind === 'message' && record.seq <= projectionThrough)) {
      throw new Error('This Model Execution is not attached to a user message.');
    }
    if (
      records.some((record) => record.kind === 'message' && record.seq > projectionThrough) ||
      this.store.listExecutions(threadId).some((execution) => {
        const laterProjection = modelExecutionProjectionThrough(execution);
        return execution.kind === 'model' && laterProjection !== null && laterProjection > projectionThrough;
      })
    ) {
      throw new Error('A newer message or Model Step exists. Continue the Thread from its latest step instead.');
    }
    const assistantRecord = this.store.getCanonicalRecordById(`${source.id}:assistant`);
    const retryableFailure =
      (source.status === 'failed' || source.status === 'interrupted') && assistantRecord === null;
    const retryableEmptyCompletion = (() => {
      if (source.status !== 'completed' || assistantRecord?.kind !== 'assistant') return false;
      const payload = assistantRecord.payload as unknown as AssistantPayload;
      return (
        typeof payload.content === 'string' &&
        payload.content.trim() === '' &&
        Array.isArray(payload.toolCalls) &&
        payload.toolCalls.length === 0
      );
    })();
    if (!retryableFailure && !retryableEmptyCompletion) {
      throw new Error('Only a failed, interrupted, or empty Model Execution can be retried.');
    }

    const execution = this.store.createModelExecution(
      randomUUID(),
      threadId,
      projectionThrough,
      source.id,
      this.threadModelSelection(threadId).model,
    );
    this.store.setPause(threadId, false);
    this.executionChanged(execution);
    this.startLoop(threadId);
    return { execution, thread: this.getThread(threadId)! };
  }

  async interrupt(threadId: string): Promise<Thread> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    this.store.setPause(threadId, true, 'Interrupted by user. Continue when ready to inspect the current environment.');
    for (const [executionId, controller] of this.modelSignals) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) controller.abort();
    }
    this.recoverOrphanedModelExecutions(threadId, 'interrupt');
    for (const [executionId, active] of this.runtimeToolRuns) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) active.controller.abort();
    }
    for (const [executionId, active] of this.invocationRuns) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) active.controller.abort();
    }
    for (const execution of this.store.listActiveExecutions(threadId)) {
      if (execution.kind === 'model') continue;
      const tool = execution.toolName ? this.tools.get(execution.toolName) : undefined;
      const invocation = this.invocationRuns.get(execution.id);
      if (invocation && !invocation.toolStarted) {
        const settled = await invocation.promise;
        if (terminalStatus(settled.status)) this.ensureToolResult(threadId, settled);
        continue;
      }
      if (tool?.source === 'runtime' || thread.executorKind === 'runtime') {
        if (invocation) {
          const settled = await invocation.promise;
          if (terminalStatus(settled.status)) this.ensureToolResult(threadId, settled);
        } else if (execution.status === 'pending' || execution.status === 'running') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'Runtime confirmed this control tool will not continue after the explicit Interrupt request.',
            detail: { userInterrupted: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
        continue;
      }
      const binding = this.store.executorForThread(threadId);
      if (!binding) {
        if (execution.status === 'pending') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'No Executor was bound when the user explicitly interrupted this pending execution.',
            detail: { userInterrupted: true, confirmedMissing: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
        continue;
      }
      try {
        const adapter = this.adapterFor(binding);
        const updated = await adapter.interrupt(execution.id, binding);
        if (updated) {
          this.executionChanged(updated);
          if (terminalStatus(updated.status)) this.ensureToolResult(threadId, updated);
        }
        const latest = this.store.getExecution(execution.id);
        if (execution.status === 'pending' && latest?.status === 'pending') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'The Executor confirmed this execution had not started when the user explicitly interrupted it.',
            detail: { userInterrupted: true, confirmedMissing: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
      } catch {
        // A disconnected Executor leaves its last durable state untouched.
        this.publish({
          type: 'runtime.error',
          threadId,
          message: `Interrupt could not reach ${binding.label}. The Executor may still be running; inspect its status before continuing.`,
        });
      }
    }
    this.publishThreadUpdate(threadId);
    return this.getThread(threadId)!;
  }

  private startLoop(threadId: string): void {
    if (this.shuttingDown || this.loops.has(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (
      !thread ||
      (thread.archivedAt !== undefined && thread.archivedAt !== null) ||
      (thread.deletedAt !== undefined && thread.deletedAt !== null)
    ) {
      return;
    }

    const recovered = this.recoverOrphanedModelExecutions(threadId, 'loop-start');
    const pendingRetryId = this.pendingModelRetry(threadId)?.id;
    const activeModels = this.store.listActiveExecutions(threadId).filter((execution) => execution.kind === 'model');
    const unownedActiveModels = activeModels.filter(
      (execution) => execution.id !== pendingRetryId && !this.modelSignals.has(execution.id),
    );
    if (unownedActiveModels.length > 0) {
      if (!this.store.getThread(threadId)?.pauseRequested) {
        this.store.setPause(
          threadId,
          true,
          'An unfinished Model Execution was recovered. Continue this Thread to start a new attempt.',
        );
      }
      this.publishThreadUpdate(threadId);
      return;
    }
    if (activeModels.some((execution) => this.modelSignals.has(execution.id))) return;
    if (recovered.length > 0 && !pendingRetryId && !thread.pauseRequested) {
      this.store.setPause(
        threadId,
        true,
        'An unfinished Model Execution was recovered. Continue this Thread to start a new attempt.',
      );
      this.publishThreadUpdate(threadId);
      return;
    }
    if (thread.pauseRequested && !this.latestActiveBatch(threadId)) return;

    const task = Promise.resolve()
      .then(() => this.driveThread(threadId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.store.getThread(threadId);
        if (current && !current.pauseRequested) {
          this.store.setPause(threadId, true, `Runtime paused after an unexpected error: ${message}`);
        }
        this.publish({ type: 'runtime.error', threadId, message });
      })
      .finally(() => {
        try {
          const recovered = this.recoverOrphanedModelExecutions(threadId, 'loop-exit');
          const pendingRetryId = this.pendingModelRetry(threadId)?.id;
          const hasUnownedActiveModel = this.store
            .listActiveExecutions(threadId)
            .some(
              (execution) =>
                execution.kind === 'model' && execution.id !== pendingRetryId && !this.modelSignals.has(execution.id),
            );
          const current = this.store.getThread(threadId);
          if ((recovered.length > 0 || hasUnownedActiveModel) && current && !current.pauseRequested) {
            this.store.setPause(
              threadId,
              true,
              'Runtime stopped before the Model Step settled. Continue this Thread to start a new attempt.',
            );
          }
        } catch (error) {
          this.publish({
            type: 'runtime.error',
            threadId,
            message: `Could not reconcile Model Executions after the loop stopped: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          this.loops.delete(threadId);
        }
        this.publishThreadUpdate(threadId);
        const afterLoop = this.store.getThread(threadId);
        if (afterLoop && !afterLoop.pauseRequested && this.hasUnprocessedWork(threadId)) this.startLoop(threadId);
      });
    this.loops.set(threadId, task);
    this.publishThreadUpdate(threadId);
  }

  private async driveThread(threadId: string): Promise<void> {
    let iteration = 0;
    while (true) {
      if (this.shuttingDown) return;
      const thread = this.store.getThread(threadId);
      if (!thread) return;
      const pendingRetry = this.pendingModelRetry(threadId);
      if (
        !this.latestActiveBatch(threadId) &&
        (thread.pauseRequested || (!pendingRetry && !this.needsModelStep(threadId)))
      ) {
        return;
      }
      let defaultStepRan = false;
      await this.pipelines.run('step', { thread, iteration }, async (input) => {
        if (input.thread.id !== threadId) throw new Error('Step plugins must preserve the active Thread identity.');
        defaultStepRan = true;
        await this.performStep(input.thread);
      });
      const afterStep = this.store.getThread(threadId);
      if (afterStep?.pauseRequested && this.latestActiveBatch(threadId)) return;
      if (!defaultStepRan && afterStep && !afterStep.pauseRequested && this.hasUnprocessedWork(threadId)) {
        this.store.setPause(threadId, true, 'The step pipeline stopped before durable work reached a safe boundary.');
        this.publishThreadUpdate(threadId);
        return;
      }
      iteration += 1;
    }
  }

  private async performStep(thread: Thread): Promise<void> {
    if (this.shuttingDown) return;
    const currentThread = this.store.getThread(thread.id);
    if (!currentThread) return;
    const activeBatch = this.latestActiveBatch(thread.id);
    if (activeBatch) {
      await this.runToolBatch(currentThread, activeBatch);
      return;
    }
    const pendingRetry = this.pendingModelRetry(thread.id);
    if (pendingRetry) {
      await this.runModelStep(currentThread, pendingRetry);
    } else {
      if (currentThread.pauseRequested || !this.needsModelStep(thread.id)) return;
      const projectedInput = await this.autoCompactBeforeModelStep(currentThread);
      if (this.shuttingDown || this.store.getThread(thread.id)?.pauseRequested) return;
      await this.runModelStep(currentThread, undefined, projectedInput ?? undefined);
    }

    if (this.shuttingDown) return;
    const afterModel = this.store.getThread(thread.id);
    const modelBatch = afterModel ? this.latestActiveBatch(thread.id) : null;
    if (afterModel && modelBatch) await this.runToolBatch(afterModel, modelBatch);
  }

  private async autoCompactBeforeModelStep(thread: Thread): Promise<ProjectionInput | null> {
    const settings = this.getContextManagementSettings();
    const records = this.store.listRecords(thread.id);
    const latestAssistant = [...records].reverse().find((record) => record.kind === 'assistant');
    // A compaction/reset projection changes the next prompt before there is a
    // new provider usage record. Do not reuse usage measured against the old prompt.
    const latestProjectionSeq = latestRuntimeContextProjectionSeq(records);
    if (latestProjectionSeq !== null && (!latestAssistant || latestProjectionSeq > latestAssistant.seq)) {
      try {
        const through = records.at(-1)?.seq ?? 0;
        const projectedInput = await this.projectModelInput(thread, records, through);
        if (
          estimatePromptCharacters(projectedInput.turns, settings.contextWindowTokens) >= settings.contextWindowTokens
        ) {
          const previousCompactionThrough = activeRuntimeContextCompaction(records)?.throughSeq ?? 0;
          const result = await this.compactThread(thread, true, false, projectedInput);
          const recordsAfterCompaction = this.store.listRecords(thread.id);
          const compactedContext = activeRuntimeContextCompaction(recordsAfterCompaction);
          if (compactedContext && compactedContext.throughSeq > previousCompactionThrough) {
            const compactedThrough = recordsAfterCompaction.at(-1)?.seq ?? 0;
            const compactedProjection = await this.projectModelInput(thread, recordsAfterCompaction, compactedThrough);
            if (
              estimatePromptCharacters(compactedProjection.turns, settings.contextWindowTokens) <
              settings.contextWindowTokens
            ) {
              return compactedProjection;
            }
          }
          const detail = result.text?.trim();
          this.store.setPause(
            thread.id,
            true,
            `The projected conversation still reaches the configured context window after compaction. The next model request was blocked; review or shorten recent history, then Continue.${detail ? ` ${detail}` : ''}`,
          );
          this.publishThreadUpdate(thread.id);
          return null;
        }
        return projectedInput;
      } catch {
        this.store.setPause(
          thread.id,
          true,
          'The projected conversation could not be prepared safely after compaction. The next model request was blocked; review the Thread history and projection plugins before continuing.',
        );
        this.publishThreadUpdate(thread.id);
        return null;
      }
    }
    if (!latestAssistant) return null;
    const assistantPayload = objectValue(latestAssistant.payload);
    const inputTokens = diagnosticUsage(assistantPayload?.usage)?.inputTokens;
    if (inputTokens === undefined) return null;
    if (inputTokens < settings.compactionThresholdTokens) return null;

    const latestCompaction = [...records].reverse().find((record) => {
      if (record.kind !== 'plugin') return false;
      const payload = objectValue(record.payload);
      return payload?.pluginId === 'pico.runtime' && payload.action === 'context-compacted';
    });
    const previousThroughSeq = activeRuntimeContextCompaction(records)?.throughSeq ?? 0;
    try {
      const through = records.at(-1)?.seq ?? 0;
      const projectedInput = await this.projectModelInput(thread, records, through);
      const result = await this.compactThread(thread, true, false, projectedInput);
      const recordsAfterCompaction = this.store.listRecords(thread.id);
      const latestCompactionAfter = [...recordsAfterCompaction].reverse().find((record) => {
        if (record.kind !== 'plugin') return false;
        const payload = objectValue(record.payload);
        return payload?.pluginId === 'pico.runtime' && payload.action === 'context-compacted';
      });
      if (latestCompactionAfter && latestCompactionAfter.seq > (latestCompaction?.seq ?? 0)) {
        const compactedContext = activeRuntimeContextCompaction(recordsAfterCompaction);
        if (!compactedContext || compactedContext.throughSeq <= previousThroughSeq) {
          this.store.setPause(
            thread.id,
            true,
            'Automatic context compaction produced an invalid history marker. The next model request was blocked; review the Thread history before continuing.',
          );
          this.publishThreadUpdate(thread.id);
          return null;
        }

        const compactedThrough = recordsAfterCompaction.at(-1)?.seq ?? 0;
        const compactedProjection = await this.projectModelInput(thread, recordsAfterCompaction, compactedThrough);
        const postCompactionEstimate = estimatePromptCharacters(
          compactedProjection.turns,
          settings.contextWindowTokens,
        );
        if (postCompactionEstimate >= settings.contextWindowTokens) {
          this.store.setPause(
            thread.id,
            true,
            'The compacted conversation still exceeds the configured context window. The next model request was blocked; review or shorten recent history, then Continue.',
          );
          this.publishThreadUpdate(thread.id);
          return null;
        }
        return compactedProjection;
      }

      const failureDetail = result.text?.trim();
      const reason = failureDetail
        ? `Automatic context compaction did not complete, so the next model request was blocked. ${failureDetail} Review the compaction settings or recent history, then Continue.`
        : 'Automatic context compaction did not complete, so the next model request was blocked. Review the compaction settings or recent history, then Continue.';
      this.store.setPause(thread.id, true, reason);
      this.publishThreadUpdate(thread.id);
      return null;
    } catch {
      this.store.setPause(
        thread.id,
        true,
        'Automatic context compaction failed, so the next model request was blocked. Review the selected model and connection, then Continue.',
      );
      this.publishThreadUpdate(thread.id);
      return null;
    }
  }

  private async projectModelInput(
    thread: Thread,
    records: readonly CanonicalRecord[],
    through: number,
  ): Promise<ProjectionInput> {
    const projectionRecords = records.filter((record) => record.seq <= through).map((record) => deepFreeze(record));
    const toolSurface = await this.toolSurfaceFor(thread);
    const disabledTools = new Set(this.disabledThreadToolNames(thread.id));
    const enabledTools = toolSurface.tools.filter((tool) => !disabledTools.has(tool.name));
    const enabledToolSources = Object.fromEntries(
      enabledTools.map((tool) => [tool.name, toolSurface.sources[tool.name]!]),
    );
    const runtimeCompaction = activeRuntimeContextCompaction(projectionRecords);
    const projectedCanonicalRecords = canonicalConversationRecords(projectionRecords).filter(
      (record) => !runtimeCompaction || record.seq > runtimeCompaction.throughSeq,
    );
    const compactionStartSeq = runtimeCompaction
      ? (projectionRecords.find((record) => record.id === runtimeCompaction.sourceRecordIds[0])?.seq ?? 1)
      : null;
    const baseProjection: ProjectionInput = {
      thread,
      records: projectionRecords,
      through,
      systemPrompt: `${baseSystemPrompt}\n\n${thread.executorKind === 'runtime' ? 'This Thread uses Chat mode. It has no project workspace, filesystem, shell, or external execution environment. It can use tools provided by Runtime plugins.' : ''}\n\nCurrent Thread ID: ${thread.id}\n${thread.parentThreadId ? `Parent Thread ID: ${thread.parentThreadId}` : 'This Thread has no parent.'}`,
      turns: this.projectTurns(projectionRecords, thread),
      tools: enabledTools,
      toolSources: enabledToolSources,
      provenance: [
        ...(runtimeCompaction
          ? [
              {
                id: `runtime-compaction:${runtimeCompaction.sourceHash}`,
                sourcePluginId: 'pico.runtime',
                label: `Runtime compaction ${compactionStartSeq}-${runtimeCompaction.throughSeq}`,
                kind: 'canonical' as const,
                disposition: 'summary' as const,
                canonicalStartSeq: compactionStartSeq!,
                canonicalEndSeq: runtimeCompaction.throughSeq,
                reason: 'A Runtime-owned summary replaces this preserved Canonical prefix.',
                turnIndex: 0,
              },
            ]
          : []),
        ...projectedCanonicalRecords.map((record): ProjectionProvenance => ({
          id: `canonical:${record.id}`,
          sourcePluginId: 'pico.core',
          label: `Canonical ${record.kind}`,
          kind: 'canonical',
          disposition: 'raw',
          canonicalStartSeq: record.seq,
          canonicalEndSeq: record.seq,
        })),
      ],
    };
    return this.pipelines.run('projection', baseProjection, async (value) => value);
  }

  private estimateContextUsage(thread: Thread, records = this.store.listRecords(thread.id)): ContextUsageEstimate {
    const settings = this.getContextManagementSettings();
    const latestAssistant = [...records].reverse().find((record) => record.kind === 'assistant');
    const assistantPayload = latestAssistant ? objectValue(latestAssistant.payload) : null;
    // Use provider-reported input usage from the last settled request; Pico has no universal tokenizer.
    const usage = diagnosticUsage(assistantPayload?.usage);
    const projectionThrough =
      typeof assistantPayload?.projectionThrough === 'number' &&
      Number.isSafeInteger(assistantPayload.projectionThrough) &&
      assistantPayload.projectionThrough >= 0
        ? assistantPayload.projectionThrough
        : Math.max(0, (latestAssistant?.seq ?? 1) - 1);
    const latestCompaction = [...records].reverse().find((record) => {
      if (record.kind !== 'plugin') return false;
      const payload = objectValue(record.payload);
      return payload?.pluginId === 'pico.runtime' && payload.action === 'context-compacted';
    });
    const compaction = activeRuntimeContextCompaction(records);
    const conversation = canonicalConversationRecords(records);
    const hasProviderUsage = usage?.inputTokens !== undefined;
    const compactedSinceLastAssistant = Boolean(
      compaction &&
      (!hasProviderUsage || !latestAssistant || (latestCompaction && latestCompaction.seq > latestAssistant.seq)),
    );
    const estimatedTurns =
      compactedSinceLastAssistant && compaction
        ? [
            runtimeCompactionTurn(compaction),
            ...canonicalRecordsToPromptTurns(
              conversation.filter((record) => record.seq > compaction.throughSeq),
              thread,
            ),
          ]
        : canonicalRecordsToPromptTurns(
            hasProviderUsage ? conversation.filter((record) => record.seq > projectionThrough) : conversation,
            thread,
          );
    const additionalInputEstimate = estimatePromptCharacters(estimatedTurns, settings.contextWindowTokens);
    // Canonical prompt characters are a rough heuristic, not a tokenizer or a guaranteed upper bound.
    const includeProviderUsage = hasProviderUsage && !compactedSinceLastAssistant;
    const estimatedInputTokens = Math.min(
      Number.MAX_SAFE_INTEGER,
      (includeProviderUsage ? (usage?.inputTokens ?? 0) : 0) + additionalInputEstimate,
    );
    return {
      inputTokens: estimatedInputTokens,
      source: includeProviderUsage ? (additionalInputEstimate > 0 ? 'provider+estimate' : 'provider') : 'estimate',
    };
  }

  private async runToolBatch(thread: Thread, activeBatch: { batchId: string; calls: ToolCall[] }): Promise<void> {
    const threadId = thread.id;
    // The Model Step already committed these calls. Batch plugins may reschedule them,
    // but must not silently change a canonical call's identity or arguments.
    const canonicalCalls = deepFreeze(structuredClone(activeBatch.calls));
    const callsById = new Map(canonicalCalls.map((call) => [call.id, call]));
    const batchInput: ToolBatchInput = {
      thread,
      batchId: activeBatch.batchId,
      calls: canonicalCalls,
      execute: (call) => {
        const canonical = callsById.get(call.id);
        if (
          !canonical ||
          canonical.name !== call.name ||
          JSON.stringify(canonical.arguments) !== JSON.stringify(call.arguments)
        ) {
          throw new Error(
            'Tool Batch plugins may reschedule calls but must preserve each call ID, name, and arguments.',
          );
        }
        return this.executeToolCall(thread, canonical);
      },
    };
    const batchResult = await this.pipelines.run<ToolBatchInput, Execution[]>('toolBatch', batchInput, (input) =>
      Promise.all(input.calls.map((call) => input.execute(call))),
    );
    const batchExecutions = this.persistToolBatchResult(threadId, activeBatch.batchId, batchResult);
    if (batchExecutions.length !== activeBatch.calls.length) {
      throw new Error(`Tool Batch ${activeBatch.batchId} does not have one durable Execution per Tool Call.`);
    }
    const activeExecutions = batchExecutions.filter(
      (execution) => execution.status === 'pending' || execution.status === 'running',
    );
    if (activeExecutions.length > 0) {
      if (!this.shuttingDown && !this.store.getThread(threadId)?.pauseRequested) {
        this.store.setPause(
          threadId,
          true,
          `Tool Batch returned with ${activeExecutions.length} execution(s) still pending or running. Execution state is preserved.`,
        );
      }
      this.publishThreadUpdate(threadId);
      return;
    }
    for (const execution of batchExecutions) this.ensureToolResult(threadId, execution);
  }

  private persistToolBatchResult(threadId: string, batchId: string, reported: Execution[]): Execution[] {
    if (!Array.isArray(reported)) throw new Error(`Tool Batch ${batchId} must return an array of Execution results.`);
    const executions = this.store.listExecutionsByBatch(batchId);
    const byId = new Map(executions.map((execution) => [execution.id, execution]));
    const reportedIds = new Set<string>();
    for (const result of reported) {
      if (!result || typeof result.id !== 'string' || reportedIds.has(result.id)) {
        throw new Error(`Tool Batch ${batchId} returned an invalid or duplicate Execution result.`);
      }
      reportedIds.add(result.id);
      const current = byId.get(result.id);
      if (
        !current ||
        current.threadId !== threadId ||
        current.batchId !== batchId ||
        current.kind !== 'tool' ||
        result.threadId !== threadId ||
        result.batchId !== batchId ||
        result.kind !== 'tool' ||
        result.toolName !== current.toolName ||
        JSON.stringify(result.arguments) !== JSON.stringify(current.arguments)
      ) {
        throw new Error(`Tool Batch ${batchId} returned an Execution outside its durable batch.`);
      }
      if (!['pending', 'running', 'completed', 'failed', 'interrupted'].includes(result.status)) {
        throw new Error(`Tool Batch ${batchId} returned an invalid Execution status.`);
      }
      if (terminalStatus(current.status) || result.status === 'pending' || current.status === result.status) continue;
      const updated = this.store.transitionExecution(current.id, result.status, {
        result: sanitizeMultimodalResultValue(result.result ?? null),
        ...(result.error ? { error: result.error } : {}),
        detail: { source: 'tool-batch-pipeline' },
      });
      byId.set(updated.id, updated);
      this.executionChanged(updated);
    }
    const persisted = this.store.listExecutionsByBatch(batchId);
    for (const execution of persisted) this.ensureToolResult(threadId, execution);
    return persisted;
  }

  private latestActiveBatch(threadId: string): { batchId: string; calls: ToolCall[] } | null {
    const latest = this.store.modelOutputForThread(threadId);
    const payload = latest?.payload;
    if (!payload?.batchId || payload.toolCalls.length === 0) return null;
    const executions = this.store.listExecutionsByBatch(payload.batchId);
    if (executions.length !== payload.toolCalls.length) return null;
    const needsRepair = executions.some(
      (execution) => terminalStatus(execution.status) && !this.store.hasToolResult(execution.id),
    );
    const active = executions.some((execution) => execution.status === 'pending' || execution.status === 'running');
    return needsRepair || active ? { batchId: payload.batchId, calls: payload.toolCalls } : null;
  }

  private disabledThreadToolNames(threadId: string): string[] {
    return this.allDisabledThreadTools()[threadId] ?? [];
  }

  private allDisabledThreadTools(): Record<string, string[]> {
    const stored = this.store.getSetting<unknown>(DISABLED_THREAD_TOOLS_SETTING, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).flatMap(([threadId, names]) =>
        Array.isArray(names)
          ? [[threadId, [...new Set(names.filter((name): name is string => typeof name === 'string'))]]]
          : [],
      ),
    );
  }

  private readCachedThreadToolSurface(threadId: string): StoredThreadToolSurface | null {
    const stored = this.store.getSetting<unknown>(THREAD_TOOL_SURFACES_SETTING, {});
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
    const cached = (stored as Record<string, unknown>)[threadId];
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null;
    const value = cached as Record<string, unknown>;
    if (
      !Array.isArray(value.tools) ||
      !value.sources ||
      typeof value.sources !== 'object' ||
      Array.isArray(value.sources)
    )
      return null;
    const tools = value.tools.filter((tool): tool is ToolDefinition => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const definition = tool as Partial<ToolDefinition>;
      return (
        typeof definition.name === 'string' &&
        typeof definition.description === 'string' &&
        Boolean(
          definition.parameters && typeof definition.parameters === 'object' && !Array.isArray(definition.parameters),
        )
      );
    });
    const sourceEntries = Object.entries(value.sources as Record<string, unknown>).filter(
      (entry): entry is [string, 'runtime' | 'executor'] => entry[1] === 'runtime' || entry[1] === 'executor',
    );
    return { tools, sources: Object.fromEntries(sourceEntries) };
  }

  private cacheThreadToolSurface(
    threadId: string,
    surface: { tools: ToolDefinition[]; sources: Record<string, 'runtime' | 'executor'> },
  ): void {
    const stored = this.store.getSetting<unknown>(THREAD_TOOL_SURFACES_SETTING, {});
    const cache = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    this.store.setSetting(THREAD_TOOL_SURFACES_SETTING, {
      ...(cache as Record<string, unknown>),
      [threadId]: structuredClone(surface),
    });
  }

  private needsModelStep(threadId: string): boolean {
    const latestAssistant = this.store.modelOutputForThread(threadId);
    if (!latestAssistant) return this.store.hasMessage(threadId) || this.plugins.hasPendingPluginWork(threadId);
    if (latestAssistant.payload.toolCalls.length > 0) {
      const executions = this.store.listExecutionsByBatch(latestAssistant.payload.batchId ?? '');
      return (
        executions.length === latestAssistant.payload.toolCalls.length &&
        executions.every((execution) => terminalStatus(execution.status) && this.store.hasToolResult(execution.id))
      );
    }
    return (
      this.store.hasMessageAfter(threadId, latestAssistant.payload.projectionThrough) ||
      this.plugins.hasPendingPluginWork(threadId)
    );
  }

  private pendingModelRetry(threadId: string): Execution | null {
    return (
      this.store
        .listActiveExecutions(threadId)
        .find(
          (execution) =>
            execution.kind === 'model' &&
            execution.status === 'pending' &&
            typeof execution.arguments?.retryOf === 'string',
        ) ?? null
    );
  }

  private hasUnprocessedWork(threadId: string): boolean {
    return Boolean(
      this.latestActiveBatch(threadId) || this.pendingModelRetry(threadId) || this.needsModelStep(threadId),
    );
  }

  private recoverOrphanedModelExecutions(
    threadId: string,
    recoveryPoint: 'continue' | 'interrupt' | 'loop-exit' | 'loop-start' | 'plugin-resume' | 'retry',
  ): Execution[] {
    const pendingRetryId = this.pendingModelRetry(threadId)?.id;
    const orphaned = this.store
      .listActiveExecutions(threadId)
      .filter(
        (execution) =>
          execution.kind === 'model' && execution.id !== pendingRetryId && !this.modelSignals.has(execution.id),
      );
    const recovered: Execution[] = [];

    for (const execution of orphaned) {
      try {
        const current = this.store.getExecution(execution.id);
        if (!current || terminalStatus(current.status)) continue;
        const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
          error: 'Runtime found an unfinished Model Execution without a live local model request.',
          detail: { orphanedModelExecution: true, recoveryPoint },
        });
        recovered.push(interrupted);
        this.executionChanged(interrupted);
      } catch (error) {
        this.publish({
          type: 'runtime.error',
          threadId,
          executionId: execution.id,
          message: `Could not recover an orphaned Model Execution: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return recovered;
  }

  private resolveModelSettings(selection: ThreadModelSelection): ModelSettings {
    if (selection.connectionId !== 'default')
      throw new Error(`Model connection "${selection.connectionId}" is unavailable.`);
    if (!selection.model.trim()) {
      throw new Error('No model is configured for this Thread. Choose a model in the composer or Settings.');
    }
    const configured = this.getModelSettings();
    return {
      ...configured,
      provider: selection.provider,
      model: selection.model,
      temperature: selection.parameters.temperature ?? defaultModelSettings.temperature,
      ...(configured.provider === selection.provider ? {} : { baseUrl: '', apiKey: '' }),
    };
  }

  /** Shared model-stage kernel for primary and plugin-owned auxiliary operations. */
  private async invokeModel(input: ModelStageInput, settings: ModelSettings): Promise<ModelResponse> {
    try {
      return await raceWithAbort(
        this.pipelines.run<ModelStageInput, ModelResponse>('model', input, async (candidate) => {
          const target = candidate.modelTarget ?? {
            provider: candidate.provider,
            connectionId: 'default',
            baseUrl: settings.baseUrl,
            model: candidate.prompt.model,
          };
          if (candidate.provider !== target.provider) throw new ModelCallError('target-mismatch');
          if ((target.connectionId ?? 'default') !== 'default') {
            throw new ModelCallError('connection-unavailable');
          }
          const semanticOptions = candidate.selectionParameters?.options ?? {};
          if (Object.values(semanticOptions).some((value) => value === null)) {
            throw new ModelCallError('invalid-options');
          }
          try {
            this.modelProviderRegistry.normalizeSelection(
              {
                provider: target.provider,
                connectionId: target.connectionId ?? 'default',
                model: target.model ?? candidate.prompt.model,
                baseUrl: target.baseUrl,
              },
              semanticOptions,
            );
          } catch {
            throw new ModelCallError('unsupported-parameters');
          }
          if (!this.modelProviderRegistry.has(target.provider)) {
            throw new ModelCallError('provider-unavailable');
          }
          const prompt =
            target.model === candidate.prompt.model ? candidate.prompt : { ...candidate.prompt, model: target.model };
          const requestParameters = candidate.requestParameters ?? { fields: {} };
          const finalInput: ModelStageInput = {
            ...candidate,
            provider: target.provider,
            modelTarget: { ...target },
            prompt,
            requestParameters,
          };
          finalInput.recordModelInput(prompt, target.provider, finalInput.projectionProvenance);
          const resolvedSettings: ModelSettings = {
            ...settings,
            provider: target.provider,
            baseUrl: target.baseUrl,
            model: target.model,
            temperature: requestParameters.temperature ?? prompt.temperature,
            ...(target.provider === settings.provider &&
            (target.connectionId ?? 'default') === 'default' &&
            target.baseUrl.replace(/\/+$/, '') === settings.baseUrl.replace(/\/+$/, '')
              ? {}
              : { apiKey: '' }),
          };
          const endpoint = diagnosticEndpoint(target.baseUrl);
          const invocationId =
            candidate.invocationId ??
            (candidate.pluginModelCall
              ? `plugin:${candidate.pluginModelCall.pluginId}:${candidate.pluginModelCall.idempotencyKey ?? candidate.pluginModelCall.purpose}`
              : randomUUID());
          this.store.recordModelInvocation(candidate.thread.id, invocationId, {
            ...(candidate.pluginModelCall
              ? { pluginModelCall: candidate.pluginModelCall }
              : { executionId: invocationId }),
            provider: target.provider,
            connectionId: target.connectionId ?? 'default',
            endpoint,
            model: target.model,
            requestParameters: structuredClone(requestParameters),
          });
          Object.freeze(finalInput.modelTarget);
          Object.freeze(finalInput.requestParameters);
          Object.freeze(resolvedSettings);
          return this.modelProviderRegistry.dispatch(finalInput, resolvedSettings);
        }),
        input.signal,
      );
    } catch (error) {
      throw sanitizeModelCallError(error, input.signal);
    }
  }

  private async runModelStep(
    thread: Thread,
    retryExecution?: Execution,
    preparedProjection?: ProjectionInput,
  ): Promise<void> {
    const allRecords = this.store.listRecords(thread.id);
    const retryThrough = retryExecution ? modelExecutionProjectionThrough(retryExecution) : null;
    if (retryExecution && retryThrough === null) {
      const failed = this.store.transitionExecution(retryExecution.id, 'failed', {
        error: 'Retry attempt lost its projection boundary.',
      });
      this.executionChanged(failed);
      return;
    }
    const through = preparedProjection?.through ?? retryThrough ?? allRecords.at(-1)?.seq ?? 0;
    const projectionRecords =
      preparedProjection?.records ??
      allRecords.filter((record) => record.seq <= through).map((record) => deepFreeze(record));
    const modelExecutionId = retryExecution?.id ?? randomUUID();
    const modelSelection = this.threadModelSelection(thread.id);
    const modelSettings = this.resolveModelSettings(modelSelection);
    if (!retryExecution) {
      this.store.createModelExecution(modelExecutionId, thread.id, through, undefined, modelSettings.model);
    }
    const identified = this.store.setModelExecutionModel(modelExecutionId, modelSettings.model);
    this.executionChanged(identified);
    const running = this.store.transitionExecution(modelExecutionId, 'running');
    this.executionChanged(running);
    const controller = new AbortController();
    this.modelSignals.set(modelExecutionId, controller);
    let latestDraft = '';
    try {
      const ignoredLegacyFields = projectionRecords.flatMap((record) => {
        if (record.kind !== 'assistant') return [];
        const payload = objectValue(record.payload);
        return payload && Object.hasOwn(payload, 'reasoningFormat')
          ? [{ recordId: record.id, field: 'reasoningFormat' }]
          : [];
      });
      if (ignoredLegacyFields.length > 0) {
        this.appendExecutionDiagnostic(modelExecutionId, 'model-input-incompatible-fields-ignored', {
          records: ignoredLegacyFields,
        });
      }
      const projected = preparedProjection ?? (await this.projectModelInput(thread, projectionRecords, through));
      const projectedTools = projected.tools;
      const prompt: ModelPrompt = {
        system: projected.systemPrompt,
        turns: projected.turns,
        tools: projectedTools,
        model: modelSelection.model,
        temperature: modelSelection.parameters.temperature ?? defaultModelSettings.temperature,
      };
      let requestId: string | null = null;
      let actualProvider = modelSelection.provider;
      const recordModelInput: ModelStageInput['recordModelInput'] = (actualPrompt, provider, provenance) => {
        if (controller.signal.aborted) return;
        if (requestId) return;
        actualProvider = provider;
        this.executionChanged(this.store.setModelExecutionModel(modelExecutionId, actualPrompt.model));
        requestId = randomUUID();
        const prompt = modelInputPromptSnapshotForDiagnostics(actualPrompt);
        const promptSummary = promptSummaryForDiagnostics(actualPrompt);
        const modelInputRecord = this.store.appendPluginRecord(thread.id, 'pico.runtime', {
          action: 'model-input-recorded',
          executionId: modelExecutionId,
          requestId,
          prompt,
          promptSummary,
          projectionProvenance: structuredClone(provenance ?? projected.provenance ?? []),
        });
        this.appendExecutionDiagnostic(modelExecutionId, 'model-input-requested', {
          requestId,
          modelInputRecordId: modelInputRecord.id,
        });
      };
      const requestTrace: ModelRequestTrace = {
        started: (details) => {
          const providerAttemptId = randomUUID();
          if (controller.signal.aborted) return providerAttemptId;
          recordModelInput(prompt, details.provider, projected.provenance);
          this.appendExecutionDiagnostic(modelExecutionId, 'provider-request-started', {
            requestId,
            providerAttemptId,
            ...sanitizeRequestStart(details),
          });
          return providerAttemptId;
        },
        response: (providerAttemptId, details) => {
          if (controller.signal.aborted || !requestId || !providerAttemptId) return;
          this.appendExecutionDiagnostic(modelExecutionId, 'provider-request-response', {
            requestId,
            providerAttemptId,
            ...sanitizeRequestResponse(details),
          });
        },
        settled: (providerAttemptId, details) => {
          if (controller.signal.aborted || !requestId || !providerAttemptId) return;
          this.appendExecutionDiagnostic(modelExecutionId, 'provider-request-settled', {
            requestId,
            providerAttemptId,
            ...sanitizeRequestSummary(details),
          });
        },
      };
      const modelInput: ModelStageInput = {
        thread,
        invocationId: modelExecutionId,
        provider: actualProvider,
        modelTarget: {
          provider: modelSelection.provider,
          connectionId: modelSelection.connectionId,
          baseUrl: modelSettings.baseUrl,
          model: prompt.model,
        },
        requestParameters: {
          ...(modelSelection.parameters.temperature === undefined
            ? {}
            : { temperature: modelSelection.parameters.temperature }),
          fields: {},
        },
        selectionParameters: structuredClone(modelSelection.parameters),
        prompt,
        signal: controller.signal,
        onText: (delta: string) => {
          if (controller.signal.aborted) return;
          latestDraft += delta;
          this.publish({ type: 'model.delta', threadId: thread.id, executionId: modelExecutionId, delta });
        },
        onEvent: (event) => {
          if (controller.signal.aborted) return;
          this.publish({ ...event, type: `model.${event.type}`, threadId: thread.id, executionId: modelExecutionId });
        },
        recordModelInput,
        ...(projected.provenance ? { projectionProvenance: projected.provenance } : {}),
        requestTrace,
      };
      let response: ModelResponse;
      try {
        const hasImageInput = prompt.turns.some((turn) => turn.kind === 'tool_result' && Boolean(turn.images?.length));
        const providerSupportsImages = this.modelProviderRegistry
          .list()
          .find((provider) => provider.id === modelSelection.provider)?.supportsImages;
        if (hasImageInput && providerSupportsImages !== true) {
          throw new Error(
            `Model provider "${modelSelection.provider}" does not support image inputs; images were not sent.`,
          );
        }
        response = await this.invokeModel(modelInput, modelSettings);
        if (requestId)
          this.appendExecutionDiagnostic(modelExecutionId, 'model-input-settled', {
            requestId,
            status: 'completed',
            result: {
              textCharacters: response.content.length,
              toolCallCount: response.toolCalls.length,
              finishReason: response.finishReason === null ? null : (diagnosticLabel(response.finishReason) ?? null),
              usage: diagnosticUsage(response.usage),
              empty: response.content.trim().length === 0 && response.toolCalls.length === 0,
            } satisfies ModelInputResultSummary,
          });
      } catch (error) {
        if (requestId)
          this.appendExecutionDiagnostic(modelExecutionId, 'model-input-settled', {
            requestId,
            status: controller.signal.aborted ? 'interrupted' : 'failed',
            error: safeModelError(error, controller.signal.aborted),
            partialOutputCharacters: latestDraft.length,
          });
        throw error;
      }
      if (thread.executorKind === 'runtime') {
        const exposedTools = new Set(projectedTools.map((tool) => tool.name));
        const unavailableCalls = response.toolCalls.filter((call) => !exposedTools.has(call.name));
        if (unavailableCalls.length > 0) {
          throw new Error(
            `Chat mode cannot run unavailable tools: ${unavailableCalls.map((call) => call.name).join(', ')}.`,
          );
        }
      }
      const hitOutputLimit = response.finishReason === 'length';
      const seenCallIds = new Set<string>();
      const calls = (hitOutputLimit ? [] : response.toolCalls).map((call, index) => {
        const proposed = call.id.trim();
        const id = proposed && !seenCallIds.has(proposed) ? proposed : `${modelExecutionId}:tool:${index}`;
        seenCallIds.add(id);
        return { ...call, id };
      });
      const batchId = calls.length > 0 ? `${modelExecutionId}:batch` : null;
      const payload: AssistantPayload = {
        content: response.content,
        provider: actualProvider,
        ...(response.reasoningSummary ? { reasoningSummary: response.reasoningSummary } : {}),
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        ...(response.reasoningReplay === undefined ? {} : { reasoningReplay: response.reasoningReplay }),
        toolCalls: calls,
        batchId,
        projectionThrough: through,
        usage: response.usage,
        model: response.model,
        finishReason: response.finishReason,
      };
      const toolExecutions = calls.map((call) => ({
        call,
        executionId: `${thread.id}:${modelExecutionId}:${call.id}`,
      }));
      this.store.commitModelStep({
        assistantRecordId: `${modelExecutionId}:assistant`,
        modelExecutionId,
        threadId: thread.id,
        payload,
        toolCalls: toolExecutions,
      });
      if (hitOutputLimit && !this.store.getThread(thread.id)?.pauseRequested) {
        this.store.setPause(
          thread.id,
          true,
          'The model reached its output token limit. Review the response, adjust the model or context, then Continue.',
        );
      }
      const committedModelExecution = this.store.getExecution(modelExecutionId);
      if (committedModelExecution) this.executionChanged(committedModelExecution);
      for (const item of toolExecutions) {
        const execution = this.store.getExecution(item.executionId);
        if (execution) this.executionChanged(execution);
      }
    } catch (error) {
      const current = this.store.getExecution(modelExecutionId);
      const interrupted = controller.signal.aborted;
      if (current && !terminalStatus(current.status)) {
        const settled = this.store.transitionExecution(modelExecutionId, interrupted ? 'interrupted' : 'failed', {
          error: error instanceof Error ? error.message : String(error),
          detail: { partialOutputDiscarded: latestDraft.length > 0 },
        });
        this.executionChanged(settled);
      }
      this.publish({ type: 'model.draft-ended', threadId: thread.id, executionId: modelExecutionId });
      if (!interrupted) {
        const reason = error instanceof Error ? error.message : String(error);
        this.store.setPause(thread.id, true, 'Model step failed. Continue this Thread to start a new attempt.');
        this.publish({
          type: 'runtime.error',
          threadId: thread.id,
          executionId: modelExecutionId,
          source: 'model-execution',
          message: reason,
        });
      }
    } finally {
      this.modelSignals.delete(modelExecutionId);
    }
  }

  private projectTurns(records: readonly CanonicalRecord[], thread: Thread): PromptTurn[] {
    const compaction = activeRuntimeContextCompaction(records);
    if (!compaction) return canonicalRecordsToPromptTurns(records, thread);
    const remaining = canonicalConversationRecords(records).filter((record) => record.seq > compaction.throughSeq);
    return [runtimeCompactionTurn(compaction), ...canonicalRecordsToPromptTurns(remaining, thread)];
  }

  private async compactThread(
    thread: Thread | null,
    allowActiveLoop = false,
    rebuildFromCanonical = false,
    projectedInput?: ProjectionInput,
  ): Promise<CommandResult> {
    if (!thread) return { text: 'Choose a Thread first.', severity: 'error' };
    const inFlightOperations = this.inFlightThreadOperations.get(thread.id) ?? 0;
    const hasRunningModelCall = this.store
      .listPluginModelCalls({ threadId: thread.id })
      .some((call) => call.status === 'running');
    if (
      (!allowActiveLoop && thread.state === 'running') ||
      thread.state === 'pausing' ||
      (!allowActiveLoop && this.loops.has(thread.id)) ||
      this.store.listActiveExecutions(thread.id).length > 0 ||
      inFlightOperations > 1 ||
      hasRunningModelCall
    ) {
      return { text: 'Wait for the Thread to reach a safe idle boundary before compacting.', severity: 'error' };
    }

    const records = this.store.listRecords(thread.id);
    const conversation = canonicalConversationRecords(records);
    const previous = activeRuntimeContextCompaction(records);
    const previousThroughSeq = rebuildFromCanonical ? 0 : (previous?.throughSeq ?? 0);
    const keepRecentTokens = this.getContextManagementSettings().keepRecentTokens;
    const completed = completedCanonicalModelInvocationBlocks(conversation).filter(
      (block) => (block.at(-1)?.seq ?? 0) > previousThroughSeq,
    );
    const recent: CanonicalRecord[][] = [];
    let recentTokenEstimate = 0;
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const block = completed[index]!;
      recent.unshift(block);
      recentTokenEstimate = Math.min(
        keepRecentTokens,
        recentTokenEstimate +
          compactionBlockTokenEstimate(block, index > 0 ? completed[index - 1] : undefined, thread, keepRecentTokens),
      );
      if (recent.length >= RUNTIME_COMPACTION_MIN_RECENT_TURNS && recentTokenEstimate >= keepRecentTokens) break;
    }
    const eligible = completed.slice(0, completed.length - recent.length);
    if (eligible.length === 0) {
      return {
        text:
          completed.length === 0
            ? 'There are no completed model invocations to compact yet.'
            : `No older model invocations fall outside the recent-history budget yet. The latest ${recent.length} completed invocation(s) stay verbatim (target: ${keepRecentTokens.toLocaleString()} tokens).`,
        severity: 'error',
      };
    }

    const candidateThroughSeq = eligible.at(-1)!.at(-1)!.seq;
    const projectedPrefix = projectedInput
      ? projectedCompactionPrefix(records, thread, projectedInput, candidateThroughSeq)
      : null;
    if (projectedInput && !projectedPrefix) {
      return {
        text: 'Nothing was compacted: the completed invocation boundary could not be mapped safely to the projected Model Input.',
        severity: 'error',
      };
    }
    const throughSeq = projectedPrefix?.throughSeq ?? candidateThroughSeq;
    const summarizedBlocks = eligible.filter((block) => (block.at(-1)?.seq ?? 0) <= throughSeq);
    if (summarizedBlocks.length === 0) {
      return {
        text: 'Nothing was compacted: the projected history groups the eligible invocations with the recent context.',
        severity: 'error',
      };
    }
    const sourceRecords = conversation.filter((record) => record.seq <= throughSeq);
    const canonicalHash = canonicalSourceHash(sourceRecords);
    const sourceHash = projectedPrefix
      ? createHash('sha256').update(canonicalHash).update(JSON.stringify(projectedPrefix.turns)).digest('hex')
      : canonicalHash;
    const sourceText = [
      ...(!rebuildFromCanonical && previous
        ? [`Existing summary through Canonical seq ${previous.throughSeq}:\n${previous.summary}`]
        : []),
      ...summarizedBlocks.map(
        (block) =>
          `New Canonical model invocation:\n${JSON.stringify({
            canonicalSeqs: block.map((record) => record.seq),
            turns: canonicalBlockToPromptTurns(block, thread),
          })}`,
      ),
    ].join('\n\n');

    const prompt: ModelPrompt = {
      system:
        "You are Pico Runtime's conversation compaction helper. Produce a concise, reliable working summary for continuing this same conversation. Preserve the user's goals and explicit constraints, verified facts and their Canonical sequence references, decisions and reasons, unresolved questions, failures, and next actions. Clearly mark uncertainty and never invent facts. Summarize the supplied projected conversation, which reflects the context that the main Model Input would receive. Return plain text only.",
      turns: projectedPrefix
        ? [
            {
              kind: 'message',
              role: 'user',
              content: `Summarize projected history through Canonical seq ${throughSeq}. Preserve relevant source sequence references.`,
            },
            ...projectedPrefix.turns,
          ]
        : [{ kind: 'message', role: 'user', content: sourceText }],
      tools: [],
      model: this.threadModelSelection(thread.id).model,
      temperature: 0,
    };

    const baseCallKey = `runtime-compact:${sourceHash}`;
    const priorCalls = this.store
      .listPluginModelCalls({ pluginId: 'pico.runtime', threadId: thread.id })
      .filter(
        (call) =>
          call.purpose === 'runtime-compaction-summary' &&
          (call.idempotencyKey === baseCallKey || call.idempotencyKey.startsWith(`${baseCallKey}:retry:`)),
      );
    const latestCall = priorCalls.at(-1);
    const previousResponse = latestCall?.response as { content?: unknown } | null;
    const previousToolCalls = (latestCall?.response as { toolCalls?: unknown } | null)?.toolCalls;
    const latestContent = typeof previousResponse?.content === 'string' ? previousResponse.content.trim() : '';
    const latestIsUsable =
      latestCall?.status === 'completed' &&
      latestContent.length > 0 &&
      latestContent.length <= RUNTIME_COMPACTION_MAX_SUMMARY_CHARS &&
      Array.isArray(previousToolCalls) &&
      previousToolCalls.length === 0;
    const idempotencyKey =
      latestIsUsable || latestCall?.status === 'running'
        ? latestCall!.idempotencyKey
        : latestCall && (latestCall.status !== 'completed' || !latestIsUsable)
          ? `${baseCallKey}:retry:${priorCalls.length}`
          : baseCallKey;
    this.publish({ type: 'runtime.compaction', threadId: thread.id, status: 'started' });
    let compactionSaved = false;
    try {
      const call = await this.completePluginModelCall('pico.runtime', {
        threadId: thread.id,
        projectId: thread.projectId,
        purpose: 'runtime-compaction-summary',
        idempotencyKey,
        prompt,
        requestParameters: { temperature: 0, fields: {} },
      });
      const summary = call.response.content.trim();
      if (!summary || summary.length > RUNTIME_COMPACTION_MAX_SUMMARY_CHARS || call.response.toolCalls.length > 0) {
        return {
          text: `The model did not return a usable compaction summary. No history was changed; retry /compact after checking the selected model.`,
          severity: 'error',
        };
      }

      if (rebuildFromCanonical && previous) {
        this.store.appendCanonical(thread.id, `pico:runtime-compaction-reset:${previous.sourceHash}`, 'plugin', {
          pluginId: 'pico.runtime',
          action: 'context-compaction-reset',
          version: 1,
          resetThroughSeq: previous.throughSeq,
          resetSourceHash: previous.sourceHash,
        });
      }
      this.store.appendCanonical(thread.id, `pico:runtime-compaction:${sourceHash}`, 'plugin', {
        pluginId: 'pico.runtime',
        action: 'context-compacted',
        version: 1,
        throughSeq,
        sourceRecordIds: sourceRecords.map((record) => record.id),
        sourceHash,
        summary,
        model: call.model,
      });
      compactionSaved = true;
      if (rebuildFromCanonical && previous) this.publishThreadUpdate(thread.id);
      return {
        text: `Compacted ${summarizedBlocks.length} completed model invocation(s) through Canonical seq ${throughSeq}. Canonical History is preserved, and the latest ${recent.length} invocation(s) remain verbatim (target: ${keepRecentTokens.toLocaleString()} tokens).`,
        presentation: 'timeline',
      };
    } finally {
      this.publish({
        type: 'runtime.compaction',
        threadId: thread.id,
        status: compactionSaved ? 'completed' : 'failed',
      });
    }
  }

  private async toolSurfaceFor(thread: Thread): Promise<{
    tools: ToolDefinition[];
    sources: Record<string, 'runtime' | 'executor'>;
  }> {
    const runtimeTools = this.tools.listBySource('runtime').map((tool) => tool.definition);
    const tools = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const sources: Record<string, 'runtime' | 'executor'> = Object.fromEntries(
      runtimeTools.map((tool) => [tool.name, 'runtime']),
    );
    if (thread.executorKind === 'runtime') {
      const surface = { tools: [...tools.values()], sources };
      this.cacheThreadToolSurface(thread.id, surface);
      return surface;
    }

    const binding = this.store.executorForThread(thread.id);
    if (!binding) throw new Error('Executor binding is missing while discovering its Tools.');
    const adapter = this.adapterFor(binding);
    for (const definition of await adapter.listTools(binding)) {
      if (tools.has(definition.name)) {
        throw new Error(
          `Tool name collision: ${definition.name} is registered by both Runtime and ${binding.label} Executor sources.`,
        );
      }
      tools.set(definition.name, definition);
      sources[definition.name] = 'executor';
    }
    const surface = { tools: [...tools.values()], sources };
    this.cacheThreadToolSurface(thread.id, surface);
    return surface;
  }

  private async executeToolCall(thread: Thread, call: ToolCall): Promise<Execution> {
    const assistant = this.store.modelOutputForThread(thread.id);
    if (!assistant) throw new Error('Tool call has no committed Model Step');
    const executionId = `${thread.id}:${assistant.id.replace(/:assistant$/, '')}:${call.id}`;
    let execution = this.store.getExecution(executionId);
    if (!execution) throw new Error(`Tool execution ${executionId} was not durably prepared`);
    if (terminalStatus(execution.status)) {
      this.ensureToolResult(thread.id, execution);
      return execution;
    }
    const registered = this.tools.get(call.name);
    const controller = new AbortController();
    const run = { promise: Promise.resolve(execution), controller, toolStarted: false };
    const input: ToolInvocationInput = {
      thread,
      call,
      executionId,
      signal: controller.signal,
      toolSource: registered?.source ?? (thread.executorKind === 'runtime' ? 'runtime' : 'executor'),
      fail: async (reason, result) => {
        const current = this.store.getExecution(executionId);
        if (!current) throw new Error(`Tool Execution ${executionId} disappeared before it could fail.`);
        if (terminalStatus(current.status)) return current;
        const failed = this.store.transitionExecution(executionId, 'failed', {
          error: reason,
          ...(result === undefined ? {} : { result: sanitizeMultimodalResultValue(result) }),
        });
        if (!failed) throw new Error(`Tool Execution ${executionId} could not be failed.`);
        this.executionChanged(failed);
        return failed;
      },
      invoke: () => {
        run.toolStarted = true;
        return this.invokeTool(thread, executionId, registered, call, controller.signal);
      },
    };
    const promise = (async (): Promise<Execution> => {
      try {
        execution = this.disabledThreadToolNames(thread.id).includes(call.name)
          ? await input.fail(`Tool “${call.name}” is disabled in this Thread.`, { disabled: true })
          : await this.pipelines.run('toolInvocation', input, async (value) => value.invoke());
      } catch (error) {
        const latest = this.store.getExecution(executionId);
        if (!latest) throw error;
        if (!terminalStatus(latest.status) && !run.toolStarted && controller.signal.aborted) {
          if (!(error instanceof Error) || error.name !== 'AbortError') {
            execution = latest;
            throw error;
          }
          execution = this.store.transitionExecution(executionId, 'interrupted', {
            error: error instanceof Error ? error.message : 'Tool invocation interrupted.',
            detail: { userInterrupted: true },
          });
          this.executionChanged(execution);
        } else if (!terminalStatus(latest.status) && !run.toolStarted) {
          execution = this.store.transitionExecution(executionId, 'failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.executionChanged(execution);
        } else {
          execution = latest;
          if (!terminalStatus(latest.status)) {
            const detail = error instanceof Error ? error.message : String(error);
            execution = this.store.recordExecutionError(
              executionId,
              `${detail}\n\nThe Executor did not confirm an outcome. Side effects may be partial or unknown; inspect before retrying.`,
            );
            this.executionChanged(execution);
          }
        }
      }
      if (terminalStatus(execution.status)) this.ensureToolResult(thread.id, execution);
      return execution;
    })().finally(() => this.invocationRuns.delete(executionId));
    run.promise = promise;
    this.invocationRuns.set(executionId, run);
    return promise;
  }

  private async invokeTool(
    thread: Thread,
    executionId: string,
    tool: ReturnType<typeof this.tools.get>,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error('Tool execution record is missing');
    if (terminalStatus(current.status)) return current;
    if (tool?.source === 'executor' || (!tool && thread.executorKind !== 'runtime')) {
      const binding = this.store.executorForThread(thread.id);
      if (!binding) throw new Error('Executor binding is missing');
      return this.adapterFor(binding).execute(executionId, binding);
    }
    const inFlight = this.runtimeToolRuns.get(executionId);
    if (inFlight) return inFlight.promise;
    if (current.status === 'running') {
      const lost = this.store.transitionExecution(executionId, 'interrupted', {
        error: 'Runtime confirmed this control tool is no longer active. Its result may be incomplete.',
        detail: { confirmedMissing: true },
      });
      this.executionChanged(lost);
      return lost;
    }
    if (!tool) {
      const failed = this.store.transitionExecution(executionId, 'failed', { error: `Unknown tool: ${call.name}` });
      this.executionChanged(failed);
      return failed;
    }
    const controller = new AbortController();
    const abortRuntimeTool = (): void => controller.abort();
    signal.addEventListener('abort', abortRuntimeTool, { once: true });
    if (signal.aborted) controller.abort();
    const started = this.store.transitionExecution(executionId, 'running');
    this.executionChanged(started);
    const context: RuntimeToolContext = {
      workspacePath: thread.workspacePath,
      executionId,
      signal: controller.signal,
      thread,
    };
    const promise = (async () => {
      try {
        const result = await tool.execute(call.arguments, context);
        const completed = this.store.transitionExecution(executionId, 'completed', {
          result: sanitizeMultimodalResultValue(result),
        });
        this.executionChanged(completed);
        return completed;
      } catch (error) {
        const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        const failed = this.store.transitionExecution(executionId, interrupted ? 'interrupted' : 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.executionChanged(failed);
        return failed;
      }
    })().finally(() => {
      signal.removeEventListener('abort', abortRuntimeTool);
      this.runtimeToolRuns.delete(executionId);
    });
    this.runtimeToolRuns.set(executionId, { promise, controller });
    return promise;
  }

  private ensureToolResult(threadId: string, execution: Execution): void {
    if (!terminalStatus(execution.status) || this.store.hasToolResult(execution.id)) return;
    const modelExecutionId = execution.batchId?.replace(/:batch$/, '');
    const executionPrefix = modelExecutionId ? `${threadId}:${modelExecutionId}:` : '';
    const toolCallId =
      executionPrefix && execution.id.startsWith(executionPrefix)
        ? execution.id.slice(executionPrefix.length)
        : execution.id;
    const payload: ToolResultPayload = {
      executionId: execution.id,
      toolCallId,
      batchId: execution.batchId ?? '',
      toolName: execution.toolName ?? 'unknown',
      status: execution.status,
      ...(execution.result === null || execution.result === undefined ? {} : { result: execution.result }),
      ...(execution.status === 'completed' ? {} : { error: execution.error ?? 'Execution ended without a result.' }),
    };
    this.store.appendToolResult(threadId, payload);
  }

  private adapterFor(binding: ExecutorBinding): ExecutorAdapter {
    if (binding.remoteConnectionId) return this.remoteHostExecutor;
    if (binding.kind === 'runtime') throw new Error('Chat mode does not submit work to an external Executor.');
    return binding.kind === 'container' ? this.containerExecutor : this.hostExecutor;
  }

  private completePluginModelCall(
    pluginId: string,
    request: PluginModelCallRequest,
  ): Promise<PluginModelCallRecord & { response: ModelResponse }> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(request.purpose) || request.purpose.length > 80) {
      throw new Error('Plugin model call purpose must be a short stable identifier.');
    }
    if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 240) {
      throw new Error('Plugin model calls require a stable idempotency key.');
    }
    if (!request.threadId) throw new Error('Plugin model calls require a Thread context.');
    const thread = this.requireUnarchivedThread(request.threadId);
    if (request.projectId && request.projectId !== thread.projectId) {
      throw new Error('Plugin model call Project must match its Thread.');
    }
    if (
      !request.prompt ||
      typeof request.prompt.system !== 'string' ||
      !Array.isArray(request.prompt.turns) ||
      !Array.isArray(request.prompt.tools)
    ) {
      throw new Error('Plugin model call prompt is invalid.');
    }

    const selection = this.threadModelSelection(thread.id);
    const explicitTarget = request.modelTarget;
    const effectiveSelection: ThreadModelSelection = structuredClone({
      ...selection,
      ...(explicitTarget?.provider ? { provider: explicitTarget.provider } : {}),
      ...(explicitTarget?.connectionId ? { connectionId: explicitTarget.connectionId } : {}),
      ...(explicitTarget?.model ? { model: explicitTarget.model } : {}),
      parameters: selection.parameters,
    });
    const settings = Object.freeze({ ...this.resolveModelSettings(effectiveSelection) });
    const prompt: ModelPrompt = Object.freeze({
      ...structuredClone(request.prompt),
      model: effectiveSelection.model,
      temperature:
        request.requestParameters?.temperature ??
        effectiveSelection.parameters.temperature ??
        request.prompt.temperature,
    });
    const requestFingerprint = modelCallRequestFingerprint({
      threadId: thread.id,
      projectId: thread.projectId,
      purpose: request.purpose,
      prompt,
      effectiveSelection,
      explicitTarget: explicitTarget
        ? {
            provider: explicitTarget.provider ?? null,
            connectionId: explicitTarget.connectionId ?? null,
            model: explicitTarget.model ?? null,
          }
        : null,
      requestParameters: request.requestParameters ?? null,
    });
    const prepared: PreparedPluginModelCall = {
      effectiveSelection,
      settings,
      prompt,
      requestFingerprint,
    };

    const key = `${pluginId}:${request.idempotencyKey}`;
    const inFlight = this.pluginModelCallsInFlight.get(key);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new Error('Plugin model call idempotency key was reused for a different request.');
      }
      return inFlight.promise;
    }
    const prior = this.store.findPluginModelCall(pluginId, request.idempotencyKey);
    if (prior) {
      if (!prior.requestFingerprint) {
        throw new Error('Plugin model call request identity is unavailable; use a new idempotency key.');
      }
      if (prior.requestFingerprint !== requestFingerprint) {
        throw new Error('Plugin model call idempotency key was reused for a different request.');
      }
      if (prior.status === 'completed' && prior.response && typeof prior.response === 'object') {
        return Promise.resolve({ ...prior, response: prior.response as ModelResponse });
      }
      return Promise.reject(
        new Error(`Plugin model call ${prior.status}; use a new idempotency key to start a new attempt.`),
      );
    }

    const endOperation = this.beginThreadOperation(thread.id);
    const pending = this.runPluginModelCall(pluginId, thread, request, prepared);
    const entry = { requestFingerprint, promise: pending };
    this.pluginModelCallsInFlight.set(key, entry);
    return pending.finally(() => {
      if (this.pluginModelCallsInFlight.get(key) === entry) this.pluginModelCallsInFlight.delete(key);
      endOperation();
    });
  }

  private async runPluginModelCall(
    pluginId: string,
    thread: Thread,
    request: PluginModelCallRequest,
    prepared: PreparedPluginModelCall,
  ): Promise<PluginModelCallRecord & { response: ModelResponse }> {
    const { effectiveSelection, settings, prompt, requestFingerprint } = prepared;
    const now = new Date().toISOString();
    let call: PluginModelCallRecord = {
      id: randomUUID(),
      pluginId,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint,
      threadId: thread.id,
      projectId: thread.projectId,
      purpose: request.purpose,
      provider: effectiveSelection.provider,
      model: prompt.model,
      prompt,
      status: 'running',
      response: null,
      usage: null,
      attempts: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    call = this.store.savePluginModelCall(call);
    const controller = new AbortController();
    const abortFromRequest = (): void => controller.abort();
    request.signal?.addEventListener('abort', abortFromRequest, { once: true });
    if (request.signal?.aborted || this.shuttingDown) controller.abort();
    this.pluginModelCallControllers.add(controller);

    const save = (): void => {
      call = this.store.savePluginModelCall({ ...call, updatedAt: new Date().toISOString() });
    };
    const requestTrace: ModelRequestTrace = {
      started: (details) => {
        const id = randomUUID();
        call = {
          ...call,
          attempts: [...call.attempts, { id, ...details, outcome: 'running', createdAt: new Date().toISOString() }],
        };
        save();
        return id;
      },
      response: (id, details) => {
        call = {
          ...call,
          attempts: call.attempts.map((attempt) => (attempt.id === id ? { ...attempt, ...details } : attempt)),
        };
        save();
      },
      settled: (id, details) => {
        call = {
          ...call,
          attempts: call.attempts.map((attempt) => (attempt.id === id ? { ...attempt, ...details } : attempt)),
        };
        save();
      },
    };
    const recordModelInput = (actualPrompt: ModelPrompt, provider: string): void => {
      call = {
        ...call,
        prompt: structuredClone(promptForDiagnostics(actualPrompt)),
        provider,
        model: actualPrompt.model,
      };
      save();
    };
    const modelInput: ModelStageInput = {
      thread,
      provider: effectiveSelection.provider,
      modelTarget: {
        provider: effectiveSelection.provider,
        connectionId: effectiveSelection.connectionId,
        baseUrl: settings.baseUrl,
        model: prompt.model,
      },
      requestParameters: request.requestParameters
        ? validateModelParameters(request.requestParameters)
        : {
            ...(effectiveSelection.parameters.temperature === undefined
              ? {}
              : { temperature: effectiveSelection.parameters.temperature }),
            fields: {},
          },
      selectionParameters: structuredClone(effectiveSelection.parameters),
      pluginModelCall: { pluginId, purpose: request.purpose, idempotencyKey: request.idempotencyKey },
      invocationId: `plugin:${pluginId}:${request.idempotencyKey}`,
      prompt,
      signal: controller.signal,
      onText: () => undefined,
      ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      recordModelInput,
      requestTrace,
    };
    try {
      const response = await this.invokeModel(modelInput, settings);
      call = {
        ...call,
        status: 'completed',
        response,
        usage: response.usage,
        model: response.model || call.model,
        error: null,
      };
      save();
      return { ...call, response };
    } catch (error) {
      const interrupted = controller.signal.aborted;
      call = {
        ...call,
        status: interrupted ? 'interrupted' : 'failed',
        error: safeModelError(error, interrupted),
        attempts: call.attempts.map((attempt) =>
          attempt.outcome === 'running'
            ? {
                ...attempt,
                outcome: interrupted ? 'interrupted' : 'failed',
                errorCategory: interrupted ? 'aborted' : 'transport',
              }
            : attempt,
        ),
      };
      save();
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', abortFromRequest);
      this.pluginModelCallControllers.delete(controller);
    }
  }

  getModelSettings(): ModelSettings {
    const stored = this.store.getSetting<Record<string, unknown>>('model', {});
    return {
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : defaultModelSettings.baseUrl,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : defaultModelSettings.apiKey,
      model: typeof stored.model === 'string' ? stored.model : defaultModelSettings.model,
      temperature: typeof stored.temperature === 'number' ? stored.temperature : defaultModelSettings.temperature,
      provider: typeof stored.provider === 'string' ? stored.provider : defaultModelSettings.provider,
    };
  }

  private defaultThreadModelSelection(): ThreadModelSelection {
    const settings = this.getModelSettings();
    const base: ThreadModelSelection = {
      provider: settings.provider,
      connectionId: 'default',
      model: settings.model,
      parameters: { temperature: settings.temperature, options: {} },
    };
    const options = this.modelProviderRegistry.initialSelection({
      provider: base.provider,
      connectionId: base.connectionId,
      model: base.model,
      baseUrl: settings.baseUrl,
    });
    return this.validateThreadModelSelection({ ...base, parameters: { ...base.parameters, options } }, true);
  }

  threadModelSelection(threadId: string): ThreadModelSelection {
    if (!this.store.getThread(threadId)) throw new Error('Thread not found');
    return (
      this.store.getThreadModelSelection(threadId) ??
      this.store.setThreadModelSelection(threadId, this.defaultThreadModelSelection())
    );
  }

  updateThreadModelSelection(threadId: string, selection: ThreadModelSelection): ThreadModelSelection {
    if (!this.store.getThread(threadId)) throw new Error('Thread not found');
    const validated = this.validateThreadModelSelection(selection);
    const saved = this.store.setThreadModelSelection(threadId, validated);
    this.publish({ type: 'thread.model-selection.updated', threadId, selection: saved });
    return saved;
  }

  private validateThreadModelSelection(
    selection: ThreadModelSelection,
    allowUnconfiguredModel = false,
  ): ThreadModelSelection {
    if (!selection || typeof selection.provider !== 'string' || !this.modelProviderRegistry.has(selection.provider)) {
      throw new Error(`Model provider ${String(selection?.provider ?? '')} is unavailable.`);
    }
    if (selection.connectionId !== 'default')
      throw new Error('This Runtime only has the default model connection configured.');
    if (
      typeof selection.model !== 'string' ||
      (!allowUnconfiguredModel && !selection.model.trim()) ||
      selection.model.length > 240
    ) {
      throw new Error('A valid model name is required.');
    }
    const parameters = validateThreadSelectionParameters(selection.parameters);
    const modelSettings = selection.model.trim()
      ? this.resolveModelSettings({ ...selection, parameters })
      : this.getModelSettings();
    const options = this.modelProviderRegistry.normalizeSelection(
      {
        provider: selection.provider,
        connectionId: selection.connectionId,
        model: selection.model.trim(),
        baseUrl: modelSettings.baseUrl,
      },
      parameters.options,
    );
    return {
      provider: selection.provider,
      connectionId: selection.connectionId,
      model: selection.model.trim(),
      parameters: { ...parameters, options },
    };
  }

  publicModelSettings(): PublicSettings {
    const settings = this.getModelSettings();
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      provider: settings.provider,
      hasApiKey: Boolean(settings.apiKey),
      modelsByProvider: {
        ...this.store.getSetting<Record<string, string>>('provider-models', {}),
        [settings.provider]: settings.model,
      },
    };
  }

  updateModelSettings(update: Partial<ModelSettings>): PublicSettings {
    const current = this.getModelSettings();
    const provider = update.provider ?? current.provider;
    const providerModels = this.store.getSetting<Record<string, string>>('provider-models', {});
    const next = {
      ...current,
      ...(provider !== current.provider ? { model: providerModels[provider] ?? '' } : {}),
      ...update,
    };
    if (!this.plugins.modelProviders().some((provider) => provider.id === next.provider)) {
      throw new Error(`Model provider ${next.provider} is not registered.`);
    }
    if (next.provider === 'openai-compatible') {
      if (!next.baseUrl.trim()) throw new Error('Base URL is required');
      try {
        new URL(next.baseUrl);
      } catch {
        throw new Error('Base URL must be a valid http or https URL');
      }
      if (!/^https?:$/.test(new URL(next.baseUrl).protocol)) throw new Error('Base URL must use http or https');
    }
    if (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2) {
      throw new Error('Temperature must be between 0 and 2');
    }
    this.store.transaction(() => {
      this.store.setSetting('provider-models', {
        ...providerModels,
        [current.provider]: current.model,
        [next.provider]: next.model,
      });
      this.store.setSetting('model', next);
    });
    this.publish({ type: 'settings.updated', settings: this.publicModelSettings() });
    return this.publicModelSettings();
  }

  getContextManagementSettings(): ContextManagementSettings {
    const stored = objectValue(this.store.getSetting<unknown>('context-management', {})) ?? {};
    const contextWindowTokens =
      typeof stored.contextWindowTokens === 'number' &&
      Number.isSafeInteger(stored.contextWindowTokens) &&
      stored.contextWindowTokens > 0
        ? stored.contextWindowTokens
        : DEFAULT_CONTEXT_MANAGEMENT_SETTINGS.contextWindowTokens;
    const compactionThresholdTokens =
      typeof stored.compactionThresholdTokens === 'number' &&
      Number.isSafeInteger(stored.compactionThresholdTokens) &&
      stored.compactionThresholdTokens > 0
        ? stored.compactionThresholdTokens
        : DEFAULT_CONTEXT_MANAGEMENT_SETTINGS.compactionThresholdTokens;
    const keepRecentTokens =
      typeof stored.keepRecentTokens === 'number' &&
      Number.isSafeInteger(stored.keepRecentTokens) &&
      stored.keepRecentTokens > 0
        ? stored.keepRecentTokens
        : DEFAULT_CONTEXT_MANAGEMENT_SETTINGS.keepRecentTokens;
    if (compactionThresholdTokens >= contextWindowTokens) {
      return { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS };
    }
    return { contextWindowTokens, compactionThresholdTokens, keepRecentTokens };
  }

  updateContextManagementSettings(update: Partial<ContextManagementSettings>): ContextManagementSettings {
    const next = { ...this.getContextManagementSettings(), ...update };
    if (!Number.isSafeInteger(next.contextWindowTokens) || next.contextWindowTokens <= 0) {
      throw new Error('Context window must be a positive whole number of tokens.');
    }
    if (!Number.isSafeInteger(next.compactionThresholdTokens) || next.compactionThresholdTokens <= 0) {
      throw new Error('Compaction threshold must be a positive whole number of tokens.');
    }
    if (!Number.isSafeInteger(next.keepRecentTokens) || next.keepRecentTokens <= 0) {
      throw new Error('Recent history budget must be a positive whole number of tokens.');
    }
    if (next.compactionThresholdTokens >= next.contextWindowTokens) {
      throw new Error('Compaction threshold must be lower than the context window.');
    }
    this.store.setSetting('context-management', next);
    return next;
  }

  getMiscellaneousSettings(): MiscellaneousSettings {
    const stored = objectValue(this.store.getSetting<unknown>('miscellaneous', {})) ?? {};
    return {
      toolCardsExpandedByDefault:
        typeof stored.toolCardsExpandedByDefault === 'boolean'
          ? stored.toolCardsExpandedByDefault
          : DEFAULT_MISCELLANEOUS_SETTINGS.toolCardsExpandedByDefault,
    };
  }

  updateMiscellaneousSettings(update: Partial<MiscellaneousSettings>): MiscellaneousSettings {
    if (typeof update.toolCardsExpandedByDefault !== 'boolean') {
      throw new Error('Default tool card expansion must be a boolean.');
    }
    const next = { ...this.getMiscellaneousSettings(), ...update };
    this.store.setSetting('miscellaneous', next);
    return next;
  }

  availableCommands(): Array<{ name: string; description: string }> {
    return this.commands.list();
  }

  pluginInfo(): {
    plugins: ReturnType<PluginHost['list']>;
    catalog: ReturnType<PluginHost['catalog']>;
    ui: ReturnType<PluginHost['uiContributions']>;
    pages: ReturnType<PluginHost['uiPages']>;
    providers: ReturnType<PluginHost['modelProviders']>;
    pipelines: ReturnType<ExecutionPipelines['registrations']>;
    errors: string[];
  } {
    return {
      plugins: this.plugins.list(),
      catalog: this.plugins.catalog(),
      ui: this.plugins.uiContributions(),
      pages: this.plugins.uiPages(),
      providers: this.plugins.modelProviders(),
      pipelines: this.pipelines.registrations(),
      errors: [...this.pluginLoadErrors],
    };
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginCatalogEntry[]> {
    const catalog = await this.plugins.setEnabled(pluginId, enabled);
    this.pluginLoadErrors = [...this.plugins.errors()];
    return catalog;
  }

  async reloadPlugin(pluginId: string): Promise<PluginCatalogEntry[]> {
    const catalog = await this.plugins.reload(pluginId);
    this.pluginLoadErrors = [...this.plugins.errors()];
    return catalog;
  }

  pluginHttpRoute(pluginId: string, method: string, path: string) {
    return this.plugins.findHttpRoute(pluginId, method, path);
  }

  async executorStatus(threadId: string): Promise<{
    requiresExecutor: boolean;
    connected: boolean;
    compatible: boolean;
    kind: string;
    label: string;
    executorVersion?: string;
    targetVersion?: string;
    updateAvailable: boolean;
    updateSupported: boolean;
    error?: string;
  }> {
    const binding = this.store.executorForThread(threadId);
    if (!binding) throw new Error('Executor binding is missing');
    const requiresExecutor = requiresExternalExecutor(binding.kind);
    const targetVersion = currentExecutorVersion();
    if (!requiresExecutor) {
      return {
        requiresExecutor: false,
        connected: true,
        compatible: true,
        kind: 'runtime',
        label: 'Chat',
        targetVersion,
        updateAvailable: false,
        updateSupported: false,
      };
    }
    try {
      const adapter = this.adapterFor(binding);
      const info = await adapter.checkConnection(binding);
      const compatible = info?.protocolVersion === EXECUTOR_PROTOCOL_VERSION && info.kind === 'executor';
      const comparison = info?.executorVersion ? compareExecutorVersions(info.executorVersion, targetVersion) : null;
      const updateAvailable = !compatible || comparison === -1 || comparison === null;
      const kind = binding.remoteConnectionId ? 'remote-host' : binding.kind;
      return {
        requiresExecutor: true,
        connected: compatible,
        compatible,
        kind,
        label: binding.label,
        ...(info?.executorVersion ? { executorVersion: info.executorVersion } : {}),
        targetVersion,
        updateAvailable,
        updateSupported: info?.updateSupported === true,
        ...(!compatible
          ? {
              error: `Executor protocol is incompatible. ${info?.executorVersion ? `Installed version: ${info.executorVersion}.` : 'Installed version is unknown.'} Update the Executor to ${targetVersion}.`,
            }
          : {}),
      };
    } catch (error) {
      return {
        requiresExecutor: true,
        connected: false,
        compatible: false,
        kind: binding.remoteConnectionId ? 'remote-host' : binding.kind,
        label: binding.label,
        targetVersion,
        updateAvailable: false,
        updateSupported: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async updateExecutor(threadId: string): Promise<Awaited<ReturnType<PicoRuntime['executorStatus']>>> {
    const binding = this.store.executorForThread(threadId);
    if (!binding || !requiresExternalExecutor(binding.kind)) {
      throw new Error('Chat mode does not use an external Executor.');
    }
    const version = currentExecutorVersion();
    const result = await this.adapterFor(binding).update(binding, await currentExecutorBundle(), version);
    if (result.executorVersion !== version) throw new Error('Executor did not confirm the requested version.');
    let status = await this.executorStatus(threadId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (status.compatible && status.executorVersion === version) return status;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      status = await this.executorStatus(threadId);
    }
    throw new Error(
      `Executor accepted version ${version} but did not reconnect with that version. ${status.error ?? 'Check its connection and try again.'}`,
    );
  }

  async drain(): Promise<void> {
    while (this.loops.size > 0) await Promise.all([...this.loops.values()]);
  }
}
