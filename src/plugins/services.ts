import type { Execution, Thread } from '../core/types.js';

/** Domain operations available to workflow plugins, independent of Runtime implementation. */
export interface PluginServices {
  threads: {
    get(threadId: string): Thread | null;
    list(projectId?: string): Thread[];
    createChild(
      parentId: string,
      prompt: string,
      title?: string,
      messageId?: string,
    ): {
      threadId: string;
      title: string;
      executor: string;
    };
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
  threads: { get: unavailable, list: unavailable, createChild: unavailable, send: unavailable },
  executions: { get: unavailable, fail: unavailable, subscribe: unavailable },
};
