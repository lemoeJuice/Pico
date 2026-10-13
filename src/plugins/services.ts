import type { Execution, ExecutorBinding, ExecutorKind, Thread, ToolDefinition } from '../core/types.js';

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
  };
  executions: {
    get(executionId: string): Execution | null;
    fail(executionId: string, reason: string, result?: unknown): Execution;
    subscribe(listener: (execution: Execution) => void): () => void;
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
  },
  executions: { get: unavailable, fail: unavailable, subscribe: unavailable },
};
