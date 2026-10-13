import type { Execution, ExecutorBinding, ExecutorKind } from '../core/types.js';
import type { ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { ToolCatalog } from './tools.js';

export interface ExecutorAdapter {
  readonly kind: ExecutorKind;
  listTools(binding: ExecutorBinding): Promise<ToolDefinition[]>;
  checkConnection(binding: ExecutorBinding): Promise<void>;
  execute(executionId: string, binding: ExecutorBinding, signal?: AbortSignal): Promise<Execution>;
  status(executionId: string, binding: ExecutorBinding): Promise<Execution | null>;
  interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null>;
}

export type ExecutionListener = (execution: Execution) => void;

export class HostExecutor implements ExecutorAdapter {
  readonly kind = 'host' as const;
  private readonly inFlight = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private shuttingDown = false;

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly onExecution: ExecutionListener = () => undefined,
  ) {}

  async checkConnection(_binding: ExecutorBinding): Promise<void> {
    return;
  }

  async listTools(_binding: ExecutorBinding): Promise<ToolDefinition[]> {
    return this.tools.listBySource('executor').map(({ definition }) => definition);
  }

  async execute(executionId: string, binding: ExecutorBinding, externalSignal?: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const active = this.inFlight.get(executionId);
    if (active) return active.promise;
    if (this.shuttingDown) return current;
    if (current.status === 'running') return this.confirmLost(executionId);

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', relayAbort, { once: true });
    const started = this.store.transitionExecution(executionId, 'running');
    this.onExecution(started);
    const promise = this.runTool(executionId, binding, controller.signal).finally(() => {
      externalSignal?.removeEventListener('abort', relayAbort);
      this.inFlight.delete(executionId);
    });
    this.inFlight.set(executionId, { promise, controller });
    return promise;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const active = [...this.inFlight.values()];
    for (const execution of active) execution.controller.abort();
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  async status(executionId: string, _binding: ExecutorBinding): Promise<Execution | null> {
    const execution = this.store.getExecution(executionId);
    if (!execution) return null;
    if (execution.status === 'running' && !this.inFlight.has(executionId)) return this.confirmLost(executionId);
    return execution;
  }

  async interrupt(executionId: string, _binding: ExecutorBinding): Promise<Execution | null> {
    const active = this.inFlight.get(executionId);
    if (active) {
      active.controller.abort();
      return active.promise;
    }
    const current = this.store.getExecution(executionId);
    if (current?.status === 'running') return this.confirmLost(executionId);
    return current;
  }

  private async confirmLost(executionId: string): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} not found`);
    if (current.status !== 'running') return current;
    const interrupted = this.store.transitionExecution(executionId, 'interrupted', {
      error: 'The Host Executor confirmed that this execution is no longer active.',
      detail: { confirmedMissing: true },
    });
    this.onExecution(interrupted);
    return interrupted;
  }

  private async runTool(executionId: string, binding: ExecutorBinding, signal: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId)!;
    const tool = current.toolName ? this.tools.get(current.toolName) : undefined;
    if (!tool || tool.source !== 'executor') {
      const failed = this.store.transitionExecution(executionId, 'failed', {
        error: `Executor tool “${current.toolName ?? 'unknown'}” is not registered.`,
      });
      this.onExecution(failed);
      return failed;
    }
    try {
      const result = await tool.execute(current.arguments ?? {}, {
        workspacePath: binding.workspacePath,
        executionId,
        signal,
      });
      const completed = this.store.transitionExecution(executionId, 'completed', { result });
      this.onExecution(completed);
      return completed;
    } catch (error) {
      const status =
        signal.aborted || (error instanceof Error && error.name === 'AbortError') ? 'interrupted' : 'failed';
      const settled = this.store.transitionExecution(executionId, status, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.onExecution(settled);
      return settled;
    }
  }
}
