import type { CatalogSelection } from '../contracts/model-catalog.js';
import type { Execution, ExecutorBinding, ExecutorKind, Project, Thread } from '../core/types.js';
import type { ModelPrompt, ModelResponse, ModelStreamEvent } from '../contracts/model.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import type { ThreadModelSelection } from '../core/types.js';
import type { McpServerStatus } from '../contracts/mcp.js';
import type { ThreadToolView } from '../contracts/runtime.js';
import type { ProjectionInput } from '../contracts/plugin-pipeline.js';

/** Domain operations available to workflow plugins, independent of Runtime implementation. */
export interface PluginServices {
  projects: {
    list(): Project[];
  };
  threads: {
    get(threadId: string): Thread | null;
    /** Publish the current Thread projection after plugin-owned state changes. */
    notifyStateChanged(threadId: string): void;
    /** Deliver an idempotent status notice to the direct parent, if it is available. */
    notifyParent(threadId: string, eventId: string, content: string): void;
    modelSelection(threadId: string): ThreadModelSelection;
    /** Preview the current full model projection without starting a model step. */
    previewModelInput(threadId: string): Promise<ProjectionInput>;
    validateModelSelection(selection: CatalogSelection): ThreadModelSelection;
    updateModelSelection(threadId: string, selection: CatalogSelection): ThreadModelSelection;
    list(projectId?: string | null): Thread[];
    updateTitle(pluginId: string, threadId: string, title: string): Thread;
    tools(threadId: string): Promise<ThreadToolView[]>;
    /** Resolve the tool names available from a local Executor template before creating a Thread. */
    toolNamesForExecutor(projectId: string | null, executorKind: ExecutorKind): Promise<string[]>;
    /** Change whether a tool is included in future model projections for this Thread. Permission remains invocation-scoped. */
    setToolEnabled(threadId: string, toolName: string, enabled: boolean): Promise<void>;
    binding(threadId: string): ExecutorBinding | null;
    create(
      projectId: string | null,
      executorKind: ExecutorKind,
      title: string,
      options?: {
        parentThreadId?: string;
        createdByAgent?: boolean;
        remoteConnectionId?: string;
        workspacePath?: string;
        idempotencyKey?: string;
        modelSelection?: CatalogSelection;
        /** Sparse per-tool visibility overrides applied when this Thread is first created. */
        toolOverrides?: Record<string, boolean>;
        /** Defaults to true. Set false when a child crosses executor boundaries. */
        inheritToolSettings?: boolean;
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
    /** Append an ordinary user Message and start the normal Thread loop without slash-command dispatch. */
    submitUserMessage(threadId: string, messageId: string, content: string): { accepted: true; duplicate: boolean };
    pause(threadId: string, reason: string): Thread;
    resume(threadId: string): Thread;
  };
  mcp: {
    list(): Array<{
      id: string;
      name: string;
      transport: 'stdio' | 'streamable-http';
      status: McpServerStatus;
      visibleByDefault: boolean;
      toolCount: number;
    }>;
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
    notifyStateChanged: unavailable,
    notifyParent: unavailable,
    modelSelection: unavailable,
    previewModelInput: unavailable,
    validateModelSelection: unavailable,
    updateModelSelection: unavailable,
    list: unavailable,
    updateTitle: unavailable,
    tools: unavailable,
    toolNamesForExecutor: unavailable,
    setToolEnabled: unavailable,
    binding: unavailable,
    create: unavailable,
    send: unavailable,
    submitUserMessage: unavailable,
    pause: unavailable,
    resume: unavailable,
  },
  mcp: { list: unavailable },
  executions: { get: unavailable, subscribe: unavailable },
  models: { complete: unavailable, history: unavailable, subscribe: unavailable },
  continuations: { register: unavailable, hasPendingWork: unavailable },
};
