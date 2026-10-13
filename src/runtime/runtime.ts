import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AssistantPayload,
  CanonicalRecord,
  Execution,
  ExecutionStatus,
  ExecutorBinding,
  MessagePayload,
  ModelSettings,
  Project,
  PublicSettings,
  RemoteExecutorConnectionView,
  Thread,
  ThreadState,
  ToolCall,
  ToolDefinition,
  ToolResultPayload,
} from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { ExecutionPipelines } from '../core/pipeline.js';
import { ContainerExecutor } from '../executor/container-executor.js';
import { HostExecutor, type ExecutorAdapter } from '../executor/executor.js';
import { RemoteHostExecutor, inspectRemoteExecutor, validateRemoteWorkspace } from '../executor/remote-executor.js';
import { normalizeRemoteExecutorUrl } from '../executor/remote-protocol.js';
import { loadExecutorPlugins } from '../executor/plugin-host.js';
import { createToolCatalog, ToolCatalog, type ToolContext } from '../executor/tools.js';
import { builtinPlugins } from '../plugins/builtin.js';
import { CommandRegistry, PluginHost, type CommandResult } from '../plugins/host.js';
import type { PluginServices } from '../plugins/services.js';
import {
  OpenAiCompatibleAdapter,
  type ModelAdapter,
  type ModelPrompt,
  type ModelResponse,
  type PromptTurn,
} from './model.js';
import type { ModelStageInput, ProjectionInput, ToolBatchInput, ToolInvocationInput } from './stages.js';
import type { PicoPlugin } from '../plugins/host.js';

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface ThreadSnapshot {
  thread: Thread;
  records: CanonicalRecord[];
  executions: Execution[];
  children: Thread[];
  hasEarlierRecords: boolean;
  historyPageSize: number;
}

export const THREAD_HISTORY_PAGE_SIZE = 100;

export interface SubmitResult {
  accepted: boolean;
  duplicate?: boolean;
  command?: CommandResult;
}

function commandResultFromRecord(
  record: CanonicalRecord | null,
  threadId: string,
  requestHash: string,
  commandHash: string,
): CommandResult | null {
  if (
    !record ||
    record.threadId !== threadId ||
    record.kind !== 'plugin' ||
    record.payload.pluginId !== 'pico.commands' ||
    record.payload.action !== 'invocation-completed' ||
    record.payload.requestHash !== requestHash ||
    record.payload.commandHash !== commandHash
  ) {
    return null;
  }

  const result = record.payload.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  const command: CommandResult = {};
  if (typeof value.text === 'string') command.text = value.text;
  if (typeof value.openThreadId === 'string') command.openThreadId = value.openThreadId;
  return command;
}

export interface ModelInputAttempt {
  id: string;
  prompt: ModelPrompt;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  error?: string;
  createdAt: string;
}

const defaultModelSettings: ModelSettings = {
  baseUrl: process.env.PICO_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.PICO_MODEL_API_KEY ?? '',
  model: process.env.PICO_MODEL ?? '',
  temperature: 0.2,
  provider: 'openai-compatible',
};

const baseSystemPrompt = `You are Pico, an agent working in one durable Thread. Use the available tools when they help you inspect or change the selected workspace.\n\nTools in one model step may run concurrently. Their results arrive together before the next step. A tool result marked interrupted means its real-world side effects may be partial or unknown: inspect the environment before deciding whether to retry.\n\nA Thread stays bound to its displayed Executor for its lifetime.\n\nNew user messages can arrive while you work. They will appear at the next model step; finish the current tool batch first.`;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function stringifyToolResult(payload: ToolResultPayload): string {
  if (payload.status === 'interrupted') {
    return `Execution interrupted. ${payload.error ?? ''} Its real-world side effects may be partial or unknown. Inspect the environment before retrying.`;
  }
  if (payload.status === 'failed') return `Tool failed: ${payload.error ?? 'Unknown error'}`;
  try {
    return JSON.stringify(payload.result ?? null);
  } catch {
    return String(payload.result);
  }
}

function projectMessageContent(message: MessagePayload, thread: Thread): string {
  if (message.source === 'user') return message.content;
  const source =
    message.senderThreadId && message.senderThreadId === thread.parentThreadId
      ? 'Parent Thread'
      : message.source === 'child'
        ? 'Child Thread'
        : 'Agent Thread';
  const label = message.senderLabel?.trim();
  const senderLabel = label ? ` ${JSON.stringify(label)}` : '';
  const senderId = message.senderThreadId ? ` (Thread ID: ${JSON.stringify(message.senderThreadId)})` : '';
  return `[Message from ${source}${senderLabel}${senderId}]\n${message.content}`;
}

function terminalStatus(status: ExecutionStatus): status is 'completed' | 'failed' | 'interrupted' {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export interface RuntimeOptions {
  model?: ModelAdapter;
  plugins?: PicoPlugin[];
  pluginDirectory?: string;
  executorPluginDirectory?: string;
  disabledBuiltinPlugins?: string[];
}

export class PicoRuntime {
  readonly store: PicoStore;
  readonly tools = new ToolCatalog();
  private readonly executorTools = createToolCatalog();
  readonly pipelines = new ExecutionPipelines();
  readonly commands = new CommandRegistry();
  readonly plugins: PluginHost;
  private readonly model: ModelAdapter;
  private readonly additionalPlugins: PicoPlugin[];
  private readonly hostExecutor: HostExecutor;
  private readonly containerExecutor: ContainerExecutor;
  private readonly remoteHostExecutor: RemoteHostExecutor;
  private readonly options: RuntimeOptions;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly executionListeners = new Set<(execution: Execution) => void>();
  private storeUnsubscribers: Array<() => void> = [];
  private readonly loops = new Map<string, Promise<void>>();
  private readonly modelSignals = new Map<string, AbortController>();
  private readonly runtimeToolRuns = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private readonly invocationRuns = new Map<
    string,
    { promise: Promise<Execution>; controller: AbortController; toolStarted: boolean }
  >();
  private pluginLoadErrors: string[] = [];
  private executorPluginLoadErrors: string[] = [];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(store = new PicoStore(), options: RuntimeOptions = {}) {
    this.store = store;
    this.options = options;
    this.model = options.model ?? new OpenAiCompatibleAdapter();
    this.additionalPlugins = [...(options.plugins ?? [])];
    this.hostExecutor = new HostExecutor(store, this.executorTools, (execution) => this.executionChanged(execution));
    this.containerExecutor = new ContainerExecutor(
      store,
      this.executorTools,
      (execution) => this.executionChanged(execution),
      undefined,
      undefined,
      undefined,
      undefined,
      options.executorPluginDirectory,
    );
    this.remoteHostExecutor = new RemoteHostExecutor(store, (execution) => this.executionChanged(execution));
    const services: PluginServices = {
      threads: {
        get: (threadId) => this.store.getThread(threadId),
        list: (projectId) => this.listThreads(projectId),
        tools: async (threadId) => {
          const thread = this.store.getThread(threadId);
          if (!thread) throw new Error('Thread not found');
          const surface = await this.toolSurfaceFor(thread);
          return surface.tools.map((definition) => ({
            ...definition,
            source: (surface.sources[definition.name] ?? 'runtime') as 'runtime' | 'executor',
          }));
        },
        binding: (threadId) => this.store.executorForThread(threadId),
        create: (projectId, executorKind, title, options = {}) => {
          if (options.parentThreadId) {
            const parent = this.store.getThread(options.parentThreadId);
            if (!parent || parent.projectId !== projectId)
              throw new Error('Parent Thread must belong to the same Project');
          }
          const thread = this.store.createThread(projectId, executorKind, title, options);
          this.publish({ type: 'thread.created', thread });
          return thread;
        },
        send: (senderThreadId, targetId, content, messageId) => {
          const sender = this.store.getThread(senderThreadId);
          const target = this.store.getThread(targetId);
          if (!sender || !target || sender.projectId !== target.projectId) {
            throw new Error('Target Thread must belong to the same Project');
          }
          if (sender.id === target.id) throw new Error('Cannot send a message to the current Thread');
          const payload: MessagePayload = {
            role: 'user',
            content,
            source: sender.parentThreadId ? 'child' : 'agent',
            senderThreadId: sender.id,
            senderLabel: sender.title,
          };
          const result = this.postMessage(target, messageId, payload);
          return { delivered: result.inserted, threadId: target.id, messageId: result.record.id };
        },
      },
      executions: {
        get: (executionId) => this.store.getExecution(executionId),
        fail: (executionId, reason, result) => {
          const current = this.store.getExecution(executionId);
          if (!current) throw new Error('Execution not found');
          if (terminalStatus(current.status)) return current;
          const failed = this.store.transitionExecution(executionId, 'failed', { error: reason, result });
          this.executionChanged(failed);
          return failed;
        },
        subscribe: (listener) => {
          this.executionListeners.add(listener);
          return () => this.executionListeners.delete(listener);
        },
      },
    };
    this.plugins = new PluginHost(store, this.tools, this.pipelines, this.commands, options.pluginDirectory, services);
  }

  async initialize(): Promise<void> {
    this.storeUnsubscribers.push(
      this.store.subscribePluginState((pluginId) => this.publish({ type: 'plugin.updated', pluginId })),
      this.store.subscribeCanonical((record) => this.publishRecord(record)),
    );
    const disabled = new Set([
      ...(process.env.PICO_DISABLED_PLUGINS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      ...(this.options.disabledBuiltinPlugins ?? []),
    ]);
    const executorPluginLoad = await loadExecutorPlugins(
      this.executorTools,
      this.options.executorPluginDirectory ? { pluginDirectory: this.options.executorPluginDirectory } : {},
    );
    this.executorPluginLoadErrors = executorPluginLoad.errors;
    await this.plugins.load([
      ...builtinPlugins.filter((plugin) => !disabled.has(plugin.id)),
      ...this.additionalPlugins,
    ]);
    this.pluginLoadErrors = [...this.plugins.errors(), ...this.executorPluginLoadErrors];
    // A Runtime restart confirms its own unfinished model stream was lost. Tool state is
    // left untouched until the bound Executor can be queried.
    for (const thread of this.store.listThreads()) {
      for (const execution of this.store.listActiveExecutions(thread.id)) {
        if (execution.kind !== 'model') continue;
        const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
          error: 'Runtime restarted before this Model Step committed.',
          detail: { runtimeRestarted: true },
        });
        this.executionChanged(interrupted);
      }
    }
    // Re-enter durable work through the same loop and Executor submission paths.
    // A disconnected Executor may leave its execution running and pause the Thread;
    // a confirmed-lost Host execution becomes interrupted before the next Model Step.
    for (const thread of this.store.listThreads()) {
      if (!thread.pauseRequested || this.latestActiveBatch(thread.id)) this.startLoop(thread.id);
    }
  }

  async shutdownHostExecutor(): Promise<void> {
    await Promise.all([this.hostExecutor.shutdown(), this.remoteHostExecutor.shutdown()]);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    for (const controller of this.modelSignals.values()) controller.abort();
    for (const active of this.runtimeToolRuns.values()) active.controller.abort();

    await Promise.all([
      this.hostExecutor.shutdown(),
      this.containerExecutor.shutdown(),
      this.remoteHostExecutor.shutdown(),
      Promise.allSettled([...this.runtimeToolRuns.values()].map((active) => active.promise)),
    ]);

    // A pending Tool may be waiting on a plugin workflow decision. Leave its loop
    // suspended so the durable pending fact can be resumed by a fresh Runtime.
    const pendingToolThreads = new Set(
      this.store
        .listThreads()
        .filter((thread) =>
          this.store
            .listActiveExecutions(thread.id)
            .some((execution) => execution.kind === 'tool' && execution.status === 'pending'),
        )
        .map((thread) => thread.id),
    );
    await Promise.allSettled(
      [...this.loops.entries()].filter(([threadId]) => !pendingToolThreads.has(threadId)).map(([, loop]) => loop),
    );
    await this.plugins.shutdown();
    for (const unsubscribe of this.storeUnsubscribers.splice(0)) unsubscribe();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private publishRecord<T>(record: CanonicalRecord<T>): void {
    this.publish({ type: 'record', record });
  }

  private executionChanged(execution: Execution): void {
    this.publish({ type: 'execution.updated', execution });
    this.publishThreadUpdate(execution.threadId);
    for (const listener of this.executionListeners) listener(execution);
  }

  private publishThreadUpdate(threadId: string): void {
    const thread = this.getThread(threadId);
    if (thread) this.publish({ type: 'thread.updated', thread });
  }

  createProject(name: string, workspacePath: string): Promise<Project> {
    return this.createProjectChecked(name, workspacePath);
  }

  private async createProjectChecked(name: string, workspacePath: string): Promise<Project> {
    const cleanedName = name.trim();
    if (!cleanedName) throw new Error('Project name is required');
    const path = await realpath(resolve(workspacePath.trim()));
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('Workspace path must be a directory');
    return this.store.createProject(cleanedName, path);
  }

  listProjects(): Project[] {
    return this.store.listProjects();
  }

  createThread(projectId: string, executorKind: Thread['executorKind'], title = 'New thread'): Thread {
    const thread = this.store.createThread(projectId, executorKind, title.trim() || 'New thread');
    this.publish({ type: 'thread.created', thread });
    return thread;
  }

  async addRemoteExecutorConnection(
    name: string,
    endpointUrl: string,
    accessToken: string,
  ): Promise<RemoteExecutorConnectionView> {
    const cleanedName = name.trim();
    if (!cleanedName) throw new Error('Remote Executor name is required.');
    const normalizedUrl = normalizeRemoteExecutorUrl(endpointUrl);
    const info = await inspectRemoteExecutor(normalizedUrl, accessToken);
    return this.store.createRemoteExecutorConnection(cleanedName, normalizedUrl, accessToken, info.workspaceRoot);
  }

  async updateRemoteExecutorConnection(
    id: string,
    name: string,
    endpointUrl: string,
    accessToken?: string,
  ): Promise<RemoteExecutorConnectionView> {
    const current = this.store.getRemoteExecutorConnection(id);
    if (!current) throw new Error('Remote Executor connection not found.');
    const cleanedName = name.trim();
    if (!cleanedName) throw new Error('Remote Executor name is required.');
    const normalizedUrl = normalizeRemoteExecutorUrl(endpointUrl);
    if (normalizedUrl !== current.endpointUrl) {
      throw new Error(
        'Remote Executor endpoints cannot be changed on an existing connection. Add a new connection and create a new Thread to use another Executor.',
      );
    }
    const token = accessToken?.trim() || current.accessToken;
    const info = await inspectRemoteExecutor(normalizedUrl, token);
    return this.store.updateRemoteExecutorConnection(id, cleanedName, normalizedUrl, token, info.workspaceRoot);
  }

  remoteExecutorConnections(): RemoteExecutorConnectionView[] {
    return this.store.listRemoteExecutorConnections();
  }

  async createRemoteThread(
    projectId: string,
    connectionId: string,
    remoteWorkspacePath: string,
    title = 'New thread',
  ): Promise<Thread> {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.');
    const connection = this.store.getRemoteExecutorConnection(connectionId);
    if (!connection) throw new Error('Remote Executor connection not found.');
    const workspacePath = await validateRemoteWorkspace(
      connection.endpointUrl,
      connection.accessToken,
      remoteWorkspacePath,
    );
    const thread = this.store.createThread(projectId, 'host', title.trim() || 'New thread', {
      remoteConnectionId: connection.id,
      workspacePath,
    });
    this.publish({ type: 'thread.created', thread });
    return thread;
  }

  getThread(threadId: string): Thread | null {
    const thread = this.store.getThread(threadId);
    if (!thread) return null;
    const loopActive = this.loops.has(threadId);
    const executionActive = this.store.listActiveExecutions(threadId).length > 0;
    const state: ThreadState = thread.pauseRequested
      ? loopActive
        ? 'pausing'
        : 'paused'
      : loopActive || executionActive
        ? 'running'
        : 'idle';
    return { ...thread, state };
  }

  listThreads(projectId?: string): Thread[] {
    return this.store.listThreads(projectId).map((thread) => this.getThread(thread.id) ?? thread);
  }

  getSnapshot(threadId: string, beforeSeq?: number): ThreadSnapshot | null {
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
      throw new Error('beforeSeq must be a positive safe integer.');
    }
    const thread = this.getThread(threadId);
    if (!thread) return null;
    const page = this.store.listRecordPage(threadId, beforeSeq, THREAD_HISTORY_PAGE_SIZE);
    return {
      thread,
      records: page.records,
      executions: this.store.listSnapshotExecutions(threadId, page.records),
      children: this.listThreads(thread.projectId).filter((candidate) => candidate.parentThreadId === threadId),
      hasEarlierRecords: page.hasEarlierRecords,
      historyPageSize: THREAD_HISTORY_PAGE_SIZE,
    };
  }

  getModelInputAttempts(threadId: string, executionId: string): ModelInputAttempt[] | null {
    const execution = this.store.getExecution(executionId);
    if (!execution || execution.threadId !== threadId || execution.kind !== 'model') return null;
    const outcomes = new Map<string, { status: ModelInputAttempt['status']; error?: string }>();
    for (const entry of this.store.listExecutionLog(executionId, 'model-input-settled')) {
      const requestId = entry.detail.requestId;
      const status = entry.detail.status;
      if (
        typeof requestId === 'string' &&
        (status === 'completed' || status === 'failed' || status === 'interrupted')
      ) {
        outcomes.set(requestId, {
          status,
          ...(typeof entry.detail.error === 'string' ? { error: entry.detail.error } : {}),
        });
      }
    }
    return this.store.listExecutionLog(executionId, 'model-input-requested').flatMap((entry): ModelInputAttempt[] => {
      const requestId = entry.detail.requestId;
      const prompt = entry.detail.prompt;
      if (
        typeof requestId !== 'string' ||
        !prompt ||
        typeof prompt !== 'object' ||
        typeof (prompt as ModelPrompt).system !== 'string' ||
        !Array.isArray((prompt as ModelPrompt).turns) ||
        !Array.isArray((prompt as ModelPrompt).tools)
      ) {
        return [];
      }
      const outcome = outcomes.get(requestId);
      const status =
        outcome?.status ??
        (execution.status === 'interrupted' || execution.status === 'failed' || execution.status === 'completed'
          ? execution.status
          : 'running');
      return [
        {
          id: requestId,
          prompt: prompt as ModelPrompt,
          status,
          ...(outcome?.error ? { error: outcome.error } : {}),
          createdAt: entry.createdAt,
        },
      ];
    });
  }

  async submit(threadId: string, id: string, content: string): Promise<SubmitResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    if (content.trimStart().startsWith('/')) {
      const commandText = content.trim();
      const requestHash = createHash('sha256').update(`${threadId}\0${id}`).digest('hex');
      const commandHash = createHash('sha256').update(commandText).digest('hex');
      const receiptId = `pico:command:${requestHash}`;
      const completedId = `${receiptId}:completed`;
      const receipt = this.store.appendCanonical(threadId, receiptId, 'plugin', {
        pluginId: 'pico.commands',
        action: 'invocation-accepted',
        requestHash,
        commandHash,
      });
      if (!receipt.inserted) {
        const completedCommand = commandResultFromRecord(
          this.store.getCanonicalRecordById(completedId),
          threadId,
          requestHash,
          commandHash,
        );
        if (completedCommand) return { accepted: true, duplicate: true, command: completedCommand };
        return {
          accepted: true,
          duplicate: true,
          command: {
            text: 'This command ID was already accepted. Its original handler may still be running or may have finished; it was not started again.',
          },
        };
      }
      const command = await this.commands.execute(commandText, {
        thread: this.getThread(threadId),
        projectId: thread.projectId,
      });
      if (command) {
        this.store.appendCanonical(threadId, completedId, 'plugin', {
          pluginId: 'pico.commands',
          action: 'invocation-completed',
          requestHash,
          commandHash,
          result: command,
        });
        return { accepted: true, duplicate: false, command };
      }
    }
    const result = this.postMessage(thread, id, {
      role: 'user',
      content,
      source: 'user',
    });
    return { accepted: true, duplicate: !result.inserted };
  }

  private postMessage(
    thread: Thread,
    id: string,
    payload: MessagePayload,
  ): { record: CanonicalRecord<MessagePayload>; inserted: boolean } {
    const result = this.store.appendMessage(thread.id, id, payload);
    if (result.inserted) {
      if (!thread.pauseRequested) this.startLoop(thread.id);
    }
    this.publishThreadUpdate(thread.id);
    return result;
  }

  pause(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    this.store.setPause(threadId, true, 'Paused by user. Current model and tool executions are allowed to settle.');
    this.publishThreadUpdate(threadId);
    return this.getThread(threadId)!;
  }

  continue(threadId: string): Thread {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    this.store.setPause(threadId, false);
    this.publishThreadUpdate(threadId);
    this.startLoop(threadId);
    return this.getThread(threadId)!;
  }

  async interrupt(threadId: string): Promise<Thread> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    this.store.setPause(threadId, true, 'Interrupted by user. Continue when ready to inspect the current environment.');
    for (const [executionId, controller] of this.modelSignals) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) controller.abort();
    }
    for (const [executionId, active] of this.runtimeToolRuns) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) active.controller.abort();
    }
    for (const [executionId, active] of this.invocationRuns) {
      const execution = this.store.getExecution(executionId);
      if (execution?.threadId === threadId) active.controller.abort();
    }
    for (const execution of this.store.listActiveExecutions(threadId)) {
      if (execution.kind === 'model') continue;
      const tool = execution.toolName ? this.tools.get(execution.toolName) : undefined;
      const invocation = this.invocationRuns.get(execution.id);
      if (invocation && !invocation.toolStarted) {
        const settled = await invocation.promise;
        if (terminalStatus(settled.status)) this.ensureToolResult(threadId, settled);
        continue;
      }
      if (tool?.source === 'runtime' || thread.executorKind === 'runtime') {
        if (invocation) {
          const settled = await invocation.promise;
          if (terminalStatus(settled.status)) this.ensureToolResult(threadId, settled);
        } else if (execution.status === 'pending' || execution.status === 'running') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'Runtime confirmed this control tool will not continue after the explicit Interrupt request.',
            detail: { userInterrupted: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
        continue;
      }
      const binding = this.store.executorForThread(threadId);
      if (!binding) {
        if (execution.status === 'pending') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'No Executor was bound when the user explicitly interrupted this pending execution.',
            detail: { userInterrupted: true, confirmedMissing: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
        continue;
      }
      try {
        const adapter = this.adapterFor(binding);
        const updated = await adapter.interrupt(execution.id, binding);
        if (updated) {
          this.executionChanged(updated);
          if (terminalStatus(updated.status)) this.ensureToolResult(threadId, updated);
        }
        const latest = this.store.getExecution(execution.id);
        if (execution.status === 'pending' && latest?.status === 'pending') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'The Executor confirmed this execution had not started when the user explicitly interrupted it.',
            detail: { userInterrupted: true, confirmedMissing: true },
          });
          this.executionChanged(interrupted);
          this.ensureToolResult(threadId, interrupted);
        }
      } catch (error) {
        // A disconnected Executor leaves its last durable state untouched.
        this.publish({
          type: 'runtime.notice',
          threadId,
          message: `Interrupt could not reach ${binding.label}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    this.publishThreadUpdate(threadId);
    return this.getThread(threadId)!;
  }

  private startLoop(threadId: string): void {
    if (this.shuttingDown || this.loops.has(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (!thread || (thread.pauseRequested && !this.latestActiveBatch(threadId))) return;
    const task = Promise.resolve()
      .then(() => this.driveThread(threadId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const current = this.store.getThread(threadId);
        if (current && !current.pauseRequested) {
          this.store.setPause(threadId, true, `Runtime paused after an unexpected error: ${message}`);
        }
        this.publish({ type: 'runtime.error', threadId, message });
      })
      .finally(() => {
        this.loops.delete(threadId);
        this.publishThreadUpdate(threadId);
        const current = this.store.getThread(threadId);
        if (current && !current.pauseRequested && this.hasUnprocessedWork(threadId)) this.startLoop(threadId);
      });
    this.loops.set(threadId, task);
    this.publishThreadUpdate(threadId);
  }

  private async driveThread(threadId: string): Promise<void> {
    let iteration = 0;
    while (true) {
      if (this.shuttingDown) return;
      const thread = this.store.getThread(threadId);
      if (!thread) return;
      if (!this.latestActiveBatch(threadId) && (thread.pauseRequested || !this.needsModelStep(threadId))) return;
      let defaultStepRan = false;
      await this.pipelines.run('step', { thread, iteration }, async (input) => {
        if (input.thread.id !== threadId) throw new Error('Step plugins must preserve the active Thread identity.');
        defaultStepRan = true;
        await this.performStep(input.thread);
      });
      const afterStep = this.store.getThread(threadId);
      if (afterStep?.pauseRequested && this.latestActiveBatch(threadId)) return;
      if (!defaultStepRan && afterStep && !afterStep.pauseRequested && this.hasUnprocessedWork(threadId)) {
        this.store.setPause(threadId, true, 'The step pipeline stopped before durable work reached a safe boundary.');
        this.publishThreadUpdate(threadId);
        return;
      }
      iteration += 1;
    }
  }

  private async performStep(thread: Thread): Promise<void> {
    if (this.shuttingDown) return;
    const currentThread = this.store.getThread(thread.id);
    if (!currentThread) return;
    const activeBatch = this.latestActiveBatch(thread.id);
    if (activeBatch) {
      await this.runToolBatch(currentThread, activeBatch);
      return;
    }
    if (currentThread.pauseRequested || !this.needsModelStep(thread.id)) return;

    await this.runModelStep(thread);
    if (this.shuttingDown) return;
    const afterModel = this.store.getThread(thread.id);
    const modelBatch = afterModel ? this.latestActiveBatch(thread.id) : null;
    if (afterModel && modelBatch) await this.runToolBatch(afterModel, modelBatch);
  }

  private async runToolBatch(thread: Thread, activeBatch: { batchId: string; calls: ToolCall[] }): Promise<void> {
    const threadId = thread.id;
    // The Model Step already committed these calls. Batch plugins may reschedule them,
    // but must not silently change a canonical call's identity or arguments.
    const canonicalCalls = deepFreeze(structuredClone(activeBatch.calls));
    const callsById = new Map(canonicalCalls.map((call) => [call.id, call]));
    const batchInput: ToolBatchInput = {
      thread,
      batchId: activeBatch.batchId,
      calls: canonicalCalls,
      execute: (call) => {
        const canonical = callsById.get(call.id);
        if (
          !canonical ||
          canonical.name !== call.name ||
          JSON.stringify(canonical.arguments) !== JSON.stringify(call.arguments)
        ) {
          throw new Error(
            'Tool Batch plugins may reschedule calls but must preserve each call ID, name, and arguments.',
          );
        }
        return this.executeToolCall(thread, canonical);
      },
    };
    const batchResult = await this.pipelines.run<ToolBatchInput, Execution[]>('toolBatch', batchInput, (input) =>
      Promise.all(input.calls.map((call) => input.execute(call))),
    );
    const batchExecutions = this.persistToolBatchResult(threadId, activeBatch.batchId, batchResult);
    if (batchExecutions.length !== activeBatch.calls.length) {
      throw new Error(`Tool Batch ${activeBatch.batchId} does not have one durable Execution per Tool Call.`);
    }
    const activeExecutions = batchExecutions.filter(
      (execution) => execution.status === 'pending' || execution.status === 'running',
    );
    if (activeExecutions.length > 0) {
      if (!this.shuttingDown && !this.store.getThread(threadId)?.pauseRequested) {
        this.store.setPause(
          threadId,
          true,
          `Tool Batch returned with ${activeExecutions.length} execution(s) still pending or running. Execution state is preserved.`,
        );
      }
      this.publishThreadUpdate(threadId);
      return;
    }
    for (const execution of batchExecutions) this.ensureToolResult(threadId, execution);
  }

  private persistToolBatchResult(threadId: string, batchId: string, reported: Execution[]): Execution[] {
    if (!Array.isArray(reported)) throw new Error(`Tool Batch ${batchId} must return an array of Execution results.`);
    const executions = this.store.listExecutionsByBatch(batchId);
    const byId = new Map(executions.map((execution) => [execution.id, execution]));
    const reportedIds = new Set<string>();
    for (const result of reported) {
      if (!result || typeof result.id !== 'string' || reportedIds.has(result.id)) {
        throw new Error(`Tool Batch ${batchId} returned an invalid or duplicate Execution result.`);
      }
      reportedIds.add(result.id);
      const current = byId.get(result.id);
      if (
        !current ||
        current.threadId !== threadId ||
        current.batchId !== batchId ||
        current.kind !== 'tool' ||
        result.threadId !== threadId ||
        result.batchId !== batchId ||
        result.kind !== 'tool' ||
        result.toolName !== current.toolName ||
        JSON.stringify(result.arguments) !== JSON.stringify(current.arguments)
      ) {
        throw new Error(`Tool Batch ${batchId} returned an Execution outside its durable batch.`);
      }
      if (!['pending', 'running', 'completed', 'failed', 'interrupted'].includes(result.status)) {
        throw new Error(`Tool Batch ${batchId} returned an invalid Execution status.`);
      }
      if (terminalStatus(current.status) || result.status === 'pending' || current.status === result.status) continue;
      const updated = this.store.transitionExecution(current.id, result.status, {
        result: result.result ?? null,
        ...(result.error ? { error: result.error } : {}),
        detail: { source: 'tool-batch-pipeline' },
      });
      byId.set(updated.id, updated);
      this.executionChanged(updated);
    }
    const persisted = this.store.listExecutionsByBatch(batchId);
    for (const execution of persisted) this.ensureToolResult(threadId, execution);
    return persisted;
  }

  private latestActiveBatch(threadId: string): { batchId: string; calls: ToolCall[] } | null {
    const latest = this.store.modelOutputForThread(threadId);
    const payload = latest?.payload;
    if (!payload?.batchId || payload.toolCalls.length === 0) return null;
    const executions = this.store.listExecutionsByBatch(payload.batchId);
    if (executions.length !== payload.toolCalls.length) return null;
    const needsRepair = executions.some(
      (execution) => terminalStatus(execution.status) && !this.store.hasToolResult(execution.id),
    );
    const active = executions.some((execution) => execution.status === 'pending' || execution.status === 'running');
    return needsRepair || active ? { batchId: payload.batchId, calls: payload.toolCalls } : null;
  }

  private needsModelStep(threadId: string): boolean {
    const latestAssistant = this.store.modelOutputForThread(threadId);
    if (!latestAssistant) return this.store.hasMessage(threadId);
    if (latestAssistant.payload.toolCalls.length > 0) {
      const executions = this.store.listExecutionsByBatch(latestAssistant.payload.batchId ?? '');
      return (
        executions.length === latestAssistant.payload.toolCalls.length &&
        executions.every((execution) => terminalStatus(execution.status) && this.store.hasToolResult(execution.id))
      );
    }
    return this.store.hasMessageAfter(threadId, latestAssistant.payload.projectionThrough);
  }

  private hasUnprocessedWork(threadId: string): boolean {
    return Boolean(this.latestActiveBatch(threadId) || this.needsModelStep(threadId));
  }

  private async runModelStep(thread: Thread): Promise<void> {
    const modelExecutionId = randomUUID();
    const projectionRecords = this.store.listRecords(thread.id).map((record) => deepFreeze(record));
    const through = projectionRecords.at(-1)?.seq ?? 0;
    this.store.createModelExecution(modelExecutionId, thread.id, through);
    const running = this.store.transitionExecution(modelExecutionId, 'running');
    this.executionChanged(running);
    const controller = new AbortController();
    this.modelSignals.set(modelExecutionId, controller);
    let latestDraft = '';
    try {
      const modelSettings = this.getModelSettings();
      const toolSurface = await this.toolSurfaceFor(thread);
      const baseProjection: ProjectionInput = {
        thread,
        records: projectionRecords,
        through,
        systemPrompt: `${baseSystemPrompt}\n\n${thread.executorKind === 'runtime' ? 'This Thread uses Chat mode. It has no project workspace, filesystem, shell, or external execution environment. It can use tools provided by Runtime plugins.' : ''}\n\nCurrent Thread ID: ${thread.id}\n${thread.parentThreadId ? `Parent Thread ID: ${thread.parentThreadId}` : 'This Thread has no parent.'}`,
        turns: this.projectTurns(projectionRecords, thread),
        tools: toolSurface.tools,
        toolSources: toolSurface.sources,
      };
      const projected = await this.pipelines.run('projection', baseProjection, async (value) => value);
      const projectedTools = projected.tools;
      const prompt: ModelPrompt = {
        system: projected.systemPrompt,
        turns: projected.turns,
        tools: projectedTools,
        model: modelSettings.model,
        temperature: modelSettings.temperature,
      };
      let requestId: string | null = null;
      const recordModelInput: ModelStageInput['recordModelInput'] = (actualPrompt, provider) => {
        if (requestId) return;
        requestId = randomUUID();
        this.store.appendExecutionLog(modelExecutionId, 'model-input-requested', {
          requestId,
          prompt: structuredClone(actualPrompt),
          provider,
        });
      };
      const modelInput: ModelStageInput = {
        thread,
        provider: modelSettings.provider,
        prompt,
        signal: controller.signal,
        onText: (delta: string) => {
          latestDraft += delta;
          this.publish({ type: 'model.delta', threadId: thread.id, executionId: modelExecutionId, delta });
        },
        recordModelInput,
      };
      let response: ModelResponse;
      try {
        response = await this.pipelines.run<ModelStageInput, ModelResponse>('model', modelInput, async (input) => {
          input.recordModelInput(input.prompt, input.provider);
          return this.model.complete(input.prompt, modelSettings, input.signal, input.onText);
        });
        if (requestId)
          this.store.appendExecutionLog(modelExecutionId, 'model-input-settled', { requestId, status: 'completed' });
      } catch (error) {
        if (requestId)
          this.store.appendExecutionLog(modelExecutionId, 'model-input-settled', {
            requestId,
            status:
              controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
                ? 'interrupted'
                : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
      if (thread.executorKind === 'runtime') {
        const exposedTools = new Set(projectedTools.map((tool) => tool.name));
        const unavailableCalls = response.toolCalls.filter((call) => !exposedTools.has(call.name));
        if (unavailableCalls.length > 0) {
          throw new Error(
            `Chat mode cannot run unavailable tools: ${unavailableCalls.map((call) => call.name).join(', ')}.`,
          );
        }
      }
      const hitOutputLimit = response.finishReason === 'length';
      const seenCallIds = new Set<string>();
      const calls = (hitOutputLimit ? [] : response.toolCalls).map((call, index) => {
        const proposed = call.id.trim();
        const id = proposed && !seenCallIds.has(proposed) ? proposed : `${modelExecutionId}:tool:${index}`;
        seenCallIds.add(id);
        return { ...call, id };
      });
      const batchId = calls.length > 0 ? `${modelExecutionId}:batch` : null;
      const payload: AssistantPayload = {
        content: response.content,
        toolCalls: calls,
        batchId,
        projectionThrough: through,
        usage: response.usage,
        model: response.model,
        finishReason: response.finishReason,
      };
      const toolExecutions = calls.map((call) => ({
        call,
        executionId: `${thread.id}:${modelExecutionId}:${call.id}`,
      }));
      this.store.commitModelStep({
        assistantRecordId: `${modelExecutionId}:assistant`,
        modelExecutionId,
        threadId: thread.id,
        payload,
        toolCalls: toolExecutions,
      });
      if (hitOutputLimit && !this.store.getThread(thread.id)?.pauseRequested) {
        this.store.setPause(
          thread.id,
          true,
          'The model reached its output token limit. Review the response, adjust the model or context, then Continue.',
        );
      }
      const committedModelExecution = this.store.getExecution(modelExecutionId);
      if (committedModelExecution) this.executionChanged(committedModelExecution);
      for (const item of toolExecutions) {
        const execution = this.store.getExecution(item.executionId);
        if (execution) this.executionChanged(execution);
      }
    } catch (error) {
      const current = this.store.getExecution(modelExecutionId);
      const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (current && !terminalStatus(current.status)) {
        const settled = this.store.transitionExecution(modelExecutionId, interrupted ? 'interrupted' : 'failed', {
          error: error instanceof Error ? error.message : String(error),
          detail: { partialOutputDiscarded: latestDraft.length > 0 },
        });
        this.executionChanged(settled);
      }
      this.publish({ type: 'model.draft-ended', threadId: thread.id, executionId: modelExecutionId });
      if (!interrupted) {
        const reason = error instanceof Error ? error.message : String(error);
        this.store.setPause(thread.id, true, `Model step failed: ${reason}`);
        this.publish({ type: 'runtime.error', threadId: thread.id, message: reason });
      }
    } finally {
      this.modelSignals.delete(modelExecutionId);
    }
  }

  private projectTurns(records: readonly CanonicalRecord[], thread: Thread): PromptTurn[] {
    const recordIds = new Set(records.map((record) => record.id));
    const results = new Map<string, ToolResultPayload>();
    for (const record of records) {
      if (record.kind === 'tool_result') {
        const payload = record.payload as unknown as ToolResultPayload;
        results.set(`${payload.batchId}:${payload.toolCallId}`, payload);
      }
    }
    const consumedResults = new Set<string>();
    const turns: PromptTurn[] = [];
    for (const record of records) {
      if (record.kind === 'message') {
        const message = record.payload as unknown as MessagePayload;
        turns.push({ kind: 'message', role: 'user', content: projectMessageContent(message, thread) });
      } else if (record.kind === 'assistant') {
        const assistant = record.payload as unknown as AssistantPayload;
        if (assistant.toolCalls.length > 0) {
          turns.push({ kind: 'assistant_tools', content: assistant.content, calls: assistant.toolCalls });
          for (const call of assistant.toolCalls) {
            const result = assistant.batchId ? results.get(`${assistant.batchId}:${call.id}`) : undefined;
            if (result) {
              const resultRecordId = `${result.executionId}:result`;
              if (recordIds.has(resultRecordId)) consumedResults.add(resultRecordId);
              turns.push({
                kind: 'tool_result',
                callId: call.id,
                toolName: call.name,
                content: stringifyToolResult(result),
              });
            }
          }
        } else if (assistant.content) {
          turns.push({ kind: 'message', role: 'assistant', content: assistant.content });
        }
      } else if (record.kind === 'tool_result' && !consumedResults.has(record.id)) {
        const result = record.payload as unknown as ToolResultPayload;
        turns.push({
          kind: 'tool_result',
          callId: result.toolCallId,
          toolName: result.toolName,
          content: stringifyToolResult(result),
        });
      }
    }
    return turns;
  }

  private async toolSurfaceFor(thread: Thread): Promise<{
    tools: ToolDefinition[];
    sources: Record<string, 'runtime' | 'executor'>;
  }> {
    const runtimeTools = this.tools.listBySource('runtime').map((tool) => tool.definition);
    const tools = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const sources: Record<string, 'runtime' | 'executor'> = Object.fromEntries(
      runtimeTools.map((tool) => [tool.name, 'runtime']),
    );
    if (thread.executorKind === 'runtime') return { tools: [...tools.values()], sources };

    const binding = this.store.executorForThread(thread.id);
    if (!binding) throw new Error('Executor binding is missing while discovering its Tools.');
    const adapter = this.adapterFor(binding);
    for (const definition of await adapter.listTools(binding)) {
      if (tools.has(definition.name)) {
        throw new Error(
          `Tool name collision: ${definition.name} is registered by both Runtime and ${binding.label} Executor sources.`,
        );
      }
      tools.set(definition.name, definition);
      sources[definition.name] = 'executor';
    }
    return { tools: [...tools.values()], sources };
  }

  private async executeToolCall(thread: Thread, call: ToolCall): Promise<Execution> {
    const assistant = this.store.modelOutputForThread(thread.id);
    if (!assistant) throw new Error('Tool call has no committed Model Step');
    const executionId = `${thread.id}:${assistant.id.replace(/:assistant$/, '')}:${call.id}`;
    let execution = this.store.getExecution(executionId);
    if (!execution) throw new Error(`Tool execution ${executionId} was not durably prepared`);
    if (terminalStatus(execution.status)) {
      this.ensureToolResult(thread.id, execution);
      return execution;
    }
    const registered = this.tools.get(call.name);
    const controller = new AbortController();
    const run = { promise: Promise.resolve(execution), controller, toolStarted: false };
    const input: ToolInvocationInput = {
      thread,
      call,
      executionId,
      signal: controller.signal,
      toolSource: registered?.source ?? (thread.executorKind === 'runtime' ? 'runtime' : 'executor'),
      fail: async (reason, result) => {
        const current = this.store.getExecution(executionId);
        if (!current) throw new Error(`Tool Execution ${executionId} disappeared before it could fail.`);
        if (terminalStatus(current.status)) return current;
        const failed = this.store.transitionExecution(executionId, 'failed', {
          error: reason,
          ...(result === undefined ? {} : { result }),
        });
        if (!failed) throw new Error(`Tool Execution ${executionId} could not be failed.`);
        this.executionChanged(failed);
        return failed;
      },
      invoke: () => {
        run.toolStarted = true;
        return this.invokeTool(thread, executionId, registered, call, controller.signal);
      },
    };
    const promise = (async (): Promise<Execution> => {
      try {
        execution = await this.pipelines.run('toolInvocation', input, async (value) => value.invoke());
      } catch (error) {
        const latest = this.store.getExecution(executionId);
        if (!latest) throw error;
        if (!terminalStatus(latest.status) && !run.toolStarted && controller.signal.aborted) {
          if (!(error instanceof Error) || error.name !== 'AbortError') {
            execution = latest;
            throw error;
          }
          execution = this.store.transitionExecution(executionId, 'interrupted', {
            error: error instanceof Error ? error.message : 'Tool invocation interrupted.',
            detail: { userInterrupted: true },
          });
          this.executionChanged(execution);
        } else if (!terminalStatus(latest.status) && !run.toolStarted) {
          execution = this.store.transitionExecution(executionId, 'failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          this.executionChanged(execution);
        } else {
          execution = latest;
          if (!terminalStatus(latest.status)) {
            this.publish({
              type: 'runtime.notice',
              threadId: thread.id,
              message: `Tool ${call.name} did not report a durable outcome. Its ${latest.status} Execution state was preserved for recovery.`,
            });
          }
        }
      }
      if (terminalStatus(execution.status)) this.ensureToolResult(thread.id, execution);
      return execution;
    })().finally(() => this.invocationRuns.delete(executionId));
    run.promise = promise;
    this.invocationRuns.set(executionId, run);
    return promise;
  }

  private async invokeTool(
    thread: Thread,
    executionId: string,
    tool: ReturnType<typeof this.tools.get>,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error('Tool execution record is missing');
    if (terminalStatus(current.status)) return current;
    if (tool?.source === 'executor' || (!tool && thread.executorKind !== 'runtime')) {
      const binding = this.store.executorForThread(thread.id);
      if (!binding) throw new Error('Executor binding is missing');
      return this.adapterFor(binding).execute(executionId, binding);
    }
    const inFlight = this.runtimeToolRuns.get(executionId);
    if (inFlight) return inFlight.promise;
    if (current.status === 'running') {
      const lost = this.store.transitionExecution(executionId, 'interrupted', {
        error: 'Runtime confirmed this control tool is no longer active. Its result may be incomplete.',
        detail: { confirmedMissing: true },
      });
      this.executionChanged(lost);
      return lost;
    }
    if (!tool) {
      const failed = this.store.transitionExecution(executionId, 'failed', { error: `Unknown tool: ${call.name}` });
      this.executionChanged(failed);
      return failed;
    }
    const controller = new AbortController();
    const abortRuntimeTool = (): void => controller.abort();
    signal.addEventListener('abort', abortRuntimeTool, { once: true });
    if (signal.aborted) controller.abort();
    const started = this.store.transitionExecution(executionId, 'running');
    this.executionChanged(started);
    const context: ToolContext = {
      workspacePath: thread.workspacePath,
      executionId,
      signal: controller.signal,
      thread,
    };
    const promise = (async () => {
      try {
        const result = await tool.execute(call.arguments, context);
        const completed = this.store.transitionExecution(executionId, 'completed', { result });
        this.executionChanged(completed);
        return completed;
      } catch (error) {
        const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        const failed = this.store.transitionExecution(executionId, interrupted ? 'interrupted' : 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.executionChanged(failed);
        return failed;
      }
    })().finally(() => {
      signal.removeEventListener('abort', abortRuntimeTool);
      this.runtimeToolRuns.delete(executionId);
    });
    this.runtimeToolRuns.set(executionId, { promise, controller });
    return promise;
  }

  private ensureToolResult(threadId: string, execution: Execution): void {
    if (!terminalStatus(execution.status) || this.store.hasToolResult(execution.id)) return;
    const modelExecutionId = execution.batchId?.replace(/:batch$/, '');
    const executionPrefix = modelExecutionId ? `${threadId}:${modelExecutionId}:` : '';
    const toolCallId =
      executionPrefix && execution.id.startsWith(executionPrefix)
        ? execution.id.slice(executionPrefix.length)
        : execution.id;
    const payload: ToolResultPayload = {
      executionId: execution.id,
      toolCallId,
      batchId: execution.batchId ?? '',
      toolName: execution.toolName ?? 'unknown',
      status: execution.status,
      ...(execution.status === 'completed'
        ? { result: execution.result }
        : { error: execution.error ?? 'Execution ended without a result.' }),
    };
    this.store.appendToolResult(threadId, payload);
  }

  private adapterFor(binding: ExecutorBinding): ExecutorAdapter {
    if (binding.remoteConnectionId) return this.remoteHostExecutor;
    if (binding.kind === 'runtime') throw new Error('Chat mode does not submit work to an external Executor.');
    return binding.kind === 'container' ? this.containerExecutor : this.hostExecutor;
  }

  getModelSettings(): ModelSettings {
    const stored = this.store.getSetting<Record<string, unknown>>('model', {});
    return {
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : defaultModelSettings.baseUrl,
      apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : defaultModelSettings.apiKey,
      model: typeof stored.model === 'string' ? stored.model : defaultModelSettings.model,
      temperature: typeof stored.temperature === 'number' ? stored.temperature : defaultModelSettings.temperature,
      provider: typeof stored.provider === 'string' ? stored.provider : defaultModelSettings.provider,
    };
  }

  publicModelSettings(): PublicSettings {
    const settings = this.getModelSettings();
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      provider: settings.provider,
      hasApiKey: Boolean(settings.apiKey),
      modelsByProvider: {
        ...this.store.getSetting<Record<string, string>>('provider-models', {}),
        [settings.provider]: settings.model,
      },
    };
  }

  updateModelSettings(update: Partial<ModelSettings>): PublicSettings {
    const current = this.getModelSettings();
    const provider = update.provider ?? current.provider;
    const providerModels = this.store.getSetting<Record<string, string>>('provider-models', {});
    const next = {
      ...current,
      ...(provider !== current.provider ? { model: providerModels[provider] ?? '' } : {}),
      ...update,
    };
    if (!this.plugins.modelProviders().some((provider) => provider.id === next.provider)) {
      throw new Error(`Model provider ${next.provider} is not registered.`);
    }
    if (next.provider === 'openai-compatible') {
      if (!next.baseUrl.trim()) throw new Error('Base URL is required');
      try {
        new URL(next.baseUrl);
      } catch {
        throw new Error('Base URL must be a valid http or https URL');
      }
      if (!/^https?:$/.test(new URL(next.baseUrl).protocol)) throw new Error('Base URL must use http or https');
    }
    if (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2) {
      throw new Error('Temperature must be between 0 and 2');
    }
    this.store.transaction(() => {
      this.store.setSetting('provider-models', {
        ...providerModels,
        [current.provider]: current.model,
        [next.provider]: next.model,
      });
      this.store.setSetting('model', next);
    });
    this.publish({ type: 'settings.updated', settings: this.publicModelSettings() });
    return this.publicModelSettings();
  }

  availableCommands(): Array<{ name: string; description: string }> {
    return this.commands.list();
  }

  pluginInfo(): {
    plugins: ReturnType<PluginHost['list']>;
    ui: ReturnType<PluginHost['uiContributions']>;
    pages: ReturnType<PluginHost['uiPages']>;
    providers: ReturnType<PluginHost['modelProviders']>;
    pipelines: ReturnType<ExecutionPipelines['registrations']>;
    errors: string[];
  } {
    return {
      plugins: this.plugins.list(),
      ui: this.plugins.uiContributions(),
      pages: this.plugins.uiPages(),
      providers: this.plugins.modelProviders(),
      pipelines: this.pipelines.registrations(),
      errors: [...this.pluginLoadErrors],
    };
  }

  pluginHttpRoute(pluginId: string, method: string, path: string) {
    return this.plugins.findHttpRoute(pluginId, method, path);
  }

  async executorStatus(threadId: string): Promise<{ connected: boolean; kind: string; label: string; error?: string }> {
    const binding = this.store.executorForThread(threadId);
    if (!binding) throw new Error('Executor binding is missing');
    if (binding.kind === 'runtime') return { connected: true, kind: 'runtime', label: 'Chat' };
    try {
      await this.adapterFor(binding).checkConnection(binding);
      return {
        connected: true,
        kind: binding.remoteConnectionId ? 'remote-host' : binding.kind,
        label: binding.label,
      };
    } catch (error) {
      return {
        connected: false,
        kind: binding.remoteConnectionId ? 'remote-host' : binding.kind,
        label: binding.label,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async drain(): Promise<void> {
    while (this.loops.size > 0) await Promise.all([...this.loops.values()]);
  }
}
