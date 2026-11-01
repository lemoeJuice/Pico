import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { currentExecutorBundle, currentExecutorVersion } from './bundle.js';
import type { ExecutionListener, ExecutorAdapter } from './executor.js';
import { executorPluginDirectory } from './plugin-host.js';
import {
  inspectRemoteExecutor,
  RemoteHostExecutor,
  type RemoteExecutorLeaseIdentity,
  type RemoteExecutorRecovery,
} from './remote-executor.js';
import { EXECUTOR_PROTOCOL_VERSION } from './remote-protocol.js';

const HOST_EXECUTOR_SETTING = 'executor-host-connection';

interface SavedHostConnection {
  port: number;
  accessToken: string;
}

export type HostExecutorLeaseIdentity = RemoteExecutorLeaseIdentity;

interface HostExecutorLease {
  binding: ExecutorBinding;
  identity: HostExecutorLeaseIdentity;
}

const leaseHeartbeatIntervalMs = 20_000;

function dataDirectory(): string {
  const databasePath = process.env.PICO_DB_PATH?.trim();
  return databasePath && databasePath !== ':memory:' ? dirname(resolve(databasePath)) : resolve(process.cwd(), 'data');
}

const hostExecutorLogLimitBytes = 2 * 1024 * 1024;

async function openHostExecutorLog(directory: string): Promise<FileHandle | null> {
  const logPath = join(directory, 'executor-host.log');
  const rotatedPath = `${logPath}.1`;
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  if (size >= hostExecutorLogLimitBytes) {
    try {
      await rm(rotatedPath, { force: true });
      await rename(logPath, rotatedPath);
      await chmod(rotatedPath, 0o600);
    } catch {
      return null;
    }
  }
  let log: FileHandle | null = null;
  try {
    log = await open(logPath, 'a', 0o600);
    await log.chmod(0o600);
    await log.writeFile(`\n[${new Date().toISOString()}] Host Executor starting\n`);
    return log;
  } catch {
    await log?.close().catch(() => undefined);
    return null;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Executor port.');
  const { port } = address;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

export class HostExecutor implements ExecutorAdapter {
  readonly kind = 'host' as const;
  private readonly client: RemoteHostExecutor;
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private connectionPromise: Promise<SavedHostConnection> | null = null;
  private readonly agentPath = join(dataDirectory(), 'executor-host.mjs');
  private readonly leases = new Map<string, HostExecutorLease>();
  private readonly activeExecutions = new Map<string, ExecutorBinding>();
  private leaseTimer: NodeJS.Timeout | null = null;
  private leaseTransition: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly store: PicoStore,
    onExecution: ExecutionListener = () => undefined,
    private readonly pluginDirectory = executorPluginDirectory(),
    recoverEndpoint?: RemoteExecutorRecovery,
  ) {
    this.client = new RemoteHostExecutor(
      store,
      onExecution,
      async (binding) => {
        try {
          await this.ensureRunning();
        } catch (error) {
          if (this.isTransportFailure(error)) throw this.markTransient(error);
          throw error;
        }
        const saved = await this.connection();
        return {
          endpointUrl: `http://127.0.0.1:${saved.port}`,
          accessToken: saved.accessToken,
          workspacePath: binding.workspacePath,
        };
      },
      async (endpointUrl, signal) => {
        await this.recoverLocalAgent(signal);
        await recoverEndpoint?.(endpointUrl, signal);
      },
      () => 'local://host',
    );
  }

  listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    return this.client.listTools(binding);
  }

  async checkConnection(binding: ExecutorBinding) {
    return this.client.checkConnection(binding);
  }

  async update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }> {
    const markerPath = `${this.agentPath}.idle-enabled`;
    let created = false;
    await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(markerPath, '', { mode: 0o600, flag: 'wx' });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const marker = await lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Host Executor idle marker is not a regular file.');
    }
    try {
      return await this.client.update(binding, bundle, version);
    } catch (error) {
      // The update may have been applied even when its response could not be
      // confirmed. Keep the opt-in marker in that case so the new agent sees it
      // when the old agent restarts from its inherited environment.
      const outcomeUnknown =
        error instanceof Error && error.message.startsWith('Remote Executor update outcome is unknown;');
      if (created && !outcomeUnknown) await rm(markerPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  readWorkspaceFile(binding: ExecutorBinding, path: string, signal?: AbortSignal): Promise<Response> {
    return this.client.readWorkspaceFile(binding, path, signal);
  }

  execute(executionId: string, binding: ExecutorBinding, signal?: AbortSignal): Promise<Execution> {
    const promise = this.client.execute(executionId, binding, signal);
    this.activeExecutions.set(executionId, binding);
    return promise.finally(() => {
      if (this.activeExecutions.get(executionId) === binding) this.activeExecutions.delete(executionId);
    });
  }

  status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    return this.client.status(executionId, binding);
  }

  interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    return this.client.interrupt(executionId, binding);
  }

  heartbeat(binding: ExecutorBinding, identity: HostExecutorLeaseIdentity): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new Error('Host Executor is shutting down.'));
    return this.queueLeaseTransition(async () => {
      if (this.shuttingDown) throw new Error('Host Executor is shutting down.');
      try {
        await this.client.heartbeat(binding, identity);
      } catch (error) {
        if (this.httpStatus(error) === 404) {
          throw new Error(
            'This Host Executor does not support lease heartbeats. Update or restart it before relying on automatic idle shutdown.',
            { cause: error },
          );
        }
        throw error;
      }
      const key = this.leaseKey(identity);
      this.leases.set(key, { binding, identity: { ...identity } });
      this.scheduleLeaseHeartbeats();
    });
  }

  release(_binding: ExecutorBinding, identity: HostExecutorLeaseIdentity): Promise<void> {
    return this.queueLeaseTransition(async () => {
      const key = this.leaseKey(identity);
      const lease = this.leases.get(key);
      if (!lease) return;
      this.leases.delete(key);
      this.scheduleLeaseHeartbeats();
      await this.client.release(lease.binding, lease.identity);
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    this.shutdownPromise = (async () => {
      const activeExecutions = [...this.activeExecutions.entries()];
      await Promise.allSettled(
        activeExecutions.map(([executionId, binding]) => this.client.interrupt(executionId, binding)),
      );
      await this.client.shutdown();
      await this.queueLeaseTransition(async () => {
        const leases = [...this.leases.values()];
        this.leases.clear();
        for (const lease of leases) {
          try {
            await this.client.release(lease.binding, lease.identity);
          } catch (error) {
            console.error(
              `Could not release Host Executor lease ${lease.identity.source}/${lease.identity.leaseId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });
    })();
    return this.shutdownPromise;
  }

  private leaseKey(identity: HostExecutorLeaseIdentity): string {
    return JSON.stringify([identity.runtimeId, identity.source, identity.leaseId]);
  }

  private httpStatus(error: unknown): number | null {
    return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null;
  }

  private queueLeaseTransition(transition: () => Promise<void>): Promise<void> {
    const next = this.leaseTransition.catch(() => undefined).then(transition);
    this.leaseTransition = next;
    return next;
  }

  private scheduleLeaseHeartbeats(): void {
    if (this.leases.size === 0) {
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      this.leaseTimer = null;
      return;
    }
    if (this.leaseTimer || this.shuttingDown) return;
    this.leaseTimer = setInterval(() => {
      void this.queueLeaseTransition(async () => {
        if (this.shuttingDown) return;
        await Promise.all(
          [...this.leases.values()].map(async (lease) => {
            try {
              await this.client.heartbeat(lease.binding, lease.identity);
            } catch (error) {
              console.error(
                `Host Executor lease renewal failed for ${lease.identity.source}/${lease.identity.leaseId}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }),
        );
      });
    }, leaseHeartbeatIntervalMs);
    this.leaseTimer.unref();
  }

  private connection(): Promise<SavedHostConnection> {
    this.connectionPromise ??= (async () => {
      const current = this.store.getSetting<SavedHostConnection | null>(HOST_EXECUTOR_SETTING, null);
      if (
        current &&
        Number.isInteger(current.port) &&
        current.port > 0 &&
        current.port <= 65_535 &&
        typeof current.accessToken === 'string' &&
        Buffer.byteLength(current.accessToken) >= 32
      ) {
        return current;
      }
      const created = { port: await freePort(), accessToken: randomBytes(32).toString('hex') };
      this.store.setSetting(HOST_EXECUTOR_SETTING, created);
      return created;
    })();
    return this.connectionPromise;
  }

  private async ensureRunning(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startIfUnavailable().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startIfUnavailable(): Promise<void> {
    const saved = await this.connection();
    const endpointUrl = `http://127.0.0.1:${saved.port}`;
    try {
      await this.inspectAgent(endpointUrl, saved.accessToken);
      return;
    } catch (error) {
      if (!this.isTransportFailure(error)) throw error;
    }

    const existingChild = this.process;
    if (existingChild && this.isChildAlive(existingChild)) {
      await this.waitForExistingAgent(endpointUrl, saved.accessToken, existingChild);
      return;
    }
    if (existingChild && !this.isChildAlive(existingChild)) this.process = null;
    if (!(await this.agentPortIsAvailable(saved.port))) {
      await this.waitForExistingAgent(endpointUrl, saved.accessToken);
      return;
    }

    const directory = dataDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const versionPath = `${this.agentPath}.version`;
    let installedVersion: string;
    if (!existsSync(this.agentPath)) {
      installedVersion = currentExecutorVersion();
      await writeFile(this.agentPath, await currentExecutorBundle(), { mode: 0o700 });
      await writeFile(versionPath, installedVersion, { mode: 0o600 });
    } else {
      installedVersion = (await readFile(versionPath, 'utf8').catch(() => 'unknown')).trim() || 'unknown';
      await writeFile(versionPath, installedVersion, { mode: 0o600 });
    }
    const logFile = await openHostExecutorLog(directory);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.agentPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PICO_EXECUTOR_HOST: '127.0.0.1',
          PICO_EXECUTOR_PORT: String(saved.port),
          PICO_EXECUTOR_TOKEN: saved.accessToken,
          PICO_EXECUTOR_WORKSPACE_ROOT: '/',
          PICO_EXECUTOR_FILESYSTEM_MODE: 'host',
          PICO_EXECUTOR_DB_PATH: join(directory, 'executor-host.sqlite'),
          PICO_EXECUTOR_PLUGIN_DIR: this.pluginDirectory,
          PICO_EXECUTOR_INSTALL_PATH: this.agentPath,
          PICO_EXECUTOR_VERSION_FILE: versionPath,
          PICO_EXECUTOR_VERSION: installedVersion,
          PICO_EXECUTOR_IDLE_TIMEOUT_MS: '60000',
        },
        stdio: logFile ? ['ignore', logFile.fd, logFile.fd] : 'ignore',
      });
    } finally {
      await logFile?.close().catch(() => undefined);
    }
    this.process = child;
    child.once('exit', () => {
      if (this.process === child) this.process = null;
    });
    await this.waitUntilReachable(endpointUrl, saved.accessToken, child);
  }

  private async inspectAgent(endpointUrl: string, accessToken: string): Promise<void> {
    const probeTimeout = AbortSignal.timeout(500);
    let info: Awaited<ReturnType<typeof inspectRemoteExecutor>>;
    try {
      info = await inspectRemoteExecutor(endpointUrl, accessToken, probeTimeout);
    } catch (error) {
      if (probeTimeout.aborted) {
        throw this.markTransient(new Error('Host Executor health probe timed out.', { cause: error }));
      }
      throw error;
    }
    if (info.kind !== 'executor') throw new Error('The local Host endpoint is not a Pico Executor.');
    if (info.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) {
      throw new Error(
        `Host Executor protocol version ${info.protocolVersion} is incompatible; update the local Host Executor.`,
      );
    }
    if (info.draining) throw this.markTransient(new Error('Host Executor is completing idle shutdown.'));
  }

  private isTransportFailure(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === 'object' &&
      'transientConnectionFailure' in error &&
      error.transientConnectionFailure === true,
    );
  }

  private markTransient(error: unknown): Error {
    const marked = error instanceof Error ? error : new Error(String(error));
    Object.assign(marked, { transientConnectionFailure: true });
    return marked;
  }

  private isChildAlive(child: ChildProcess): boolean {
    return Boolean(child.pid && child.exitCode === null && child.signalCode === null);
  }

  private async agentPortIsAvailable(port: number): Promise<boolean> {
    const server = createServer();
    return await new Promise<boolean>((resolvePromise, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolvePromise(false);
        else reject(error);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close((error) => {
          if (error) reject(error);
          else resolvePromise(true);
        });
      });
    });
  }

  private async recoverLocalAgent(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('Remote Executor recovery interrupted locally.', 'AbortError');
    const saved = await this.connection();
    const endpointUrl = `http://127.0.0.1:${saved.port}`;
    try {
      await this.inspectAgent(endpointUrl, saved.accessToken);
      return;
    } catch (error) {
      if (!this.isTransportFailure(error)) throw error;
    }

    const child = this.process;
    if (child && this.isChildAlive(child)) {
      try {
        await this.waitForExistingAgent(endpointUrl, saved.accessToken, child, signal);
      } catch (error) {
        if (!this.isTransportFailure(error) || this.isChildAlive(child)) throw error;
        await this.ensureRunning();
      }
      return;
    }
    if (!(await this.agentPortIsAvailable(saved.port))) {
      await this.waitForExistingAgent(endpointUrl, saved.accessToken, undefined, signal);
      return;
    }
    await this.ensureRunning();
  }

  private async waitForExistingAgent(
    endpointUrl: string,
    accessToken: string,
    child?: ChildProcess,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.waitUntilReachable(endpointUrl, accessToken, child, signal);
    } catch (error) {
      if (!this.isTransportFailure(error)) throw error;
      throw this.markTransient(new Error(
        'The Host Executor port is already occupied by an unresponsive agent. Pico will not start a duplicate Host process.',
        { cause: error },
      ));
    }
  }

  private async waitUntilReachable(
    endpointUrl: string,
    accessToken: string,
    child?: ChildProcess,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException('Remote Executor recovery interrupted locally.', 'AbortError');
      if (child && !this.isChildAlive(child)) {
        throw this.markTransient(
          new Error(
            `Host Executor process exited before it became ready (code ${child.exitCode ?? 'signal'}). See ${join(dataDirectory(), 'executor-host.log')} for startup output.`,
          ),
        );
      }
      try {
        await this.inspectAgent(endpointUrl, accessToken);
        return;
      } catch (error) {
        if (!this.isTransportFailure(error)) throw error;
        lastError = error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    throw this.markTransient(
      new Error(
        `Host Executor did not become ready within 15 seconds. See ${join(dataDirectory(), 'executor-host.log')} for startup output.`,
        { cause: lastError },
      ),
    );
  }
}
