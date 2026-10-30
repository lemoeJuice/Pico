import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { currentExecutorBundle, currentExecutorVersion } from './bundle.js';
import type { ExecutionListener, ExecutorAdapter } from './executor.js';
import { executorPluginDirectory } from './plugin-host.js';
import { RemoteHostExecutor } from './remote-executor.js';

const HOST_EXECUTOR_SETTING = 'executor-host-connection';

interface SavedHostConnection {
  port: number;
  accessToken: string;
}

function dataDirectory(): string {
  const databasePath = process.env.PICO_DB_PATH?.trim();
  return databasePath && databasePath !== ':memory:' ? dirname(resolve(databasePath)) : resolve(process.cwd(), 'data');
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

  constructor(
    private readonly store: PicoStore,
    onExecution: ExecutionListener = () => undefined,
    private readonly pluginDirectory = executorPluginDirectory(),
  ) {
    this.client = new RemoteHostExecutor(store, onExecution, async (binding) => {
      await this.ensureRunning();
      const saved = await this.connection();
      return {
        endpointUrl: `http://127.0.0.1:${saved.port}`,
        accessToken: saved.accessToken,
        workspacePath: binding.workspacePath,
      };
    });
  }

  listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    return this.client.listTools(binding);
  }

  async checkConnection(binding: ExecutorBinding) {
    return this.client.checkConnection(binding);
  }

  async update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }> {
    return this.client.update(binding, bundle, version);
  }

  readWorkspaceFile(binding: ExecutorBinding, path: string, signal?: AbortSignal): Promise<Response> {
    return this.client.readWorkspaceFile(binding, path, signal);
  }

  execute(executionId: string, binding: ExecutorBinding, signal?: AbortSignal): Promise<Execution> {
    return this.client.execute(executionId, binding, signal);
  }

  status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    return this.client.status(executionId, binding);
  }

  interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    return this.client.interrupt(executionId, binding);
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
    const child = this.process;
    this.process = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise();
      }, 1_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
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
    if (await this.isReachable(endpointUrl, saved.accessToken)) return;

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
    const child = spawn(process.execPath, [this.agentPath], {
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
      },
      stdio: 'ignore',
    });
    this.process = child;
    child.once('exit', () => {
      if (this.process === child) this.process = null;
    });
    await this.waitUntilReachable(endpointUrl, saved.accessToken, child);
  }

  private async isReachable(endpointUrl: string, accessToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${endpointUrl}/api/info`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitUntilReachable(endpointUrl: string, accessToken: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Host Executor process exited before it became ready (code ${child.exitCode ?? 'signal'}).`);
      }
      if (await this.isReachable(endpointUrl, accessToken)) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    throw new Error('Host Executor did not become ready within 15 seconds.');
  }
}
