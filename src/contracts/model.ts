import type { ImageInput } from './multimodal.js';
import type { TokenUsage, ToolCall, ToolDefinition } from '../core/types.js';

export type ProviderRequestOutcome = 'retrying' | 'completed' | 'failed' | 'interrupted';

export interface ProviderRequestStart {
  provider: string;
  protocol: string;
  endpoint: string;
  attempt: number;
  /** Namespaced provider-only boolean diagnostics. */
  providerMetadata?: Record<string, boolean>;
}

export interface ProviderRequestResponse {
  status: number;
  contentType: string | null;
  providerRequestId?: string;
}

export type ProviderHttpErrorReason =
  'unsupported_parameter' | 'invalid_value' | 'invalid_type' | 'missing_parameter' | 'unknown';

/** A sanitized subset of an HTTP error response from a model provider. */
export interface ProviderHttpError {
  reason: ProviderHttpErrorReason;
  type?: string;
  code?: string;
  param?: string;
}

export interface ProviderRequestSummary {
  outcome: ProviderRequestOutcome;
  durationMs: number;
  terminalEvent?: string;
  errorCategory?: 'http' | 'transport' | 'protocol' | 'aborted';
  errorCode?: string;
  providerError?: ProviderHttpError;
  eventCounts?: Record<string, number>;
  /** For streaming requests, milliseconds from fetch dispatch to the first non-empty user-facing text delta; reasoning and tool-call deltas do not count. */
  firstTextMs?: number;
  /** Output tokens per second over the entire physical request, including first-text latency. */
  outputTokensPerSecond?: number;
  deltaTextCharacters?: number;
  outputTextCharacters?: number;
  outputItemCounts?: Record<string, number>;
  toolCallCount?: number;
  finishReason?: string | null;
  responseId?: string;
  usage?: TokenUsage | null;
}

export interface ModelRequestTrace {
  started(details: ProviderRequestStart): string;
  response(providerAttemptId: string, details: ProviderRequestResponse): void;
  settled(providerAttemptId: string, details: ProviderRequestSummary): void;
}

export type PromptTurn =
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      content: string;
      reasoningContent?: string;
      /** Opaque provider replay state. Core and projections must pass it through without interpreting it. */
      reasoningReplay?: unknown;
    }
  | {
      kind: 'assistant_tools';
      content: string;
      calls: ToolCall[];
      reasoningContent?: string;
      /** Opaque provider replay state. Core and projections must pass it through without interpreting it. */
      reasoningReplay?: unknown;
    }
  | { kind: 'tool_result'; callId: string; toolName: string; content: string; batchId?: string; images?: ImageInput[] };

export interface ModelPrompt {
  system: string;
  turns: PromptTurn[];
  tools: ToolDefinition[];
  model: string;
  temperature: number;
}

export interface ModelRequestParameters {
  fields: Record<string, unknown>;
  /** null means the provider/model does not accept temperature for this request. */
  temperature?: number | null;
}

export interface ModelResponse {
  content: string;
  reasoningSummary?: string;
  reasoningContent?: string;
  /** Opaque provider replay state. Core stores and projects it without interpreting it. */
  reasoningReplay?: unknown;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  model: string;
  finishReason: string | null;
}

export type ModelStreamEvent =
  | { type: 'reasoning_summary.delta'; delta: string }
  | { type: 'tool_call.preview'; index: number; id?: string; name?: string; argumentsText: string };
