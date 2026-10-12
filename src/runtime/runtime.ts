import { randomUUID } from 'node:crypto';
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
  PermissionRequest,
  Project,
  PublicSettings,
  Thread,
  ThreadState,
  ToolCall,
  ToolDefinition,
  ToolResultPayload,
} from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { ExecutionPipelines } from '../core/pipeline.js';
import { ContainerExecutor } from '../executor/container-executor.js';
import { HostExecutor } from '../executor/executor.js';
import { createToolCatalog, type ToolContext } from '../executor/tools.js';
import { builtinPlugins } from '../plugins/builtin.js';
import { CommandRegistry, PluginHost, type CommandResult } from '../plugins/host.js';
import { OpenAiCompatibleAdapter, type ModelAdapter, type ModelPrompt, type PromptTurn } from './model.js';
import type { PermissionPolicy, ProjectionInput, ToolInvocationInput } from './stages.js';
import type { PicoPlugin } from '../plugins/host.js';

export interface RuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface ThreadSnapshot {
  thread: Thread;
  records: CanonicalRecord[];
  executions: Execution[];
  approvals: PermissionRequest[];
  children: Thread[];
}

export interface SubmitResult {
  accepted: boolean;
  duplicate?: boolean;
  command?: CommandResult;
}

const defaultModelSettings: ModelSettings = {
  baseUrl: process.env.PICO_MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.PICO_MODEL_API_KEY ?? '',
  model: process.env.PICO_MODEL ?? '',
  temperature: 0.2,
};

const baseSystemPrompt = `You are Pico, an agent working in one durable Thread. Use the available tools when they help you inspect or change the selected workspace.\n\nTools in one model step may run concurrently. Their results arrive together before the next step. A tool result marked interrupted means its real-world side effects may be partial or unknown: inspect the environment before deciding whether to retry.\n\nA Thread stays bound to its displayed Executor for its lifetime. To work in parallel, spawn a child Thread; spawning returns immediately. Child Threads and their parent communicate with ordinary messages. A child can send a message to its parent Thread ID shown below. Do not wait for a child unless you have other useful work to do.\n\nNew user messages can arrive while you work. They will appear at the next model step; finish the current tool batch first.`;

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

function terminalStatus(status: ExecutionStatus): status is 'completed' | 'failed' | 'interrupted' {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export interface RuntimeOptions {
  model?: ModelAdapter;
  plugins?: PicoPlugin[];
  pluginDirectory?: string;
}

export class PicoRuntime {
  readonly store: PicoStore;
  readonly tools = createToolCatalog();
  readonly pipelines = new ExecutionPipelines();
  readonly commands = new CommandRegistry();
  readonly plugins: PluginHost;
  private readonly model: ModelAdapter;
  private readonly additionalPlugins: PicoPlugin[];
  private readonly hostExecutor: HostExecutor;
  private readonly containerExecutor: ContainerExecutor;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly modelSignals = new Map<string, AbortController>();
  private readonly runtimeToolRuns = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private readonly approvalWaiters = new Map<string, Set<(allow: boolean) => void>>();
  private pluginLoadErrors: string[] = [];

  constructor(store = new PicoStore(), options: RuntimeOptions = {}) {
    this.store = store;
    this.model = options.model ?? new OpenAiCompatibleAdapter();
    this.additionalPlugins = options.plugins ?? [];
    this.hostExecutor = new HostExecutor(store, this.tools, (execution) => this.executionChanged(execution));
    this.containerExecutor = new ContainerExecutor(store, this.tools, (execution) => this.executionChanged(execution));
    this.plugins = new PluginHost(store, this.tools, this.pipelines, this.commands, options.pluginDirectory);
    this.registerControlTools();
  }

  async initialize(): Promise<void> {
    await this.plugins.load([...builtinPlugins, ...this.additionalPlugins]);
    this.pluginLoadErrors = this.plugins.errors();
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
      if (!thread.pauseRequested) this.startLoop(thread.id);
    }
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

  getSnapshot(threadId: string): ThreadSnapshot | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    return {
      thread,
      records: this.store.listRecords(threadId),
      executions: this.store.listExecutions(threadId),
      approvals: this.store.listApprovals(threadId),
      children: this.listThreads(thread.projectId).filter((candidate) => candidate.parentThreadId === threadId),
    };
  }

  async submit(threadId: string, id: string, content: string): Promise<SubmitResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    if (content.trimStart().startsWith('/')) {
      const command = await this.commands.execute(content.trim(), {
        thread: this.getThread(threadId),
        projectId: thread.projectId,
      });
      if (command) return { accepted: true, command };
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
      this.publishRecord(result.record);
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
    for (const execution of this.store.listActiveExecutions(threadId)) {
      if (execution.kind === 'model') continue;
      const approval = this.store.getApproval(execution.id);
      if (approval?.status === 'pending') {
        const cancelled = this.store.interruptPendingApproval(execution.id);
        const record = this.store.appendPluginRecord(threadId, 'pico.permissions', {
          action: 'cancel',
          executionId: execution.id,
          toolName: cancelled.approval.toolName,
          reason: 'user_interrupt',
        });
        this.publishRecord(record);
        this.publish({ type: 'approval.updated', approval: cancelled.approval });
        this.executionChanged(cancelled.execution);
        this.ensureToolResult(threadId, cancelled.execution);
        this.resolveApprovalWaiters(execution.id, false);
        continue;
      }
      const tool = execution.toolName ? this.tools.get(execution.toolName) : undefined;
      if (tool?.source === 'runtime') {
        const active = this.runtimeToolRuns.get(execution.id);
        if (active) active.controller.abort();
        else if (execution.status === 'pending' || execution.status === 'running') {
          const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
            error: 'Runtime confirmed this control tool will not continue after the explicit Interrupt request.',
            detail: { userInterrupted: true },
          });
          this.executionChanged(interrupted);
        }
        continue;
      }
      if (execution.status === 'pending') {
        const interrupted = this.store.transitionExecution(execution.id, 'interrupted', {
          error: 'The execution had not started when the user explicitly interrupted it.',
          detail: { userInterrupted: true },
        });
        this.executionChanged(interrupted);
        continue;
      }
      const binding = this.store.executorForThread(threadId);
      if (!binding) continue;
      try {
        const adapter = this.adapterFor(binding);
        const updated = await adapter.interrupt(execution.id, binding);
        if (updated) this.executionChanged(updated);
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
    if (this.loops.has(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.pauseRequested) return;
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
      const thread = this.store.getThread(threadId);
      if (!thread) return;
      const activeBatch = this.latestActiveBatch(threadId);
      if (activeBatch) {
        const settled = await this.pipelines.run(
          'toolBatch',
          {
            thread,
            batchId: activeBatch.batchId,
            calls: activeBatch.calls,
            perform: () => Promise.all(activeBatch.calls.map((call) => this.executeToolCall(thread, call))),
          },
          (input) => input.perform(),
        );
        const stillActive = settled.some(
          (execution) => execution.status === 'pending' || execution.status === 'running',
        );
        if (stillActive) {
          if (!this.store.getThread(threadId)?.pauseRequested) {
            this.store.setPause(
              threadId,
              true,
              `Executor ${thread.executorLabel} is unreachable or still needs attention. Execution state is preserved.`,
            );
          }
          this.publishThreadUpdate(threadId);
          return;
        }
        for (const execution of settled) this.ensureToolResult(threadId, execution);
        if (this.store.getThread(threadId)?.pauseRequested) return;
        iteration += 1;
        continue;
      }
      if (thread.pauseRequested || !this.needsModelStep(threadId)) return;
      const input = { thread, iteration, perform: () => this.runModelStep(thread) };
      await this.pipelines.run('step', input, (value) => value.perform());
      iteration += 1;
    }
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
    const records = this.store.listRecords(threadId);
    const latestAssistant = [...records].reverse().find((record) => record.kind === 'assistant') as
      CanonicalRecord<AssistantPayload> | undefined;
    if (!latestAssistant) return records.some((record) => record.kind === 'message');
    if (latestAssistant.payload.toolCalls.length > 0) {
      const executions = this.store.listExecutionsByBatch(latestAssistant.payload.batchId ?? '');
      return (
        executions.length === latestAssistant.payload.toolCalls.length &&
        executions.every((execution) => terminalStatus(execution.status) && this.store.hasToolResult(execution.id))
      );
    }
    return records.some(
      (record) => record.kind === 'message' && record.seq > latestAssistant.payload.projectionThrough,
    );
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
      const baseProjection: ProjectionInput = {
        thread,
        records: projectionRecords,
        through,
        systemPrompt: `${baseSystemPrompt}\n\nCurrent Thread ID: ${thread.id}\n${thread.parentThreadId ? `Parent Thread ID: ${thread.parentThreadId}` : 'This Thread has no parent.'}`,
        turns: this.projectTurns(projectionRecords),
        tools: this.visibleToolDefinitions(thread),
      };
      const projected = await this.pipelines.run('projection', baseProjection, async (value) => value);
      const prompt: ModelPrompt = {
        system: projected.systemPrompt,
        turns: projected.turns,
        tools: projected.tools,
        model: modelSettings.model,
        temperature: modelSettings.temperature,
      };
      const response = await this.pipelines.run(
        'model',
        {
          thread,
          prompt,
          signal: controller.signal,
          onText: (delta: string) => {
            latestDraft += delta;
            this.publish({ type: 'model.delta', threadId: thread.id, executionId: modelExecutionId, delta });
          },
          perform: () =>
            this.model.complete(prompt, modelSettings, controller.signal, (delta) => {
              latestDraft += delta;
              this.publish({ type: 'model.delta', threadId: thread.id, executionId: modelExecutionId, delta });
            }),
        },
        (input) => input.perform(),
      );
      const seenCallIds = new Set<string>();
      const calls = response.toolCalls.map((call, index) => {
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
      };
      const toolExecutions = calls.map((call) => ({
        call,
        executionId: `${thread.id}:${modelExecutionId}:${call.id}`,
      }));
      const record = this.store.commitModelStep({
        assistantRecordId: `${modelExecutionId}:assistant`,
        modelExecutionId,
        threadId: thread.id,
        payload,
        toolCalls: toolExecutions,
      });
      this.publishRecord(record);
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

  private projectTurns(records: readonly CanonicalRecord[]): PromptTurn[] {
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
        turns.push({ kind: 'message', role: 'user', content: message.content });
      } else if (record.kind === 'assistant') {
        const assistant = record.payload as unknown as AssistantPayload;
        if (assistant.toolCalls.length > 0) {
          turns.push({ kind: 'assistant_tools', content: assistant.content, calls: assistant.toolCalls });
          for (const call of assistant.toolCalls) {
            const result = assistant.batchId ? results.get(`${assistant.batchId}:${call.id}`) : undefined;
            if (result) {
              const resultRecord = records.find((candidate) => candidate.id === `${result.executionId}:result`);
              if (resultRecord) consumedResults.add(resultRecord.id);
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

  private visibleToolDefinitions(thread: Thread): ToolDefinition[] {
    return this.tools.list().filter((definition) => this.permissionPolicy(thread, definition.name) !== 'deny');
  }

  private permissionPolicy(thread: Thread, toolName: string): PermissionPolicy {
    const rules = this.store.getSetting<Record<string, PermissionPolicy>>(`permissions:${thread.id}`, {});
    const configured = rules[toolName];
    if (configured === 'allow' || configured === 'deny' || configured === 'ask') return configured;
    const tool = this.tools.get(toolName);
    if (!tool || tool.source === 'runtime') return 'allow';
    return thread.executorKind === 'host' ? 'ask' : 'allow';
  }

  toolPermissions(threadId: string): Array<{ name: string; description: string; policy: PermissionPolicy }> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    return this.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      policy: this.permissionPolicy(thread, tool.name),
    }));
  }

  setToolPermission(threadId: string, toolName: string, policy: PermissionPolicy): void {
    if (!this.store.getThread(threadId)) throw new Error('Thread not found');
    if (!this.tools.get(toolName)) throw new Error('Tool not found');
    if (policy !== 'allow' && policy !== 'deny' && policy !== 'ask') throw new Error('Invalid permission policy');
    const key = `permissions:${threadId}`;
    const rules = this.store.getSetting<Record<string, PermissionPolicy>>(key, {});
    this.store.setSetting(key, { ...rules, [toolName]: policy });
    this.publish({ type: 'permissions.updated', threadId, permissions: this.toolPermissions(threadId) });
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
    const policy = this.permissionPolicy(thread, call.name);
    const input: ToolInvocationInput = {
      thread,
      call,
      executionId,
      policy,
      requestApproval: () => this.requestApproval(executionId),
      deny: async (reason) => {
        const current = this.store.getExecution(executionId);
        if (current && !terminalStatus(current.status)) {
          execution = this.store.transitionExecution(executionId, 'failed', {
            error: reason,
            result: { denied: true },
          });
          const record = this.store.appendPluginRecord(thread.id, 'pico.permissions', {
            action: 'decision',
            executionId,
            toolName: call.name,
            decision: 'deny',
            reason,
          });
          this.publishRecord(record);
          this.executionChanged(execution);
        }
        return this.store.getExecution(executionId)!;
      },
      invoke: () => this.invokeTool(thread, executionId, registered, call),
    };
    try {
      execution = await this.pipelines.run('toolInvocation', input, async (value) => value.invoke());
    } catch (error) {
      const latest = this.store.getExecution(executionId);
      if (!latest) throw error;
      if (latest.status === 'pending' || latest.status === 'running') {
        this.publish({
          type: 'runtime.notice',
          threadId: thread.id,
          message: error instanceof Error ? error.message : String(error),
        });
        return latest;
      }
      execution = latest;
    }
    if (terminalStatus(execution.status)) this.ensureToolResult(thread.id, execution);
    return execution;
  }

  private async requestApproval(executionId: string): Promise<boolean> {
    const approval = this.store.createApproval(executionId);
    this.publish({ type: 'approval.updated', approval });
    if (approval.status === 'allowed') return true;
    if (approval.status === 'denied' || approval.status === 'cancelled') return false;
    return new Promise<boolean>((resolvePromise) => {
      const waiters = this.approvalWaiters.get(executionId) ?? new Set<(allow: boolean) => void>();
      waiters.add(resolvePromise);
      this.approvalWaiters.set(executionId, waiters);
      const latest = this.store.getApproval(executionId);
      if (latest && latest.status !== 'pending') this.resolveApprovalWaiters(executionId, latest.status === 'allowed');
    });
  }

  resolveApproval(executionId: string, allow: boolean, rememberForThread = false): PermissionRequest {
    const before = this.store.getApproval(executionId);
    if (rememberForThread) {
      if (!allow) throw new Error('A denied approval cannot create an allow rule');
      if (!before) throw new Error('Approval request not found');
      if (before.status === 'denied') throw new Error('Approval was already resolved');
      if (before.status === 'cancelled') throw new Error('Approval was cancelled');
      this.setToolPermission(before.threadId, before.toolName, 'allow');
    }
    const approval = this.store.resolveApproval(executionId, allow);
    if (before?.status === 'pending') {
      const record = this.store.appendPluginRecord(approval.threadId, 'pico.permissions', {
        action: 'decision',
        executionId,
        toolName: approval.toolName,
        decision: allow ? 'allow' : 'deny',
        scope: rememberForThread ? 'thread' : 'once',
      });
      this.publishRecord(record);
    }
    this.resolveApprovalWaiters(executionId, allow);
    this.publish({ type: 'approval.updated', approval });
    return approval;
  }

  private resolveApprovalWaiters(executionId: string, allow: boolean): void {
    const waiters = this.approvalWaiters.get(executionId);
    if (!waiters) return;
    this.approvalWaiters.delete(executionId);
    for (const resolvePromise of waiters) resolvePromise(allow);
  }

  private async invokeTool(
    thread: Thread,
    executionId: string,
    tool: ReturnType<typeof this.tools.get>,
    call: ToolCall,
  ): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error('Tool execution record is missing');
    if (terminalStatus(current.status)) return current;
    if (tool?.source === 'executor') {
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
    })().finally(() => this.runtimeToolRuns.delete(executionId));
    this.runtimeToolRuns.set(executionId, { promise, controller });
    return promise;
  }

  private ensureToolResult(threadId: string, execution: Execution): void {
    if (!terminalStatus(execution.status) || this.store.hasToolResult(execution.id)) return;
    const call = this.store
      .listRecords(threadId)
      .filter((record) => record.kind === 'assistant')
      .map((record) => record.payload as unknown as AssistantPayload)
      .flatMap((payload) => payload.toolCalls.map((toolCall) => ({ payload, toolCall })))
      .find(
        ({ payload, toolCall }) =>
          payload.batchId === execution.batchId &&
          `${threadId}:${payload.batchId?.replace(/:batch$/, '')}:${toolCall.id}` === execution.id,
      );
    const toolCallId = call?.toolCall.id ?? execution.id;
    const payload: ToolResultPayload = {
      executionId: execution.id,
      toolCallId,
      batchId: execution.batchId ?? '',
      toolName: execution.toolName ?? call?.toolCall.name ?? 'unknown',
      status: execution.status,
      ...(execution.status === 'completed'
        ? { result: execution.result }
        : { error: execution.error ?? 'Execution ended without a result.' }),
    };
    const appended = this.store.appendToolResult(threadId, payload);
    this.publishRecord(appended);
  }

  private adapterFor(binding: ExecutorBinding): HostExecutor | ContainerExecutor {
    return binding.kind === 'container' ? this.containerExecutor : this.hostExecutor;
  }

  private registerControlTools(): void {
    this.tools.register({
      owner: 'pico.core',
      source: 'runtime',
      definition: {
        name: 'spawn_thread',
        description:
          'Create a child Thread in this Project, send it an initial message, and return immediately without waiting for it.',
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string' }, title: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
      execute: async (args, context) => {
        const parent = context.thread;
        if (!parent) throw new Error('Thread context is missing');
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) throw new Error('Child Thread prompt is required');
        return this.spawnChild(parent, prompt, typeof args.title === 'string' ? args.title : undefined);
      },
    });
    this.tools.register({
      owner: 'pico.core',
      source: 'runtime',
      definition: {
        name: 'send_thread_message',
        description:
          'Send a normal message to another Thread in this Project. This does not wait for that Thread to finish.',
        parameters: {
          type: 'object',
          properties: { thread_id: { type: 'string' }, message: { type: 'string' } },
          required: ['thread_id', 'message'],
          additionalProperties: false,
        },
      },
      execute: async (args, context) => {
        const sender = context.thread;
        if (!sender) throw new Error('Thread context is missing');
        const targetId = typeof args.thread_id === 'string' ? args.thread_id : '';
        const message = typeof args.message === 'string' ? args.message.trim() : '';
        if (!targetId || !message) throw new Error('thread_id and message are required');
        const target = this.store.getThread(targetId);
        if (!target || target.projectId !== sender.projectId)
          throw new Error('Target Thread must belong to the same Project');
        if (target.id === sender.id)
          throw new Error('Use ordinary assistant text instead of sending a message to the current Thread');
        const payload: MessagePayload = {
          role: 'user',
          content: message,
          source: 'child',
          senderThreadId: sender.id,
          senderLabel: sender.title,
        };
        const result = this.postMessage(target, randomUUID(), payload);
        return { delivered: result.inserted, threadId: target.id, messageId: result.record.id };
      },
    });
  }

  private spawnChild(
    parent: Thread,
    prompt: string,
    requestedTitle?: string,
  ): { threadId: string; title: string; executor: string } {
    const title = requestedTitle?.trim() || prompt.slice(0, 72) || 'Child Thread';
    const child = this.store.createThread(parent.projectId, parent.executorKind, title, {
      parentThreadId: parent.id,
      createdByAgent: true,
    });
    this.publish({ type: 'thread.created', thread: child });
    this.postMessage(child, randomUUID(), {
      role: 'user',
      content: prompt,
      source: 'agent',
      senderThreadId: parent.id,
      senderLabel: parent.title,
    });
    return { threadId: child.id, title: child.title, executor: child.executorLabel };
  }

  getModelSettings(): ModelSettings {
    const stored = this.store.getSetting<Partial<ModelSettings>>('model', {});
    return { ...defaultModelSettings, ...stored };
  }

  publicModelSettings(): PublicSettings {
    const settings = this.getModelSettings();
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      hasApiKey: Boolean(settings.apiKey),
    };
  }

  updateModelSettings(update: Partial<ModelSettings>): PublicSettings {
    const current = this.getModelSettings();
    const next = { ...current, ...update };
    if (!next.baseUrl.trim()) throw new Error('Base URL is required');
    try {
      new URL(next.baseUrl);
    } catch {
      throw new Error('Base URL must be a valid http or https URL');
    }
    if (!/^https?:$/.test(new URL(next.baseUrl).protocol)) throw new Error('Base URL must use http or https');
    if (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2) {
      throw new Error('Temperature must be between 0 and 2');
    }
    this.store.setSetting('model', next);
    this.publish({ type: 'settings.updated', settings: this.publicModelSettings() });
    return this.publicModelSettings();
  }

  availableCommands(): Array<{ name: string; description: string }> {
    return this.commands.list();
  }

  pluginInfo(): {
    plugins: ReturnType<PluginHost['list']>;
    ui: ReturnType<PluginHost['uiContributions']>;
    pipelines: ReturnType<ExecutionPipelines['registrations']>;
    errors: string[];
  } {
    return {
      plugins: this.plugins.list(),
      ui: this.plugins.uiContributions(),
      pipelines: this.pipelines.registrations(),
      errors: [...this.pluginLoadErrors],
    };
  }

  async executorStatus(threadId: string): Promise<{ connected: boolean; kind: string; label: string; error?: string }> {
    const binding = this.store.executorForThread(threadId);
    if (!binding) throw new Error('Executor binding is missing');
    try {
      await this.adapterFor(binding).checkConnection(binding);
      return { connected: true, kind: binding.kind, label: binding.label };
    } catch (error) {
      return {
        connected: false,
        kind: binding.kind,
        label: binding.label,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async drain(): Promise<void> {
    while (this.loops.size > 0) await Promise.all([...this.loops.values()]);
  }
}
