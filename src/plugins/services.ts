import type { Execution, ExecutorBinding, ExecutorKind, Project, Thread, ToolDefinition } from '../core/types.js';
import type { ModelPrompt, ModelResponse, ModelStreamEvent } from '../contracts/model.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import type { ThreadModelSelection } from '../core/types.js';

/** Domain operations available to workflow plugins, independent of Runtime implementation. */
export interface PluginServices {
  projects: {
    list(): Project[];
  };
  threads: {
    get(threadId: string): Thread | null;
    modelSelection(threadId: string): ThreadModelSelection;
    validateModelSelection(selection: ThreadModelSelection): ThreadModelSelection;
    updateModelSelection(threadId: string, selection: ThreadModelSelection): ThreadModelSelection;
    list(projectId?: string): Thread[];
    updateTitle(pluginId: string, threadId: string, title: string): Thread;
    tools(
      threadId: string,
    ): Promise<Array<ToolDefinition & { source: 'runtime' | 'executor' | 'mcp'; enabled: boolean }>>;
    /** Change whether a tool is included in future model projections for this Thread. Permission remains invocation-scoped. */
    setToolEnabled(threadId: string, toolName: string, enabled: boolean): Promise<void>;
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
        modelSelection?: ThreadModelSelection;
        /** Sparse per-tool visibility overrides applied when this Thread is first created. */
        toolOverrides?: Record<string, boolean>;
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
        modelTarget?: { provider: string; connectionId?: string; model?: string };
        requestParameters?: { temperature?: number | null; fields: Record<string, unknown> };
        onEvent?: (event: ModelStreamEvent) => void;
      },
    ): Promise<PluginModelCallRecord & { response: ModelResponse }>;
    history(filter?: { pluginId?: string; threadId?: string; projectId?: string }): PluginModelCallRecord[];
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
  projects: { list: unavailable },
  threads: {
    get: unavailable,
    modelSelection: unavailable,
    validateModelSelection: unavailable,
    updateModelSelection: unavailable,
    list: unavailable,
    updateTitle: unavailable,
    tools: unavailable,
    setToolEnabled: unavailable,
    binding: unavailable,
    create: unavailable,
    send: unavailable,
    pause: unavailable,
    resume: unavailable,
  },
  executions: { get: unavailable, subscribe: unavailable },
  models: { complete: unavailable, history: unavailable, subscribe: unavailable },
  continuations: { register: unavailable, hasPendingWork: unavailable },
};
