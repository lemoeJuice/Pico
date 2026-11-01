import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { createHash } from 'node:crypto';
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
const recoveryTimeoutMs = 20_000;
const unknownSubmissionPrefix = 'Remote Executor submission outcome is unknown:';

/** Recover a local Host or Container transport before the shared client probes it again. */
export type RemoteExecutorRecovery = (
  endpointUrl: string,
  signal: AbortSignal,
  binding?: ExecutorBinding,
) => Promise<void>;
export type RemoteExecutorRecoveryKeyResolver = (binding: ExecutorBinding) => string | Promise<string>;

export interface RemoteExecutorLeaseIdentity {
  runtimeId: string;
  source: 'runtime' | 'thread' | 'plugin' | 'viewer';
  leaseId: string;
}

interface ActiveLease {
  token: string;
  address: ExecutorServiceAddress;
}

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
  const url = remoteExecutorUrl(endpointUrl, path);
  let response: Response;
  try {
    response = await fetch(url, {
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
    const requestError = new Error(
      `Remote Executor request failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
    Object.assign(requestError, { transientConnectionFailure: true });
    throw requestError;
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

function waitForSharedRecovery(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException('Remote Executor request interrupted locally.', 'AbortError'));
  return new Promise((resolvePromise, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Remote Executor request interrupted locally.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
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
  if (info.workspaceOptional !== undefined && typeof info.workspaceOptional !== 'boolean') {
    throw new Error('Remote Executor returned an invalid optional workspace capability.');
  }
  if (info.leaseHeartbeat !== undefined && typeof info.leaseHeartbeat !== 'boolean') {
    throw new Error('Remote Executor returned an invalid lease heartbeat capability.');
  }
  if (info.draining !== undefined && typeof info.draining !== 'boolean') {
    throw new Error('Remote Executor returned an invalid draining state.');
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
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly recoveryLatches = new Set<string>();
  private readonly leases = new Map<string, ActiveLease>();
  private readonly releasingLeases = new Map<string, number>();
  private readonly leaseQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PicoStore,
    private readonly onExecution: ExecutionListener = () => undefined,
    private readonly resolveAddress: ExecutorServiceAddressResolver = async (binding) => remoteConnection(binding),
    private readonly recoverEndpoint?: RemoteExecutorRecovery,
    private readonly resolveRecoveryKey?: RemoteExecutorRecoveryKeyResolver,
  ) {}

  async listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    const { endpointUrl, accessToken } = await this.resolveAddressWithRecovery(binding);
    const info = await this.inspectWithRecovery(endpointUrl, accessToken, binding);
    if (info.protocolVersion !== EXECUTOR_PROTOCOL_VERSION || info.kind !== 'executor') {
      throw new Error(`Executor protocol version ${info.protocolVersion} is incompatible; update this Executor.`);
    }
    if (!binding.workspacePath && info.workspaceOptional !== true) {
      throw new Error('This Executor does not support Threads without a workspace; update the Executor.');
    }
    return info.tools;
  }

  async checkConnection(binding: ExecutorBinding): Promise<RemoteExecutorInfo> {
    const { endpointUrl, accessToken } = await this.resolveAddressWithRecovery(binding);
    return this.inspectWithRecovery(endpointUrl, accessToken, binding);
  }

  async heartbeat(binding: ExecutorBinding, identity: RemoteExecutorLeaseIdentity): Promise<string> {
    this.validateLeaseIdentity(identity);
    const key = this.leaseKey(binding, identity);
    if (this.isLeaseReleasing(key)) throw new Error('Remote Executor lease is being released and cannot be renewed.');
    return this.serializeLease(key, async () => {
      if (this.isLeaseReleasing(key)) throw new Error('Remote Executor lease is being released and cannot be renewed.');
      const address = await this.resolveAddressWithRecovery(binding);
      if (this.isLeaseReleasing(key)) throw new Error('Remote Executor lease is being released and cannot be renewed.');
      const result = await this.requestWithRecovery(address.endpointUrl, address.accessToken, undefined, binding, () =>
        requestJson<{ ok?: unknown; expiresAt?: unknown; leaseToken?: unknown }>(
          address.endpointUrl,
          address.accessToken,
          '/api/leases/heartbeat',
          { method: 'POST', body: JSON.stringify(identity) },
        ),
      );
      if (result.ok !== true || typeof result.leaseToken !== 'string' || !result.leaseToken) {
        throw new Error('Remote Executor returned an invalid lease heartbeat response.');
      }
      this.leases.set(key, { token: result.leaseToken, address });
      return result.leaseToken;
    });
  }

  async release(binding: ExecutorBinding, identity: RemoteExecutorLeaseIdentity): Promise<void> {
    this.validateLeaseIdentity(identity);
    const key = this.leaseKey(binding, identity);
    this.releasingLeases.set(key, (this.releasingLeases.get(key) ?? 0) + 1);
    const operation = this.serializeLease(key, async () => {
      const active = this.leases.get(key);
      // Do not resolve an address here: a local resolver may start a stopped agent.
      if (!active) return;
      const result = await requestJson<{ ok?: unknown }>(
        active.address.endpointUrl,
        active.address.accessToken,
        '/api/leases/release',
        { method: 'POST', body: JSON.stringify({ ...identity, leaseToken: active.token }) },
      );
      if (result.ok !== true) throw new Error('Remote Executor returned an invalid lease release response.');
      this.leases.delete(key);
    });
    return operation.finally(() => {
      const remaining = (this.releasingLeases.get(key) ?? 1) - 1;
      if (remaining <= 0) this.releasingLeases.delete(key);
      else this.releasingLeases.set(key, remaining);
    });
  }

  private validateLeaseIdentity(identity: RemoteExecutorLeaseIdentity): void {
    if (
      !identity ||
      typeof identity.runtimeId !== 'string' ||
      !identity.runtimeId.trim() ||
      identity.runtimeId.length > 200 ||
      typeof identity.leaseId !== 'string' ||
      !identity.leaseId.trim() ||
      identity.leaseId.length > 200 ||
      !['runtime', 'thread', 'plugin', 'viewer'].includes(identity.source)
    )
      throw new Error('Remote Executor lease identity is invalid.');
  }

  private leaseKey(binding: ExecutorBinding, identity: RemoteExecutorLeaseIdentity): string {
    return JSON.stringify([binding.kind, binding.id, identity.runtimeId, identity.source, identity.leaseId]);
  }

  private isLeaseReleasing(key: string): boolean {
    return (this.releasingLeases.get(key) ?? 0) > 0;
  }

  private serializeLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.leaseQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.leaseQueues.set(key, tail);
    void tail.then(() => {
      if (this.leaseQueues.get(key) === tail) this.leaseQueues.delete(key);
    });
    return current;
  }

  async update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }> {
    const { endpointUrl, accessToken } = await this.resolveAddressWithRecovery(binding);
    const updateBundle = new ArrayBuffer(bundle.byteLength);
    new Uint8Array(updateBundle).set(bundle);
    let result: { updated?: unknown; executorVersion?: unknown };
    try {
      result = await requestJson<{ updated?: unknown; executorVersion?: unknown }>(
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
    } catch (error) {
      if (!this.isRetryableRequestFailure(error)) throw error;
      let info: RemoteExecutorInfo;
      try {
        await this.recoverOnce(endpointUrl, accessToken, undefined, binding);
        info = await this.requestWithRecovery(endpointUrl, accessToken, undefined, binding, () =>
          inspectRemoteExecutor(endpointUrl, accessToken),
        );
      } catch (verificationError) {
        throw new Error('Remote Executor update outcome is unknown; the update bundle was not resubmitted.', {
          cause: verificationError,
        });
      }
      if (info.executorVersion === version) return { executorVersion: version };
      throw new Error('Remote Executor update outcome is unknown; the update bundle was not resubmitted.', {
        cause: error,
      });
    }
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
    const { endpointUrl, accessToken, workspacePath } = await this.resolveAddressWithRecovery(binding, signal);
    const info = await this.inspectWithRecovery(endpointUrl, accessToken, binding, false, signal);
    if (info.protocolVersion !== EXECUTOR_PROTOCOL_VERSION || info.kind !== 'executor' || !info.workspaceFileDownload) {
      throw new ServiceError(409, 'This Executor does not support file downloads. Update the Executor and try again.');
    }
    const response = await this.requestWithRecovery(
      endpointUrl,
      accessToken,
      signal,
      binding,
      async () => {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), requestTimeoutMs);
        try {
          return await fetch(remoteExecutorUrl(endpointUrl, '/api/workspaces/download'), {
            method: 'POST',
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ workspacePath: workspacePath ?? binding.workspacePath, path }),
          });
        } catch (error) {
          if (signal?.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
          const requestError = new Error(
            `Remote Executor workspace download failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
          Object.assign(requestError, { transientConnectionFailure: true });
          throw requestError;
        } finally {
          clearTimeout(timer);
        }
      },
      false,
    );
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
    if (current.status === 'pending' && current.error?.startsWith(unknownSubmissionPrefix)) {
      throw new Error(current.error);
    }
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
    const { endpointUrl, accessToken } = await this.resolveAddressWithRecovery(binding);
    try {
      const remote = await this.requestWithRecovery(endpointUrl, accessToken, undefined, binding, () =>
        this.getState(endpointUrl, accessToken, executionId),
      );
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
    const verifyUncertainSubmission = current.status === 'pending';
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
    const { endpointUrl, accessToken } = active?.address ?? (await this.resolveAddressWithRecovery(binding));
    if (verifyUncertainSubmission) {
      // An earlier POST may have reached the Executor even if the caller still has
      // pending state. Wait for its local request to stop, then only GET the ledger;
      // never replay a tool POST as an interrupt-ordering barrier.
      if (active) await active.promise.catch(() => undefined);
      const latest = this.store.getExecution(executionId);
      if (!latest || ['completed', 'failed', 'interrupted'].includes(latest.status)) return latest;
      let settled: Execution;
      try {
        const observed = await this.requestWithRecovery(endpointUrl, accessToken, undefined, binding, () =>
          this.getState(endpointUrl, accessToken, executionId),
        );
        settled = this.acceptState(executionId, observed);
      } catch (queryError) {
        const message = queryError instanceof Error ? queryError.message : String(queryError);
        this.recordUnknownSubmission(executionId, message);
        const latest = this.store.getExecution(executionId);
        throw new Error(latest?.error ?? `${unknownSubmissionPrefix} ${message}`);
      }
      if (['completed', 'failed', 'interrupted'].includes(settled.status)) return settled;
    }
    let remote: RemoteExecutionState;
    try {
      remote = await this.requestWithRecovery(endpointUrl, accessToken, undefined, binding, () =>
        requestJson<RemoteExecutionState>(
          endpointUrl,
          accessToken,
          `/api/executions/${encodeURIComponent(executionId)}/interrupt`,
          { method: 'POST', body: '{}' },
        ),
      );
    } catch (error) {
      if (this.httpStatus(error) === 404) {
        const latest = this.store.getExecution(executionId);
        if (latest?.status === 'pending') {
          this.recordUnknownSubmission(executionId, 'The execution ID disappeared before Interrupt was confirmed.');
          throw new Error(
            this.store.getExecution(executionId)?.error ??
              `${unknownSubmissionPrefix} the execution ID disappeared before Interrupt was confirmed.`,
          );
        }
        const interrupted = this.transition(executionId, 'interrupted', {
          error: 'The Remote Executor confirmed this execution is no longer in its durable ledger.',
          detail: { confirmedMissing: true, userInterrupted: true },
        });
        if (active) await active.promise.catch(() => undefined);
        return interrupted;
      }
      throw error;
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
    const address = await this.resolveAddressWithRecovery(binding, signal);
    if (signal.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
    activeExecution.address = address;
    const { endpointUrl, accessToken } = address;
    let remote: RemoteExecutionState;
    if (current.status === 'pending') {
      if (!(address.workspacePath ?? binding.workspacePath)) {
        const info = await inspectRemoteExecutor(endpointUrl, accessToken, signal);
        if (info.workspaceOptional !== true) {
          throw new Error('This Executor does not support Threads without a workspace; update the Executor.');
        }
      }
      try {
        remote = await requestJson<RemoteExecutionState>(
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
        );
      } catch (error) {
        if (signal.aborted) {
          this.recordUnknownSubmission(executionId, 'The submission was interrupted before its outcome was confirmed.');
          throw error;
        }
        if (!this.isRetryableRequestFailure(error)) throw error;
        // POST may have been accepted even when its response was lost. Recover the
        // transport, then inspect only this durable ID; never replay the tool call.
        try {
          await this.recoverOnce(endpointUrl, accessToken, signal, binding);
          remote = await this.queryUncertainSubmission(endpointUrl, accessToken, executionId, signal, binding);
        } catch (queryError) {
          const message = queryError instanceof Error ? queryError.message : String(queryError);
          this.recordUnknownSubmission(executionId, message);
          throw queryError;
        }
      }
    } else {
      try {
        remote = await this.requestWithRecovery(endpointUrl, accessToken, signal, binding, () =>
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
    while ((settled.status === 'pending' || settled.status === 'running') && !signal.aborted) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      if (signal.aborted) break;
      remote = await this.requestWithRecovery(endpointUrl, accessToken, signal, binding, () =>
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

  private recordUnknownSubmission(executionId: string, cause: string): void {
    const current = this.store.getExecution(executionId);
    if (!current || !['pending', 'running'].includes(current.status)) return;
    if (current.error?.startsWith(unknownSubmissionPrefix)) return;
    this.store.recordExecutionError(
      executionId,
      `${unknownSubmissionPrefix} could not verify the durable ledger; the tool was not resubmitted. ${cause}`,
    );
  }

  private async inspectWithRecovery(
    endpointUrl: string,
    accessToken: string,
    binding: ExecutorBinding,
    retryHttpStatus = true,
    signal?: AbortSignal,
  ): Promise<RemoteExecutorInfo> {
    try {
      const info = await inspectRemoteExecutor(endpointUrl, accessToken, signal);
      this.clearRecoveryLatch(endpointUrl, accessToken);
      return info;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
      if (!(retryHttpStatus ? this.isRetryableRequestFailure(error) : this.hasTransientConnectionMarker(error)))
        throw error;
      try {
        await this.recoverOnce(endpointUrl, accessToken, signal, binding);
      } catch (recoveryError) {
        if (signal?.aborted || !this.isRecoveryLatchedError(recoveryError)) throw recoveryError;
        // checkConnection/listTools are independent GET health probes. Permit one
        // probe without another restart, and clear the latch only if it succeeds.
      }
      const info = await inspectRemoteExecutor(endpointUrl, accessToken, signal);
      this.clearRecoveryLatch(endpointUrl, accessToken);
      return info;
    }
  }

  private async resolveAddressWithRecovery(
    binding: ExecutorBinding,
    signal?: AbortSignal,
  ): Promise<ExecutorServiceAddress> {
    try {
      return await this.resolveAddress(binding, signal);
    } catch (error) {
      if (signal?.aborted || !this.recoverEndpoint || !this.hasTransientConnectionMarker(error)) throw error;
      const recoveryKey = await this.resolverRecoveryKey(binding);
      await this.recoverOnce(recoveryKey, binding.remoteAccessToken ?? '', signal, binding);
      // Resolver/startup recovery is bounded to one retry; a failed retry is returned
      // directly and never starts another recovery cycle.
      const address = await this.resolveAddress(binding, signal);
      // Local resolvers usually wait for the agent to listen; verify the protocol
      // before clearing a failed-startup latch so repeated parses cannot restart it.
      await inspectRemoteExecutor(address.endpointUrl, address.accessToken, signal);
      this.clearRecoveryLatch(recoveryKey, binding.remoteAccessToken ?? '');
      return address;
    }
  }

  private async resolverRecoveryKey(binding: ExecutorBinding): Promise<string> {
    const key = this.resolveRecoveryKey
      ? await this.resolveRecoveryKey(binding)
      : binding.remoteEndpointUrl?.trim() || `local://${binding.kind}/${encodeURIComponent(binding.id)}`;
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('Remote Executor recovery identity is missing.');
    }
    return key.trim();
  }

  private async queryUncertainSubmission(
    endpointUrl: string,
    accessToken: string,
    executionId: string,
    signal: AbortSignal,
    binding: ExecutorBinding,
  ): Promise<RemoteExecutionState> {
    try {
      return await this.requestWithRecovery(endpointUrl, accessToken, signal, binding, () =>
        this.getState(endpointUrl, accessToken, executionId, signal),
      );
    } catch (error) {
      if (this.httpStatus(error) === 404) {
        throw new Error(
          `${unknownSubmissionPrefix} the execution ID was not found after recovery; the tool was not resubmitted.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** One outage gets one shared transport recovery, then exactly one bounded retry. */
  private async requestWithRecovery<T>(
    endpointUrl: string,
    accessToken: string,
    signal: AbortSignal | undefined,
    binding: ExecutorBinding,
    request: () => Promise<T>,
    retryHttpStatus = true,
  ): Promise<T> {
    try {
      const result = await request();
      this.clearRecoveryLatch(endpointUrl, accessToken);
      return result;
    } catch (error) {
      if (
        (signal?.aborted ?? false) ||
        !(retryHttpStatus ? this.isRetryableRequestFailure(error) : this.hasTransientConnectionMarker(error))
      )
        throw error;
      try {
        await this.recoverOnce(endpointUrl, accessToken, signal, binding);
      } catch (recoveryError) {
        if (signal?.aborted || !this.isRecoveryLatchedError(recoveryError)) throw recoveryError;
        // A latched outage may still be probed with one non-destructive retry,
        // but no new local restart is allowed until a health check succeeds.
        const result = await request();
        this.clearRecoveryLatch(endpointUrl, accessToken);
        return result;
      }
      if (signal?.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
      const result = await request();
      this.clearRecoveryLatch(endpointUrl, accessToken);
      return result;
    }
  }

  private async recoverOnce(
    endpointUrl: string,
    accessToken: string,
    signal?: AbortSignal,
    binding?: ExecutorBinding,
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException('Remote Executor request interrupted locally.', 'AbortError');
    // Include credentials in the single-flight identity without retaining them in
    // diagnostics. Different Executor identities at one URL must not share a hook.
    const key = `${endpointUrl}\u0000${createHash('sha256').update(accessToken).digest('hex')}`;
    const existing = this.recoveries.get(key);
    if (existing) return waitForSharedRecovery(existing, signal);
    if (this.recoveryLatches.has(key)) {
      const error = new Error(
        'Remote Executor recovery is already latched for this outage; confirm connectivity before retrying.',
      );
      Object.assign(error, { recoveryLatched: true });
      throw error;
    }
    this.recoveryLatches.add(key);

    const recovery = (async (): Promise<void> => {
      // Publish the single-flight promise before invoking an integration hook;
      // a hook may itself make Executor requests during local startup.
      await Promise.resolve();
      const timeout = AbortSignal.timeout(recoveryTimeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const recoveryWork = this.recoverEndpoint
        ? this.recoverEndpoint(endpointUrl, timeout, binding)
        : this.probeUntilAvailable(endpointUrl, accessToken, timeout);
      try {
        await Promise.race([
          recoveryWork,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Remote Executor recovery timed out.')), recoveryTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    this.recoveries.set(key, recovery);
    void recovery.then(
      () => {
        if (this.recoveries.get(key) === recovery) this.recoveries.delete(key);
      },
      () => {
        if (this.recoveries.get(key) === recovery) this.recoveries.delete(key);
      },
    );
    return waitForSharedRecovery(recovery, signal);
  }

  private async probeUntilAvailable(endpointUrl: string, accessToken: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await inspectRemoteExecutor(endpointUrl, accessToken, signal);
        return;
      } catch (error) {
        if (signal.aborted || !this.isRetryableRequestFailure(error) || attempt >= 5) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(250 * 2 ** attempt, 2_000)));
      }
    }
  }

  private clearRecoveryLatch(endpointUrl: string, accessToken: string): void {
    const key = `${endpointUrl}\u0000${createHash('sha256').update(accessToken).digest('hex')}`;
    this.recoveryLatches.delete(key);
  }

  private isRecoveryLatchedError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'recoveryLatched' in error &&
      (error as { recoveryLatched?: unknown }).recoveryLatched === true,
    );
  }

  private isRetryableRequestFailure(error: unknown): boolean {
    const status = this.httpStatus(error);
    if (status !== null) return status === 408 || status === 425 || status === 429 || status >= 500;
    return this.hasTransientConnectionMarker(error);
  }

  private hasTransientConnectionMarker(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'transientConnectionFailure' in error &&
      (error as { transientConnectionFailure?: unknown }).transientConnectionFailure === true,
    );
  }

  private httpStatus(error: unknown): number | null {
    return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
  }
}
