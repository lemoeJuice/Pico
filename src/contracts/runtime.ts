import type { CanonicalRecord, Execution, Thread, TokenUsage } from '../core/types.js';
import type { ModelPrompt, ProviderRequestOutcome, ProviderRequestStart, ProviderRequestSummary } from './model.js';

export interface ThreadSnapshot {
  thread: Thread;
  records: CanonicalRecord[];
  executions: Execution[];
  children: Thread[];
  hasEarlierRecords: boolean;
  historyPageSize: number;
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
  command?: { text?: string; openThreadId?: string };
}

export interface ModelInputAttempt {
  id: string;
  prompt: ModelPrompt;
  projectionProvenance?: ProjectionProvenance[];
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  error?: string;
  result?: ModelInputResultSummary;
  partialOutputCharacters?: number;
  providerRequests?: ProviderRequestAttempt[];
  createdAt: string;
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
