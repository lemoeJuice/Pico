import type {
  AssistantPayload,
  CanonicalRecord,
  Execution,
  ModelProvider,
  Thread,
  ToolCall,
  ToolDefinition,
} from '../core/types.js';
import type { McpToolTarget } from '../executor/tool-catalog.js';
import type {
  ModelPrompt,
  ModelRequestParameters,
  ModelRequestTrace,
  ModelResponse,
  ModelStreamEvent,
} from './model.js';
import type { ProjectionProvenance } from './runtime.js';

export type { ProjectionProvenance } from './runtime.js';

export type PipelineStage = 'step' | 'projection' | 'model' | 'toolBatch' | 'toolInvocation';

export interface StepInput {
  thread: Thread;
  iteration: number;
}

export interface ProjectionInput {
  thread: Thread;
  records: readonly CanonicalRecord[];
  through: number;
  systemPrompt: string;
  turns: ModelPrompt['turns'];
  tools: ToolDefinition[];
  toolSources?: Record<string, 'runtime' | 'executor' | 'mcp'>;
  mcpTargets?: Record<string, McpToolTarget>;
  provenance?: ProjectionProvenance[];
}

export interface PluginModelCallScope {
  pluginId: string;
  purpose: string;
  idempotencyKey?: string;
}

export interface ModelStageInput {
  thread: Thread;
  provider: ModelProvider;
  /** Present for auxiliary model calls initiated by a plugin. */
  pluginModelCall?: PluginModelCallScope;
  /** Stable primary Execution or namespaced plugin-call identity, used for invocation facts. */
  invocationId?: string;
  /** Public routing identity only; excludes API keys and other credentials. */
  modelTarget?: { provider: string; connectionId?: string; baseUrl: string; model: string };
  /** Semantic Thread settings; provider adapters/plugins turn these into wire fields. */
  selectionParameters?: { temperature?: number | null; options: Record<string, string | number | boolean> };
  prompt: ModelPrompt;
  requestParameters?: ModelRequestParameters;
  signal: AbortSignal;
  onText(delta: string): void;
  onEvent?(event: ModelStreamEvent): void;
  recordModelInput(prompt: ModelPrompt, provider: ModelProvider, provenance?: ProjectionProvenance[]): void;
  projectionProvenance?: ProjectionProvenance[];
  requestTrace?: ModelRequestTrace;
}

export interface ToolBatchInput {
  thread: Thread;
  batchId: string;
  calls: readonly ToolCall[];
  execute(call: ToolCall): Promise<Execution>;
}

export interface ToolInvocationInput {
  thread: Thread;
  call: ToolCall;
  executionId: string;
  signal: AbortSignal;
  /** Null means the Runtime no longer has this tool locally (for example, a remote tool). */
  toolSource: 'runtime' | 'executor' | 'mcp' | null;
  /** Fail the invocation and include structured guidance for the next Model Step when appropriate. */
  fail(reason: string, result?: unknown): Promise<Execution>;
  invoke(): Promise<Execution>;
}

export interface StageInputs {
  step: StepInput;
  projection: ProjectionInput;
  model: ModelStageInput;
  toolBatch: ToolBatchInput;
  toolInvocation: ToolInvocationInput;
}

export interface StageOutputs {
  step: void;
  projection: ProjectionInput;
  model: ModelResponse;
  toolBatch: Execution[];
  toolInvocation: Execution;
}

export interface DurableAssistantStep {
  thread: Thread;
  payload: AssistantPayload;
}
