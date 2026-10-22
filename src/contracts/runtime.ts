import type { CanonicalRecord, Execution, Thread, ThreadModelSelection, TokenUsage } from '../core/types.js';
import type { ModelPrompt, ProviderRequestOutcome, ProviderRequestStart, ProviderRequestSummary } from './model.js';

export interface ThreadSnapshot {
  thread: Thread;
  modelSelection: ThreadModelSelection;
  contextUsage: ContextUsageEstimate;
  records: CanonicalRecord[];
  executions: Execution[];
  children: Thread[];
  hasEarlierRecords: boolean;
  historyPageSize: number;
}

export interface ContextUsageEstimate {
  inputTokens: number;
  source: 'provider' | 'provider+estimate' | 'estimate';
}

export interface ThreadToolView {
  name: string;
  description: string;
  source: 'runtime' | 'executor';
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
  eventCounts?: Record<string, number>;
  firstTextMs?: number;
  deltaTextCharacters?: number;
  outputTextCharacters?: number;
  outputItemCounts?: Record<string, number>;
  toolCallCount?: number;
  finishReason?: string | null;
  responseId?: string;
  usage?: TokenUsage | null;
  createdAt: string;
}
