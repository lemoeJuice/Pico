import type { CanonicalRecord, Execution, Thread, ThreadModelSelection, TokenUsage } from '../core/types.js';
import type {
  ModelPrompt,
  ProviderHttpError,
  ProviderRequestOutcome,
  ProviderRequestStart,
  ProviderRequestSummary,
} from './model.js';

export interface ThreadSnapshot {
  thread: Thread;
  modelSelection: ThreadModelSelection;
  contextUsage: ContextUsageEstimate | null;
  /** Present only in the fast first-paint payload; full projection metadata is still loading. */
  projectionStatus?: 'not_loaded';
  records: CanonicalRecord[];
  /** Full active projection membership, present when preserved inactive branches exist. */
  activePathRecordIds?: string[];
  /** Model executions whose committed reply or input boundary belongs to the active path. */
  activePathExecutionIds?: string[];
  hasInactiveHistory?: boolean;
  historyBranches?: HistoryBranchSummary[];
  executions: Execution[];
  children: Thread[];
  hasEarlierRecords: boolean;
  historyPageSize: number;
}

/** First paint payload. Projection membership and context usage are resolved by the full snapshot. */
export interface ThreadInitialSnapshot extends ThreadSnapshot {
  contextUsage: null;
  projectionStatus: 'not_loaded';
}

export type ThreadInitialSnapshotResponse =
  | { mode: 'initial'; snapshot: ThreadInitialSnapshot }
  | { mode: 'complete'; snapshot: ThreadSnapshot };

export interface HistoryBranchSummary {
  id: string;
  parentId: string | null;
  targetRecordId: string;
  targetSeq: number;
  createdAt: string;
  preview: string;
  onActivePath: boolean;
  active: boolean;
}

export interface ContextUsageEstimate {
  inputTokens: number;
  source: 'provider' | 'provider+estimate' | 'estimate';
}

export interface ThreadToolView {
  name: string;
  description: string;
  source: 'runtime' | 'executor' | 'mcp';
  /** Present for MCP tools and identifies the configured server that owns the tool. */
  mcpServerId?: string;
  /** True only when the upstream MCP tool is named invoke_action. */
  mcpIsInvokeAction?: boolean;
  enabled: boolean;
}

export interface ProjectionProvenance {
  id: string;
  sourcePluginId: string;
  label: string;
  kind: 'canonical' | 'plugin' | 'rolling_segment';
  disposition: 'raw' | 'summary' | 'omitted';
  canonicalStartSeq?: number;
  canonicalEndSeq?: number;
  summaryVersion?: string;
  turnIndex?: number;
  /** Half-open range of projected turns attributable to this source. */
  turnStartIndex?: number;
  turnEndIndex?: number;
  reason?: string;
}

export interface SubmitResult {
  accepted: boolean;
  duplicate?: boolean;
  command?: { text?: string; openThreadId?: string; severity?: 'notice' | 'error' };
}

export interface ModelInputAttempt {
  id: string;
  prompt?: ModelInputPromptSnapshot;
  promptSummary: ModelPromptDiagnostics;
  projectionProvenance?: ProjectionProvenance[];
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  error?: string;
  result?: ModelInputResultSummary;
  partialOutputCharacters?: number;
  providerRequests?: ProviderRequestAttempt[];
  createdAt: string;
}

type ModelInputMessageTurn = Extract<ModelPrompt['turns'][number], { kind: 'message' }>;
type ModelInputAssistantToolsTurn = Extract<ModelPrompt['turns'][number], { kind: 'assistant_tools' }>;
type ModelInputToolResultTurn = Extract<ModelPrompt['turns'][number], { kind: 'tool_result' }>;

/** Text-bearing input captured for an actual model request; inline image bytes and provider replay data are omitted. */
export interface ModelInputPromptSnapshot extends Omit<ModelPrompt, 'turns'> {
  version: 1;
  turns: Array<
    | Omit<ModelInputMessageTurn, 'reasoningReplay'>
    | Omit<ModelInputAssistantToolsTurn, 'reasoningReplay'>
    | (Omit<ModelInputToolResultTurn, 'images'> & {
        images?: Array<{ mimeType: string; name?: string; byteLength: number }>;
      })
  >;
}

export interface ModelPromptDiagnostics {
  version: 1;
  model: string;
  temperature: number;
  systemCharacters: number;
  systemFingerprint: string;
  turns: Array<{
    kind: ModelPrompt['turns'][number]['kind'];
    role?: 'user' | 'assistant';
    characters: number;
    toolCallCount?: number;
    imageCount?: number;
    imageBytes?: number;
  }>;
  toolCount: number;
  toolNames: string[];
  toolDefinitionCharacters: number;
  toolsFingerprint: string;
}

export interface ModelInputResultSummary {
  textCharacters: number;
  toolCallCount: number;
  finishReason: string | null;
  usage: TokenUsage | null;
  empty: boolean;
}

export interface ProviderRequestAttempt extends ProviderRequestStart {
  id: string;
  status?: number;
  contentType?: string | null;
  providerRequestId?: string;
  outcome: ProviderRequestOutcome | 'running';
  durationMs?: number;
  terminalEvent?: string;
  errorCategory?: ProviderRequestSummary['errorCategory'];
  errorCode?: string;
  providerError?: ProviderHttpError;
  eventCounts?: Record<string, number>;
  firstTextMs?: number;
  /** End-to-end output tokens / physical request seconds, including initial wait. */
  outputTokensPerSecond?: number;
  deltaTextCharacters?: number;
  outputTextCharacters?: number;
  outputItemCounts?: Record<string, number>;
  toolCallCount?: number;
  finishReason?: string | null;
  responseId?: string;
  usage?: TokenUsage | null;
  createdAt: string;
}
