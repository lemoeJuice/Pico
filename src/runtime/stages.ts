import type {
  AssistantPayload,
  CanonicalRecord,
  Execution,
  ModelProvider,
  Thread,
  ToolCall,
  ToolDefinition,
} from '../core/types.js';
import type { ModelPrompt, ModelRequestTrace, ModelStreamEvent } from './model.js';

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
  toolSources?: Record<string, 'runtime' | 'executor'>;
  provenance?: ProjectionProvenance[];
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

export interface ModelStageInput {
  thread: Thread;
  provider: ModelProvider;
  prompt: ModelPrompt;
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
  toolSource: 'runtime' | 'executor' | null;
  fail(reason: string, result?: unknown): Promise<Execution>;
  invoke(): Promise<Execution>;
}

export interface DurableAssistantStep {
  thread: Thread;
  payload: AssistantPayload;
}
