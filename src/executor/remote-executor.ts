import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import type {
  ExecutionListener,
  ExecutorAdapter,
  ExecutorServiceAddress,
  ExecutorServiceAddressResolver,
} from './executor.js';
import {
  EXECUTOR_PROTOCOL_VERSION,
  remoteExecutorUrl,
  type RemoteExecutionState,
  type RemoteExecutorInfo,
} from './remote-protocol.js';
import { validateToolDefinitions } from './plugin-host.js';
import { isServiceError, ServiceError } from '../contracts/service-error.js';
const requestTimeoutMs = 15_000;

function remoteConnection(binding: ExecutorBinding): ExecutorServiceAddress {
  const endpointUrl = binding.remoteEndpointUrl?.trim();
  const accessToken = binding.remoteAccessToken;
  if (!endpointUrl || !accessToken) throw new Error('Remote Executor connection details are missing.');
  return { endpointUrl, accessToken, workspacePath: binding.workspacePath };
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

export async function inspectRemoteExecutor(
  endpointUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RemoteExecutorInfo> {
  if (Buffer.byteLength(accessToken) < 32) throw new Error('Remote Executor token must contain at least 32 bytes.');
  const info = await requestJson<RemoteExecutorInfo>(endpointUrl, accessToken, '/api/info', {}, signal);
  if (
    !info ||
    !Number.isSafeInteger(info.protocolVersion) ||
    info.protocolVersion < 1 ||
    typeof info.kind !== 'string' ||
    typeof info.name !== 'string' ||
    typeof info.workspaceRoot !== 'string' ||
    !Array.isArray(info.tools)
  ) {
    throw new Error('The endpoint did not identify itself as a Pico Executor.');
  }
  if (info.executorVersion !== undefined && typeof info.executorVersion !== 'string') {
    throw new Error('Remote Executor returned an invalid version.');
  }
  if (info.updateSupported !== undefined && typeof info.updateSupported !== 'boolean') {
    throw new Error('Remote Executor returned an invalid update capability.');
  }
  if (info.workspaceFileDownload !== undefined && typeof info.workspaceFileDownload !== 'boolean') {
    throw new Error('Remote Executor returned an invalid file download capability.');
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
  address?: ExecutorServiceAddress;
}

export class RemoteHostExecutor implements ExecutorAdapter {
  readonly kind = 'host' as const;
  private readonly inFlight = new Map<string, ActiveExecution>();

  constructor(
    private readonly store: PicoStore,
    private readonly onExecution: ExecutionListener = () => undefined,
    private readonly resolveAddress: ExecutorServiceAddressResolver = async (binding) => remoteConnection(binding),
  ) {}

  async listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    const { endpointUrl, accessToken } = await this.resolveAddress(binding);
    const info = await inspectRemoteExecutor(endpointUrl, accessToken);
    if (info.protocolVersion !== EXECUTOR_PROTOCOL_VERSION || info.kind !== 'executor') {
      throw new Error(`Executor protocol version ${info.protocolVersion} is incompatible; update this Executor.`);
    }
    return info.tools;
  }

  async checkConnection(binding: ExecutorBinding): Promise<RemoteExecutorInfo> {
    const { endpointUrl, accessToken } = await this.resolveAddress(binding);
    return inspectRemoteExecutor(endpointUrl, accessToken);
  }

  async update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }> {
    const { endpointUrl, accessToken } = await this.resolveAddress(binding);
    const updateBundle = new ArrayBuffer(bundle.byteLength);
    new Uint8Array(updateBundle).set(bundle);
    const result = await requestJson<{ updated?: unknown; executorVersion?: unknown }>(
      endpointUrl,
      accessToken,
      '/api/update',
      {
        method: 'POST',
        body: updateBundle,
        headers: {
          'content-type': 'application/octet-stream',
          'x-pico-executor-version': version,
        },
      },
    );
    if (result.updated !== true || typeof result.executorVersion !== 'string') {
      throw new Error('Remote Executor returned an invalid update result.');
    }
    return { executorVersion: result.executorVersion };
  }

  async readWorkspaceFile(binding: ExecutorBinding, path: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.requestWorkspaceFile(binding, path, signal);
    } catch (error) {
      if (isServiceError(error) || signal?.aborted) throw error;
      throw new ServiceError(502, 'Executor could not provide the workspace file.');
    }
  }

  private async requestWorkspaceFile(binding: ExecutorBinding, path: string, signal?: AbortSignal): Promise<Response> {
    const { endpointUrl, accessToken, workspacePath } = await this.resolveAddress(binding, signal);
    const info = await inspectRemoteExecutor(endpointUrl, accessToken, signal);
    if (info.protocolVersion !== EXECUTOR_PROTOCOL_VERSION || info.kind !== 'executor' || !info.workspaceFileDownload) {
      throw new ServiceError(409, 'This Executor does not support file downloads. Update the Executor and try again.');
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(remoteExecutorUrl(endpointUrl, '/api/workspaces/download'), {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: workspacePath ?? binding.workspacePath, path }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400) throw new ServiceError(400, 'Expected a path inside the Thread workspace.');
      if (response.status === 404) throw new ServiceError(404, 'Workspace file not found.');
      throw new ServiceError(502, 'Executor could not provide the workspace file.');
    }
    if (!response.body) throw new ServiceError(502, 'Executor returned no file content.');
    return response;
  }

  async execute(executionId: string, binding: ExecutorBinding, externalSignal?: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const active = this.inFlight.get(executionId);
    if (active) return active.promise;
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', relayAbort, { once: true });
    const activeExecution: ActiveExecution = { controller, promise: Promise.resolve(current) };
    const promise = this.drive(executionId, binding, controller.signal, activeExecution)
      .catch((error: unknown) => {
        const latest = this.store.getExecution(executionId);
        if (controller.signal.aborted && !activeExecution.address && latest?.status === 'pending') {
          return this.transition(executionId, 'interrupted', {
            error: 'Execution interrupted before it was submitted to the Remote Executor.',
            detail: { userInterrupted: true },
          });
        }
        throw error;
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(executionId);
      });
    activeExecution.promise = promise;
    this.inFlight.set(executionId, activeExecution);
    return promise;
  }

  async status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current || current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted') {
      return current;
    }
    const active = this.inFlight.get(executionId);
    if (active) return current;
    const { endpointUrl, accessToken } = await this.resolveAddress(binding);
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
    if (active) {
      active.controller.abort();
      if (!active.address && current.status === 'pending') {
        // No Remote Executor request can have been sent before address resolution.
        // Let the adapter cancel its preparation and settle this pending execution locally.
        await active.promise.catch(() => undefined);
        const latest = this.store.getExecution(executionId);
        if (latest?.status === 'pending') {
          return this.transition(executionId, 'interrupted', {
            error: 'Execution interrupted before it was submitted to the Remote Executor.',
            detail: { userInterrupted: true },
          });
        }
        return latest;
      }
    }
    const { endpointUrl, accessToken } = active?.address ?? (await this.resolveAddress(binding));
    if (active?.address && current.status === 'pending') {
      // The original POST may have reached the Executor even though aborting its
      // response fetch made the local attempt look unsubmitted. Re-submit the
      // same durable ID as a barrier before Interrupt so request reordering cannot
      // leave a tool running after the local execution becomes terminal.
      const submitted = await requestJson<RemoteExecutionState>(
        endpointUrl,
        accessToken,
        `/api/executions/${encodeURIComponent(executionId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            toolName: current.toolName,
            arguments: current.arguments ?? {},
            workspacePath: active.address.workspacePath ?? binding.workspacePath,
          }),
        },
      );
      this.acceptState(executionId, submitted);
    }
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

  hasInFlightExecutionAt(endpointUrl: string): boolean {
    return [...this.inFlight.values()].some((execution) => execution.address?.endpointUrl === endpointUrl);
  }

  private async drive(
    executionId: string,
    binding: ExecutorBinding,
    signal: AbortSignal,
    activeExecution: ActiveExecution,
  ): Promise<Execution> {
    if (signal.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    const address = await this.resolveAddress(binding, signal);
    if (signal.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
    activeExecution.address = address;
    const { endpointUrl, accessToken } = address;
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
              workspacePath: address.workspacePath ?? binding.workspacePath,
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
