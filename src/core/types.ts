export type ExecutorKind = 'container' | 'host' | 'runtime';
export type ThreadState = 'idle' | 'running' | 'pausing' | 'paused';
export type ExecutionKind = 'model' | 'tool';
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export type MessageRole = 'user' | 'assistant';
export type MessageSource = 'user' | 'agent' | 'child';
export type CanonicalKind = 'message' | 'assistant' | 'tool_result' | 'plugin';

export const DEFAULT_THREAD_TITLE = 'New thread';

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
  remoteConnectionId?: string | null;
  remoteEndpointUrl?: string | null;
  remoteAccessToken?: string | null;
  createdAt: string;
}

export interface Thread {
  id: string;
  projectId: string;
  executorId: string;
  executorKind: ExecutorKind;
  executorRemote: boolean;
  executorLabel: string;
  workspacePath: string;
  title: string;
  parentThreadId: string | null;
  createdByAgent: boolean;
  pauseRequested: boolean;
  pauseReason: string | null;
  createdAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  state: ThreadState;
}

export interface RemoteExecutorConnection {
  id: string;
  name: string;
  endpointUrl: string;
  accessToken: string;
  workspaceRoot: string;
  createdAt: string;
}

export type RemoteExecutorConnectionView = Omit<RemoteExecutorConnection, 'accessToken'> & {
  hasAccessToken: boolean;
};

export interface CanonicalRecord<T = Record<string, unknown>> {
  id: string;
  threadId: string | null;
  /** Stable ordering scope; Thread history uses `thread:<id>`. */
  scope?: string;
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
  /** Runtime-selected provider for this committed main-model response. */
  provider?: ModelProvider;
  /** Provider-supplied reasoning text for display. */
  reasoningSummary?: string;
  /** Provider-supplied reasoning content retained for adapters that support replay. */
  reasoningContent?: string;
  /** Opaque adapter replay state; kept out of user-facing history and diagnostics. */
  reasoningReplay?: unknown;
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
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type ModelProvider = string;

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  provider: ModelProvider;
}

export interface ContextManagementSettings {
  contextWindowTokens: number;
  compactionThresholdTokens: number;
  keepRecentTokens: number;
}

export interface MiscellaneousSettings {
  toolCardsExpandedByDefault: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface UiContribution {
  slot: 'thread.toolbar' | 'composer.action' | 'composer.model' | 'composer.status' | 'sidebar.panel' | 'tool.result';
  id: string;
  label: string;
  description?: string;
  command?: string;
  pluginId?: string;
  entry?: string;
  component?: string;
  toolNames?: string[];
  providers?: ModelProvider[];
  supportsPopover?: boolean;
  /** Explicit HTTPS origins that may receive one-time host-created auth popups for marked buttons. */
  externalAuthOrigins?: string[];
}

export interface ModelProviderContribution {
  id: ModelProvider;
  label: string;
  description?: string;
  /** The provider adapter maps PromptTurn image inputs to its wire format. */
  supportsImages?: boolean;
}

/** Effective model selection; provider/model follow global Runtime settings while parameters may be Thread-specific. */
export interface ThreadModelSelection {
  provider: ModelProvider;
  connectionId: string;
  model: string;
  /** Semantic, non-wire parameter overrides for this Thread. */
  parameters: { temperature?: number | null; options: Record<string, string | number | boolean> };
}

export interface PublicSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  provider: ModelProvider;
  hasApiKey: boolean;
  modelsByProvider?: Record<ModelProvider, string>;
}
