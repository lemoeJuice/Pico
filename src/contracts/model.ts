import type { TokenUsage, ToolCall, ToolDefinition } from '../core/types.js';

export type ProviderRequestOutcome = 'retrying' | 'completed' | 'failed' | 'interrupted';

export interface ProviderRequestStart {
  provider: string;
  protocol: string;
  endpoint: string;
  attempt: number;
}

export interface ProviderRequestResponse {
  status: number;
  contentType: string | null;
  providerRequestId?: string;
}

export interface ProviderRequestSummary {
  outcome: ProviderRequestOutcome;
  durationMs: number;
  terminalEvent?: string;
  errorCategory?: 'http' | 'transport' | 'protocol' | 'aborted';
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
}

export interface ModelRequestTrace {
  started(details: ProviderRequestStart): string;
  response(providerAttemptId: string, details: ProviderRequestResponse): void;
  settled(providerAttemptId: string, details: ProviderRequestSummary): void;
}

export type PromptTurn =
  | { kind: 'message'; role: 'user' | 'assistant'; content: string; reasoningContent?: string }
  | { kind: 'assistant_tools'; content: string; calls: ToolCall[]; reasoningContent?: string }
  | { kind: 'tool_result'; callId: string; toolName: string; content: string };

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
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  model: string;
  finishReason: string | null;
}

export type ModelStreamEvent =
  | { type: 'reasoning_summary.delta'; delta: string }
  | { type: 'tool_call.preview'; index: number; id?: string; name?: string; argumentsText: string };
