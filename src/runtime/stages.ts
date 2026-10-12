import type { AssistantPayload, CanonicalRecord, Execution, Thread, ToolCall, ToolDefinition } from '../core/types.js';
import type { ModelPrompt, ModelResponse } from './model.js';

export interface StepInput {
  thread: Thread;
  iteration: number;
  perform(): Promise<void>;
}

export interface ProjectionInput {
  thread: Thread;
  records: readonly CanonicalRecord[];
  through: number;
  systemPrompt: string;
  turns: ModelPrompt['turns'];
  tools: ToolDefinition[];
}

export interface ModelStageInput {
  thread: Thread;
  prompt: ModelPrompt;
  signal: AbortSignal;
  onText(delta: string): void;
  perform(): Promise<ModelResponse>;
}

export interface ToolBatchInput {
  thread: Thread;
  batchId: string;
  calls: ToolCall[];
  perform(): Promise<Execution[]>;
}

export type PermissionPolicy = 'allow' | 'deny' | 'ask';

export interface ToolInvocationInput {
  thread: Thread;
  call: ToolCall;
  executionId: string;
  policy: PermissionPolicy;
  requestApproval(): Promise<boolean>;
  deny(reason: string): Promise<Execution>;
  invoke(): Promise<Execution>;
}

export interface DurableAssistantStep {
  thread: Thread;
  payload: AssistantPayload;
}
