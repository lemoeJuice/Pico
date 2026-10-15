import type { Execution, ExecutorBinding, ExecutorKind, Thread, ToolDefinition } from '../core/types.js';
import type { ModelPrompt, ModelResponse } from '../runtime/model.js';
import type { PluginModelCallRecord } from '../core/store.js';
import type { ModelInputAttempt } from '../runtime/runtime.js';

/** Domain operations available to workflow plugins, independent of Runtime implementation. */
export interface PluginServices {
  threads: {
    get(threadId: string): Thread | null;
    list(projectId?: string): Thread[];
    tools(threadId: string): Promise<Array<ToolDefinition & { source: 'runtime' | 'executor' }>>;
    binding(threadId: string): ExecutorBinding | null;
    create(
      projectId: string,
      executorKind: ExecutorKind,
      title: string,
      options?: {
        parentThreadId?: string;
        createdByAgent?: boolean;
        remoteConnectionId?: string;
        workspacePath?: string;
        idempotencyKey?: string;
      },
    ): Thread;
    send(
      senderThreadId: string,
      targetId: string,
      content: string,
      messageId: string,
    ): {
      delivered: boolean;
      threadId: string;
      messageId: string;
    };
    pause(threadId: string, reason: string): Thread;
    resume(threadId: string): Thread;
  };
  executions: {
    get(executionId: string): Execution | null;
    fail(executionId: string, reason: string, result?: unknown): Execution;
    subscribe(listener: (execution: Execution) => void): () => void;
  };
  models: {
    complete(
      pluginId: string,
      request: {
        threadId: string;
        projectId?: string;
        purpose: string;
        idempotencyKey: string;
        prompt: ModelPrompt;
        signal?: AbortSignal;
      },
    ): Promise<PluginModelCallRecord & { response: ModelResponse }>;
    history(filter?: { pluginId?: string; threadId?: string; projectId?: string }): PluginModelCallRecord[];
    inputs(threadId: string): Array<{ executionId: string; attempt: ModelInputAttempt }>;
    subscribe(listener: (call: PluginModelCallRecord) => void): () => void;
  };
  continuations: {
    register(pluginId: string, hasPendingWork: (threadId: string) => boolean): () => void;
    hasPendingWork(threadId: string): boolean;
  };
}

const unavailable = (): never => {
  throw new Error('Workflow services are not configured for this plugin host');
};
export const unavailablePluginServices: PluginServices = {
  threads: {
    get: unavailable,
    list: unavailable,
    tools: unavailable,
    binding: unavailable,
    create: unavailable,
    send: unavailable,
    pause: unavailable,
    resume: unavailable,
  },
  executions: { get: unavailable, fail: unavailable, subscribe: unavailable },
  models: { complete: unavailable, history: unavailable, inputs: unavailable, subscribe: unavailable },
  continuations: { register: unavailable, hasPendingWork: unavailable },
};
