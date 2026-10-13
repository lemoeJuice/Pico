import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import type { ExecutionListener, ExecutorAdapter } from './executor.js';
import { remoteExecutorUrl, type RemoteExecutionState, type RemoteExecutorInfo } from './remote-protocol.js';
import { validateToolDefinitions } from './plugin-host.js';
const requestTimeoutMs = 15_000;

function connection(binding: ExecutorBinding): { endpointUrl: string; accessToken: string } {
  const endpointUrl = binding.remoteEndpointUrl?.trim();
  const accessToken = binding.remoteAccessToken;
  if (!endpointUrl || !accessToken) throw new Error('Remote Executor connection details are missing.');
  return { endpointUrl, accessToken };
}

async function requestJson<T>(
  endpointUrl: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(remoteExecutorUrl(endpointUrl, path), {
      ...init,
      redirect: 'error',
      signal: combinedSignal,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
    throw new Error(`Remote Executor request failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (response.ok) {
      throw new Error('Remote Executor request failed: response body was not valid JSON.', { cause: error });
    }
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Remote Executor returned HTTP ${response.status}.`;
    const error = new Error(message);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return payload as T;
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new DOMException('Remote Executor request interrupted locally.', 'AbortError'));
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Remote Executor request interrupted locally.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function inspectRemoteExecutor(endpointUrl: string, accessToken: string): Promise<RemoteExecutorInfo> {
  if (Buffer.byteLength(accessToken) < 32) throw new Error('Remote Executor token must contain at least 32 bytes.');
  const info = await requestJson<RemoteExecutorInfo>(endpointUrl, accessToken, '/api/info');
  if (
    !info ||
    info.protocolVersion !== 1 ||
    info.kind !== 'host' ||
    typeof info.name !== 'string' ||
    typeof info.workspaceRoot !== 'string' ||
    !Array.isArray(info.tools)
  ) {
    throw new Error('The endpoint did not identify itself as a compatible Pico Executor (protocol version 1).');
  }
  info.tools = validateToolDefinitions(info.tools);
  return info;
}

export async function validateRemoteWorkspace(
  endpointUrl: string,
  accessToken: string,
  workspacePath: string,
): Promise<string> {
  const response = await requestJson<{ path?: unknown }>(endpointUrl, accessToken, '/api/workspaces/validate', {
    method: 'POST',
    body: JSON.stringify({ path: workspacePath }),
  });
  if (typeof response.path !== 'string' || !response.path)
    throw new Error('Remote Executor returned no workspace path.');
  return response.path;
}

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<Execution>;
}

export class RemoteHostExecutor implements ExecutorAdapter {
  readonly kind = 'host' as const;
  private readonly inFlight = new Map<string, ActiveExecution>();

  constructor(
    private readonly store: PicoStore,
    private readonly onExecution: ExecutionListener = () => undefined,
  ) {}

  async listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    const { endpointUrl, accessToken } = connection(binding);
    return (await inspectRemoteExecutor(endpointUrl, accessToken)).tools;
  }

  async checkConnection(binding: ExecutorBinding): Promise<void> {
    const { endpointUrl, accessToken } = connection(binding);
    await inspectRemoteExecutor(endpointUrl, accessToken);
  }

  async execute(executionId: string, binding: ExecutorBinding): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const active = this.inFlight.get(executionId);
    if (active) return active.promise;
    const controller = new AbortController();
    const promise = this.drive(executionId, binding, controller.signal).finally(() =>
      this.inFlight.delete(executionId),
    );
    this.inFlight.set(executionId, { controller, promise });
    return promise;
  }

  async status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current || current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted') {
      return current;
    }
    const active = this.inFlight.get(executionId);
    if (active) return current;
    const { endpointUrl, accessToken } = connection(binding);
    try {
      const remote = await this.getState(endpointUrl, accessToken, executionId);
      return this.acceptState(executionId, remote);
    } catch (error) {
      if (this.httpStatus(error) === 404 && current.status === 'running') {
        return this.transition(executionId, 'interrupted', {
          error: 'The Remote Executor confirmed this execution is no longer in its durable ledger.',
          detail: { confirmedMissing: true },
        });
      }
      throw error;
    }
  }

  async interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current || ['completed', 'failed', 'interrupted'].includes(current.status)) return current;
    const active = this.inFlight.get(executionId);
    if (active) active.controller.abort();
    const { endpointUrl, accessToken } = connection(binding);
    let remote: RemoteExecutionState;
    try {
      remote = await requestJson<RemoteExecutionState>(
        endpointUrl,
        accessToken,
        `/api/executions/${encodeURIComponent(executionId)}/interrupt`,
        { method: 'POST', body: '{}' },
      );
    } catch (error) {
      if (this.httpStatus(error) !== 404) throw error;
      const interrupted = this.transition(executionId, 'interrupted', {
        error: 'The Remote Executor confirmed this execution is no longer in its durable ledger.',
        detail: { confirmedMissing: true, userInterrupted: true },
      });
      if (active) await active.promise.catch(() => undefined);
      return interrupted;
    }
    const settled = this.acceptState(executionId, remote);
    if (active) await active.promise.catch(() => undefined);
    return this.store.getExecution(executionId) ?? settled;
  }

  async shutdown(): Promise<void> {
    const active = [...this.inFlight.values()];
    for (const execution of active) execution.controller.abort();
    await Promise.allSettled(active.map((execution) => execution.promise));
  }

  private async drive(executionId: string, binding: ExecutorBinding, signal: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    const { endpointUrl, accessToken } = connection(binding);
    let remote: RemoteExecutionState;
    if (current.status === 'pending') {
      remote = await this.retryTransientRequest(signal, () =>
        requestJson<RemoteExecutionState>(
          endpointUrl,
          accessToken,
          `/api/executions/${encodeURIComponent(executionId)}`,
          {
            method: 'POST',
            body: JSON.stringify({
              toolName: current.toolName,
              arguments: current.arguments ?? {},
              workspacePath: binding.workspacePath,
            }),
          },
          signal,
        ),
      );
    } else {
      try {
        remote = await this.retryTransientRequest(signal, () =>
          this.getState(endpointUrl, accessToken, executionId, signal),
        );
      } catch (error) {
        if (this.httpStatus(error) === 404) {
          return this.transition(executionId, 'interrupted', {
            error: 'The Remote Executor confirmed this execution is no longer in its durable ledger.',
            detail: { confirmedMissing: true },
          });
        }
        throw error;
      }
    }

    let settled = this.acceptState(executionId, remote);
    while (settled.status === 'running' && !signal.aborted) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      if (signal.aborted) break;
      remote = await this.retryTransientRequest(signal, () =>
        this.getState(endpointUrl, accessToken, executionId, signal),
      );
      settled = this.acceptState(executionId, remote);
    }
    return this.store.getExecution(executionId) ?? settled;
  }

  private getState(
    endpointUrl: string,
    accessToken: string,
    executionId: string,
    signal?: AbortSignal,
  ): Promise<RemoteExecutionState> {
    return requestJson(endpointUrl, accessToken, `/api/executions/${encodeURIComponent(executionId)}`, {}, signal);
  }

  private acceptState(executionId: string, remote: RemoteExecutionState): Execution {
    if (
      !remote ||
      remote.id !== executionId ||
      !['pending', 'running', 'completed', 'failed', 'interrupted'].includes(remote.status)
    ) {
      throw new Error('Remote Executor returned an invalid execution status.');
    }
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} not found`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    if (remote.status === 'pending' || remote.status === current.status) return current;
    return this.transition(executionId, remote.status, {
      ...(Object.hasOwn(remote, 'result') ? { result: remote.result } : {}),
      ...(remote.error ? { error: remote.error } : {}),
      detail: { remoteExecutor: true },
    });
  }

  private transition(
    executionId: string,
    status: Execution['status'],
    data: { result?: unknown; error?: string; detail?: Record<string, unknown> },
  ): Execution {
    const current = this.store.getExecution(executionId);
    if (!current || current.status === status) return current!;
    const updated = this.store.transitionExecution(executionId, status, data);
    this.onExecution(updated);
    return updated;
  }

  private async retryTransientRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await request();
      } catch (error) {
        if (signal.aborted || !this.isRetryableRequestFailure(error)) throw error;
        const delay = Math.min(500 * 2 ** Math.min(attempt, 4), 8_000);
        attempt += 1;
        await waitForRetry(delay, signal);
      }
    }
  }

  private isRetryableRequestFailure(error: unknown): boolean {
    const status = this.httpStatus(error);
    if (status !== null) return status === 408 || status === 425 || status === 429 || status >= 500;
    return error instanceof Error && error.message.startsWith('Remote Executor request failed:');
  }

  private httpStatus(error: unknown): number | null {
    return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
  }
}
