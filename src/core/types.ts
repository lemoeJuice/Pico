export type ExecutorKind = 'container' | 'host';
export type ThreadState = 'idle' | 'running' | 'pausing' | 'paused';
export type ExecutionKind = 'model' | 'tool';
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export type MessageRole = 'user' | 'assistant';
export type MessageSource = 'user' | 'agent' | 'child';
export type CanonicalKind = 'message' | 'assistant' | 'tool_result' | 'plugin';

export interface Project {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
}

export interface ExecutorBinding {
  id: string;
  kind: ExecutorKind;
  label: string;
  workspacePath: string;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  executorId: string;
  executorKind: ExecutorKind;
  executorLabel: string;
  workspacePath: string;
  title: string;
  parentThreadId: string | null;
  createdByAgent: boolean;
  pauseRequested: boolean;
  pauseReason: string | null;
  createdAt: string;
  state: ThreadState;
}

export interface CanonicalRecord<T = Record<string, unknown>> {
  id: string;
  threadId: string | null;
  seq: number;
  kind: CanonicalKind;
  payload: T;
  createdAt: string;
}

export interface MessagePayload {
  role: MessageRole;
  content: string;
  source: MessageSource;
  senderThreadId?: string;
  senderLabel?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantPayload {
  content: string;
  toolCalls: ToolCall[];
  batchId: string | null;
  projectionThrough: number;
  usage: TokenUsage | null;
  model: string;
  finishReason?: string | null;
}

export interface ToolResultPayload {
  executionId: string;
  toolCallId: string;
  batchId: string;
  toolName: string;
  status: Exclude<ExecutionStatus, 'pending' | 'running'>;
  result?: unknown;
  error?: string;
}

export interface Execution {
  id: string;
  threadId: string;
  batchId: string | null;
  kind: ExecutionKind;
  toolName: string | null;
  arguments: Record<string, unknown> | null;
  status: ExecutionStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PermissionRequest {
  executionId: string;
  threadId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  createdAt: string;
}

export interface UiContribution {
  slot: 'thread.toolbar' | 'composer.action' | 'sidebar.panel';
  id: string;
  label: string;
  description?: string;
  command?: string;
}

export interface PublicSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  hasApiKey: boolean;
}
