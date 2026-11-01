import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { hostname } from 'node:os';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { EXECUTOR_PROTOCOL_VERSION } from './remote-protocol.js';
import { compareExecutorVersions, PICO_EXECUTOR_VERSION } from './version.js';
import { createToolCatalog } from './tools.js';
import { loadExecutorPlugins } from './plugin-host.js';
import type { ToolCatalog } from './tool-catalog.js';
import { RemoteExecutionLedger } from './remote-ledger.js';
import type { RemoteExecutionRequest, RemoteExecutionState } from './remote-protocol.js';
import { serveRemoteWorkspaceFile } from './workspace-file.js';

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<RemoteExecutionState>;
}

export interface RemoteExecutorServerOptions {
  host?: string;
  port?: number;
  token: string;
  workspaceRoot: string;
  filesystemMode?: 'host' | 'scoped';
  name?: string;
  databasePath?: string;
  pluginDirectory?: string;
  tools?: ToolCatalog;
  executorVersion?: string;
  update?: (bundle: Buffer, version: string) => Promise<void>;
  /** Enables lease-based idle handling. Omit to keep Remote Executors alive. */
  idle?: {
    timeoutMs?: number;
    retryOnError?: boolean;
    onIdle: () => void | Promise<void>;
  };
}

export interface RunningRemoteExecutorServer {
  port: number;
  close(): Promise<void>;
}

function bodyObject(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new Error('Request body must be a JSON object');
  }
  return request.body as Record<string, unknown>;
}

function remoteExecutionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new Error('Execution ID must contain 1 to 500 characters.');
  }
  return value;
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ?? '';
}

function validToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

type LeaseSource = 'runtime' | 'thread' | 'plugin' | 'viewer';

export const LEGACY_CONTAINER_AGENT_PATH = '/opt/pico/executor-agent.mjs';
export const LEGACY_CONTAINER_IDLE_ENABLE_MARKER = 'pico-health-supervisor-enabled';
export const LEGACY_CONTAINER_IDLE_MARKER = 'pico-executor-idle';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Enables the Podman health-check lifecycle only for explicitly marked legacy containers. */
export async function prepareLegacyContainerIdleMarkers(
  installPath: string | undefined,
  dataDirectory = '/opt/pico/data',
): Promise<boolean> {
  if (installPath !== LEGACY_CONTAINER_AGENT_PATH) return false;
  const enablePath = join(dataDirectory, LEGACY_CONTAINER_IDLE_ENABLE_MARKER);
  let markerInfo;
  try {
    markerInfo = await lstat(enablePath);
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error('Legacy Container health-supervisor marker must be a regular file.');
  }
  await rm(join(dataDirectory, LEGACY_CONTAINER_IDLE_MARKER), { force: true });
  return true;
}

/** Atomically publishes the idle signal consumed by Podman health checks. */
export async function writeLegacyContainerIdleMarker(dataDirectory = '/opt/pico/data'): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const markerPath = join(dataDirectory, LEGACY_CONTAINER_IDLE_MARKER);
  const temporaryPath = join(dataDirectory, `.${LEGACY_CONTAINER_IDLE_MARKER}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, markerPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function leasePart(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error(`${label} must contain 1 to 200 characters.`);
  }
  return value;
}

function leaseSource(value: unknown): LeaseSource {
  if (value === 'runtime' || value === 'thread' || value === 'plugin' || value === 'viewer') return value;
  throw new Error('Lease source must be runtime, thread, plugin, or viewer.');
}

export async function startRemoteExecutorServer(
  options: RemoteExecutorServerOptions,
): Promise<RunningRemoteExecutorServer> {
  if (Buffer.byteLength(options.token) < 32) throw new Error('Remote Executor token must contain at least 32 bytes.');
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4174;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Remote Executor port is invalid.');
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  if (!(await stat(workspaceRoot)).isDirectory()) throw new Error('Executor workspace root must be a directory.');
  const databasePath = options.databasePath ?? join(process.cwd(), 'data', 'executor.sqlite');
  const executorVersion = options.executorVersion ?? PICO_EXECUTOR_VERSION;
  const ledger = new RemoteExecutionLedger(databasePath);
  const tools = options.tools ?? createToolCatalog();
  const pluginLoad = await loadExecutorPlugins(tools, {
    ...(options.pluginDirectory ? { pluginDirectory: options.pluginDirectory } : {}),
  });
  if (pluginLoad.errors.length > 0) {
    // An invalid optional plugin must not prevent the remote executor from serving its valid catalog.
    console.warn(`Remote Executor plugin load errors: ${pluginLoad.errors.join('; ')}`);
  }
  const active = new Map<string, ActiveExecution>();
  const leases = new Map<string, { expiresAt: number; leaseToken: string }>();
  let activeToolCount = 0;
  let executionAdmissionsInProgress = 0;
  let admissionsInProgress = 0;
  let updateFence = false;
  let draining = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleCallbackStarted = false;
  const idleTimeoutMs = options.idle?.timeoutMs ?? 60_000;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1)
    throw new Error('Executor idle timeout must be a positive number.');
  const scheduleIdleCheck = (): void => {
    if (!options.idle || idleCallbackStarted) return;
    if (idleTimer) clearTimeout(idleTimer);
    const now = Date.now();
    for (const [key, lease] of leases) if (lease.expiresAt <= now) leases.delete(key);
    const nextLeaseExpiry = leases.size ? Math.min(...[...leases.values()].map((lease) => lease.expiresAt)) : undefined;
    const delay = nextLeaseExpiry === undefined ? idleTimeoutMs : Math.max(1, nextLeaseExpiry - now);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const checkedAt = Date.now();
      for (const [key, lease] of leases) if (lease.expiresAt <= checkedAt) leases.delete(key);
      if (leases.size || activeToolCount || admissionsInProgress) return scheduleIdleCheck();
      // Fence new work synchronously before invoking shutdown code. Requests that
      // arrive after this point receive a retryable response from the old agent.
      draining = true;
      idleCallbackStarted = true;
      void Promise.resolve()
        .then(options.idle!.onIdle)
        .catch((error: unknown) => {
          console.error(
            `Remote Executor idle callback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (options.idle?.retryOnError) {
            draining = false;
            idleCallbackStarted = false;
            scheduleIdleCheck();
          }
        });
    }, delay);
    idleTimer.unref();
  };
  scheduleIdleCheck();
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (validToken(bearerToken(request), options.token)) return next();
    response.status(401).json({ error: 'Remote Executor bearer token required.' });
  });
  const retryWhileDraining = (response: import('express').Response): void => {
    response.setHeader('retry-after', '1');
    response
      .status(503)
      .json({ error: 'Remote Executor is draining after idle timeout.', code: 'executor_draining', retryable: true });
  };
  const rejectToolDuringUpdate = (response: import('express').Response): void => {
    response
      .status(409)
      .json({ error: 'Remote Executor is updating and cannot accept tool work.', code: 'executor_updating' });
  };
  const updateRequests = new WeakMap<Request, { commit: () => void }>();
  const admitRequest = (
    request: Request,
    response: import('express').Response,
    next: import('express').NextFunction,
    admission: { allowStatusRead?: boolean; executionAdmission?: boolean; updatePost?: boolean } = {},
  ): void => {
    // Keep status reads available during drain. The GET handler separately
    // prevents a pending record from being scheduled as new work.
    if (draining && admission.allowStatusRead && request.method === 'GET') return next();
    if (draining) return retryWhileDraining(response);
    if (admission.executionAdmission && updateFence) return rejectToolDuringUpdate(response);
    if (admission.updatePost) {
      if (updateFence) return rejectToolDuringUpdate(response);
      if (executionAdmissionsInProgress > 0 || activeToolCount > 0 || admissionsInProgress > 0) {
        response
          .status(409)
          .json({ error: 'Remote Executor has accepted or is executing tool work.', code: 'executor_busy' });
        return;
      }
      // Reserve the update before parsing its request body so no tool can enter
      // between the idle check and the self-update callback.
      updateFence = true;
    }
    if (admission.executionAdmission) executionAdmissionsInProgress += 1;
    admissionsInProgress += 1;
    let released = false;
    let updateCommitted = false;
    if (admission.updatePost) updateRequests.set(request, { commit: () => (updateCommitted = true) });
    const release = (): void => {
      if (released) return;
      released = true;
      admissionsInProgress -= 1;
      if (admission.executionAdmission) executionAdmissionsInProgress -= 1;
      if (admission.updatePost && !updateCommitted) updateFence = false;
      if (!admissionsInProgress) scheduleIdleCheck();
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
  // Count authenticated work before body parsing so an idle timer cannot close
  // the agent while a request body is still being received or decoded.
  app.use((request, response, next) => {
    const path = request.path;
    const executionPath = /^\/api\/executions\/[^/]+$/.test(path);
    const updatePost = request.method === 'POST' && path === '/api/update';
    const executionPost = request.method === 'POST' && executionPath;
    const admitted =
      (request.method === 'POST' &&
        (updatePost || path === '/api/workspaces/validate' || path === '/api/workspaces/download' || executionPost)) ||
      (request.method === 'GET' && executionPath);
    if (!admitted) return next();
    return admitRequest(request, response, next, {
      allowStatusRead: executionPath && request.method === 'GET',
      executionAdmission: executionPath,
      updatePost,
    });
  });
  app.use(express.json({ limit: '1mb' }));

  const validateWorkspace = async (requested: unknown): Promise<string> => {
    if (typeof requested !== 'string' || !isAbsolute(requested)) {
      throw new Error('Workspace path must be an absolute path on the Remote Executor.');
    }
    const path = await realpath(requested);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('Workspace path must be a directory.');
    const relativePath = relative(workspaceRoot, path);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('Workspace path must stay inside the configured Remote Executor workspace root.');
    }
    return path;
  };

  // The configured root remains the executor's default working directory in
  // the absence of a Project workspace; it is not itself a Project binding.
  const executionWorkspace = async (requested: unknown): Promise<string> => {
    if (requested === '') return '';
    return validateWorkspace(requested);
  };

  const currentState = (id: string): RemoteExecutionState | null => ledger.get(id);

  const run = (id: string, request: RemoteExecutionRequest): Promise<RemoteExecutionState> => {
    const prior = active.get(id);
    if (prior) return prior.promise;
    const state = currentState(id);
    if (!state) return Promise.reject(new Error(`Execution ${id} was not durably accepted.`));
    if (state.status !== 'pending') return Promise.resolve(state);
    const controller = new AbortController();
    const promise = (async () => {
      ledger.transition(id, 'running');
      const tool = tools.get(request.toolName);
      if (!tool || tool.source !== 'executor') {
        return ledger.transition(id, 'failed', { error: `Unknown Remote Executor tool: ${request.toolName}` });
      }
      activeToolCount += 1;
      try {
        const workspacePath = await executionWorkspace(request.workspacePath);
        const result = await tool.execute(request.arguments, {
          workspacePath,
          workingDirectory: workspacePath || (options.filesystemMode === 'host' ? process.cwd() : workspaceRoot),
          filesystemMode: options.filesystemMode ?? 'scoped',
          executionId: id,
          signal: controller.signal,
        });
        return ledger.transition(id, 'completed', { result });
      } catch (error) {
        const interrupted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
        return ledger.transition(id, interrupted ? 'interrupted' : 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        activeToolCount -= 1;
        if (!activeToolCount) scheduleIdleCheck();
      }
    })().finally(() => active.delete(id));
    active.set(id, { controller, promise });
    return promise;
  };

  const schedule = (id: string, request: RemoteExecutionRequest): void => {
    void run(id, request).catch((error: unknown) => {
      const state = ledger.get(id);
      if (!state || !['pending', 'running'].includes(state.status)) return;
      try {
        ledger.transition(id, 'failed', { error: error instanceof Error ? error.message : String(error) });
      } catch {
        // A second ledger error cannot be repaired here; the durable state remains inspectable.
      }
    });
  };

  app.get('/api/info', (_request, response) => {
    response.json({
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      executorVersion,
      updateSupported: Boolean(options.update),
      name: options.name?.trim() || hostname(),
      kind: 'executor',
      workspaceRoot,
      workspaceOptional: true,
      workspaceFileDownload: true,
      leaseHeartbeat: Boolean(options.idle),
      draining,
      tools: tools.listBySource('executor').map((tool) => tool.definition),
    });
  });
  if (options.idle) {
    app.post('/api/leases/heartbeat', (request, response) => {
      if (draining) return retryWhileDraining(response);
      const body = bodyObject(request);
      const runtimeId = leasePart(body.runtimeId, 'runtimeId');
      const source = leaseSource(body.source);
      const leaseId = leasePart(body.leaseId, 'leaseId');
      // Length-prefixed fields prevent delimiter collisions between owners.
      const key = [runtimeId, source, leaseId].map((part) => `${part.length}:${part}`).join('|');
      const expiresAt = Date.now() + idleTimeoutMs;
      const leaseToken = randomUUID();
      leases.set(key, { expiresAt, leaseToken });
      idleCallbackStarted = false;
      scheduleIdleCheck();
      response.json({ ok: true, expiresAt, leaseToken });
    });
    app.post('/api/leases/release', (request, response) => {
      const body = bodyObject(request);
      const runtimeId = leasePart(body.runtimeId, 'runtimeId');
      const source = leaseSource(body.source);
      const leaseId = leasePart(body.leaseId, 'leaseId');
      const leaseToken = leasePart(body.leaseToken, 'leaseToken');
      const key = [runtimeId, source, leaseId].map((part) => `${part.length}:${part}`).join('|');
      if (leases.get(key)?.leaseToken === leaseToken) leases.delete(key);
      scheduleIdleCheck();
      response.json({ ok: true });
    });
  }
  app.post(
    '/api/update',
    express.raw({ type: 'application/octet-stream', limit: '25mb' }),
    async (request, response) => {
      if (!options.update) {
        return response
          .status(501)
          .json({ error: 'This Executor installation has no self-update command configured.' });
      }
      if (!Buffer.isBuffer(request.body)) throw new Error('Executor update bundle is missing.');
      const version = request.header('x-pico-executor-version')?.trim();
      const targetVersionIsValid = compareExecutorVersions(version ?? '', '0.0.0') !== null;
      if (
        !version ||
        !targetVersionIsValid ||
        (executorVersion !== 'unknown' && compareExecutorVersions(version, executorVersion) !== 1)
      ) {
        throw new Error('Executor update bundle must have a valid newer version.');
      }
      updateRequests.get(request)?.commit();
      await options.update(request.body, version);
      return response.json({ updated: true, executorVersion: version });
    },
  );
  app.post('/api/workspaces/validate', async (request, response) => {
    response.json({ path: await validateWorkspace(bodyObject(request).path) });
  });
  app.post('/api/workspaces/download', async (request, response) => {
    const body = bodyObject(request);
    await serveRemoteWorkspaceFile(
      body.workspacePath,
      body.path,
      async (path) =>
        (await executionWorkspace(path)) || (options.filesystemMode === 'host' ? process.cwd() : workspaceRoot),
      response,
    );
  });
  app.post('/api/executions/:id', async (request, response) => {
    const id = remoteExecutionId(request.params.id!);
    const body = bodyObject(request);
    if (typeof body.toolName !== 'string' || !body.toolName.trim()) throw new Error('toolName is required.');
    if (!body.arguments || typeof body.arguments !== 'object' || Array.isArray(body.arguments)) {
      throw new Error('arguments must be an object.');
    }
    const identity = {
      toolName: body.toolName,
      arguments: body.arguments as Record<string, unknown>,
      workspacePath: body.workspacePath,
    };
    const priorInput = ledger.getRequest(id);
    if (priorInput) {
      const accepted = ledger.createIfAbsent(id, identity, priorInput);
      if (!accepted.inserted && accepted.state.status === 'running' && !active.has(id)) {
        const interrupted = ledger.transition(id, 'interrupted', {
          error: 'Remote Executor restarted and confirmed its previous local execution is no longer tracked.',
        });
        return response.json(interrupted);
      }
      if (accepted.state.status === 'pending') schedule(id, priorInput);
      return response.status(200).json(ledger.get(id) ?? accepted.state);
    }
    const workspacePath = await executionWorkspace(body.workspacePath);
    const input: RemoteExecutionRequest = { ...identity, workspacePath };
    const accepted = ledger.createIfAbsent(id, identity, input);
    if (!accepted.inserted && accepted.state.status === 'running' && !active.has(id)) {
      const interrupted = ledger.transition(id, 'interrupted', {
        error: 'Remote Executor restarted and confirmed its previous local execution is no longer tracked.',
      });
      return response.json(interrupted);
    }
    if (accepted.inserted || accepted.state.status === 'pending') schedule(id, input);
    return response.status(accepted.inserted ? 202 : 200).json(ledger.get(id) ?? accepted.state);
  });
  app.get('/api/executions/:id', async (request, response) => {
    if (updateFence) return rejectToolDuringUpdate(response);
    const id = remoteExecutionId(request.params.id!);
    const state = currentState(id);
    if (!state) return response.status(404).json({ error: 'Execution not found.' });
    if (state.status === 'pending') {
      if (draining) return retryWhileDraining(response);
      const input = ledger.getRequest(id);
      if (!input) return response.status(404).json({ error: 'Execution input not found.' });
      schedule(id, input);
      return response.json(ledger.get(id) ?? state);
    }
    if (state.status === 'running' && !active.has(id)) {
      return response.json(
        ledger.transition(id, 'interrupted', {
          error: 'Remote Executor restarted and confirmed its previous local execution is no longer tracked.',
        }),
      );
    }
    return response.json(state);
  });
  app.post('/api/executions/:id/interrupt', async (request, response) => {
    const id = remoteExecutionId(request.params.id!);
    const state = currentState(id);
    if (!state) return response.status(404).json({ error: 'Execution not found.' });
    const running = active.get(id);
    if (running) {
      running.controller.abort();
      return response.json(await running.promise);
    }
    if (state.status === 'pending' || state.status === 'running') {
      return response.json(
        ledger.transition(id, 'interrupted', {
          error: 'Remote Executor confirmed this execution is no longer active after an explicit Interrupt.',
        }),
      );
    }
    return response.json(state);
  });

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
  };
  app.use(errors);
  const httpServer = createServer(app);
  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolvePromise();
    });
  });
  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: boundPort,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      for (const execution of active.values()) execution.controller.abort();
      await Promise.allSettled([...active.values()].map((execution) => execution.promise));
      await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
      ledger.close();
    },
  };
}
