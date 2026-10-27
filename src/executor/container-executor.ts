import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, resolve, join } from 'node:path';
import type { Execution, ExecutorBinding, ToolDefinition } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { currentExecutorBundle, currentExecutorVersion } from './bundle.js';
import type { ExecutionListener, ExecutorAdapter, ExecutorServiceAddress } from './executor.js';
import { executorPluginDirectory } from './plugin-host.js';
import { RemoteHostExecutor } from './remote-executor.js';

const CONTAINER_SETTING_PREFIX = 'executor-container-connection:';
const CONTAINER_NAME_SETTING_PREFIX = 'executor-container-name:';
const CONTAINER_INSTALLATION_SETTING = 'executor-container-installation-id';
const CONTAINER_NAME_PREFIX = process.env.PICO_CONTAINER_NAME?.trim() || 'pico-executor';
const CONTAINER_PORT = 4174;
const EXECUTOR_PATH = '/opt/pico/executor-agent.mjs';
const DEFAULT_CONTAINER_IMAGE = 'docker.io/library/node:22-bookworm-slim';
const CONTAINER_RESTART_COOLDOWN_MS = 30_000;

interface SavedContainerConnection {
  port: number;
  accessToken: string;
}

interface ContainerSetup {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
  settled: boolean;
}

interface ContainerProbe {
  reachable: boolean;
  responded: boolean;
  status?: number;
}

function abortError(): DOMException {
  return new DOMException('Executor setup interrupted.', 'AbortError');
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

type PodmanRunner = typeof podman;

function configuredContainerImage(): string {
  return process.env.PICO_CONTAINER_IMAGE?.trim() || DEFAULT_CONTAINER_IMAGE;
}

function findOverlayMountProgram(): string | undefined {
  const configured = process.env.PICO_PODMAN_OVERLAY_MOUNT_PROGRAM?.trim();
  if (configured) return configured;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'fuse-overlayfs');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH for the configured storage helper.
    }
  }
  return undefined;
}

function defaultVfsStorageRoot(): string {
  const configured = process.env.PICO_PODMAN_VFS_ROOT?.trim();
  if (configured) return resolve(configured);
  return join(process.cwd(), 'data', 'podman-vfs');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizedPodmanError(error: unknown): Error {
  const original = message(error);
  const sanitized = original.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    const trimmed = candidate.replace(/[),.;]+$/, '');
    const trailing = candidate.slice(trimmed.length);
    try {
      const url = new URL(trimmed);
      return `${url.origin}${url.pathname}${url.search || url.hash ? '?<redacted>' : ''}${trailing}`;
    } catch {
      return `${trimmed.replace(/[?#].*$/, '?<redacted>')}${trailing}`;
    }
  });
  return sanitized === original && error instanceof Error ? error : new Error(sanitized);
}

function isUnsupportedBtrfsOverlay(error: unknown): boolean {
  return /overlay[^\n]*not supported[^\n]*btrfs|overlay[^\n]*unsupported[^\n]*btrfs/i.test(message(error));
}

function podman(args: string[], input?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException('Executor setup interrupted.', 'AbortError'));
    const child = spawn('podman', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-100_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_500);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('Executor setup interrupted.', 'AbortError'));
      if (code !== 0) return reject(new Error(stderr.trim() || `podman exited with code ${code ?? 1}`));
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Could not allocate a Container Executor port.'));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

export class ContainerExecutor implements ExecutorAdapter {
  readonly kind = 'container' as const;
  private readonly client: RemoteHostExecutor;
  private readonly installationId: string;
  private readonly containerImage: string;
  private readonly mountProgram: string | undefined;
  private readonly vfsRoot: string;
  private readonly pluginDirectory: string;
  private readonly connectionPromises = new Map<string, Promise<SavedContainerConnection>>();
  private readonly setupPromises = new Map<string, ContainerSetup>();
  private readonly restartAttempts = new Map<string, number>();
  private storageArgs: string[] | null = null;

  constructor(
    private readonly store: PicoStore,
    onExecution: ExecutionListener = () => undefined,
    image = configuredContainerImage(),
    private readonly runPodmanCommand: PodmanRunner = podman,
    overlayMountProgram = findOverlayMountProgram(),
    vfsStorageRoot = defaultVfsStorageRoot(),
    pluginDirectory = executorPluginDirectory(),
  ) {
    this.installationId = this.getInstallationId();
    this.containerImage = image;
    this.mountProgram = overlayMountProgram;
    this.vfsRoot = vfsStorageRoot;
    this.pluginDirectory = pluginDirectory;
    this.client = new RemoteHostExecutor(store, onExecution, async (binding, signal) =>
      this.addressFor(binding, signal),
    );
  }

  listTools(binding: ExecutorBinding): Promise<ToolDefinition[]> {
    return this.client.listTools(binding);
  }

  checkConnection(binding: ExecutorBinding) {
    return this.client.checkConnection(binding);
  }

  update(binding: ExecutorBinding, bundle: Uint8Array, version: string): Promise<{ executorVersion: string }> {
    return this.client.update(binding, bundle, version);
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
    // Workspace containers and their execution ledgers persist across Runtime restarts.
    await this.client.shutdown();
  }

  private connection(workspaceKey: string): Promise<SavedContainerConnection> {
    let promise = this.connectionPromises.get(workspaceKey);
    if (promise) return promise;
    promise = (async () => {
      const settingName = `${CONTAINER_SETTING_PREFIX}${workspaceKey}`;
      const current = this.store.getSetting<SavedContainerConnection | null>(settingName, null);
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
      this.store.setSetting(settingName, created);
      return created;
    })();
    this.connectionPromises.set(workspaceKey, promise);
    return promise;
  }

  private getInstallationId(): string {
    const saved = this.store.getSetting<string | null>(CONTAINER_INSTALLATION_SETTING, null);
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
    const created = randomBytes(16).toString('hex');
    this.store.setSetting(CONTAINER_INSTALLATION_SETTING, created);
    return created;
  }

  private async addressFor(binding: ExecutorBinding, signal?: AbortSignal): Promise<ExecutorServiceAddress> {
    const workspace = await realpath(binding.workspacePath);
    const workspaceInfo = await stat(workspace);
    if (!workspaceInfo.isDirectory()) throw new Error('Container workspace must be a directory.');
    const workspaceKey = createHash('sha256').update(workspace).digest('hex');
    const containerName = this.containerName(workspaceKey);
    await this.ensureService(workspace, workspaceKey, containerName, signal);
    const saved = await this.connection(workspaceKey);
    return {
      endpointUrl: `http://127.0.0.1:${saved.port}`,
      accessToken: saved.accessToken,
      workspacePath: '/workspace',
    };
  }

  private containerName(workspaceKey: string): string {
    const settingName = `${CONTAINER_NAME_SETTING_PREFIX}${workspaceKey}`;
    const saved = this.store.getSetting<string | null>(settingName, null);
    if (saved) return saved;
    const created = `${CONTAINER_NAME_PREFIX}-${this.installationId.slice(0, 16)}-${workspaceKey.slice(0, 32)}`;
    this.store.setSetting(settingName, created);
    return created;
  }

  private async ensureService(
    workspace: string,
    workspaceKey: string,
    containerName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    let setup = this.setupPromises.get(workspaceKey);
    if (!setup) {
      const created: ContainerSetup = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        waiters: 0,
        settled: false,
      };
      created.promise = this.setupService(workspace, workspaceKey, containerName, created.controller.signal).finally(
        () => {
          created.settled = true;
          if (this.setupPromises.get(workspaceKey) === created) this.setupPromises.delete(workspaceKey);
        },
      );
      this.setupPromises.set(workspaceKey, created);
      setup = created;
    }

    setup.waiters += 1;
    try {
      await awaitWithSignal(setup.promise, signal);
    } finally {
      setup.waiters -= 1;
      if (!setup.settled && setup.waiters === 0) {
        setup.controller.abort();
        if (this.setupPromises.get(workspaceKey) === setup) this.setupPromises.delete(workspaceKey);
      }
    }
  }

  private async setupService(
    workspace: string,
    workspaceKey: string,
    containerName: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.callPodman(['info', '--format', '{{.Version.Version}}'], undefined, signal);
    const root = await realpath(workspace);
    if (!(await stat(root)).isDirectory()) throw new Error('Container workspace must be a directory.');
    await mkdir(this.pluginDirectory, { recursive: true });
    const saved = await this.connection(workspaceKey);
    const running = await this.inspectContainer(containerName, signal);
    if (running.exists && running.running) {
      const probe = await this.probeConnection(saved.port, saved.accessToken, signal);
      if (!probe.reachable) {
        if (probe.responded) {
          throw new Error(`Container Executor endpoint returned HTTP ${probe.status ?? 'an error'}; restart skipped.`);
        }
        await this.restartAndRecover(workspace, workspaceKey, containerName, saved, signal);
        return;
      }
    }
    if (!running.exists) {
      await this.callPodman(
        [
          'run',
          '-d',
          '--name',
          containerName,
          '--restart=unless-stopped',
          '--label',
          'io.pico.executor=workspace',
          '--label',
          `io.pico.workspace-key=${workspaceKey}`,
          '--label',
          `io.pico.installation-id=${this.installationId}`,
          '-p',
          `127.0.0.1:${saved.port}:${CONTAINER_PORT}`,
          '--volume',
          `${root}:/workspace:rw`,
          '--volume',
          `pico-executor-data-${this.installationId.slice(0, 16)}-${workspaceKey.slice(0, 32)}:/opt/pico/data:rw`,
          '--volume',
          `${this.pluginDirectory}:/opt/pico/executor-plugins:ro`,
          '-e',
          `PICO_EXECUTOR_TOKEN=${saved.accessToken}`,
          this.containerImage,
          'sleep',
          'infinity',
        ],
        undefined,
        signal,
      );
    } else if (!running.running) {
      await this.callPodman(['start', containerName], undefined, signal);
    }

    await this.callPodman(
      ['exec', containerName, 'sh', '-lc', 'mkdir -p /opt/pico/data /opt/pico/executor-plugins'],
      undefined,
      signal,
    );
    const versionPath = `${EXECUTOR_PATH}.version`;
    let installedVersion = 'unknown';
    if (!(await this.containerFileExists(containerName, EXECUTOR_PATH, signal))) {
      installedVersion = currentExecutorVersion();
      const bundle = await currentExecutorBundle();
      await this.callPodman(
        ['exec', '-i', containerName, 'sh', '-lc', `base64 -d > ${EXECUTOR_PATH} && chmod 700 ${EXECUTOR_PATH}`],
        bundle.toString('base64'),
        signal,
      );
      await this.callPodman(
        ['exec', '-i', containerName, 'sh', '-lc', `cat > ${versionPath}`],
        installedVersion,
        signal,
      );
    } else if (await this.containerFileExists(containerName, versionPath, signal)) {
      const version = await this.callPodman(['exec', containerName, 'cat', versionPath], undefined, signal);
      installedVersion = version.stdout.trim() || 'unknown';
    } else {
      await this.callPodman(
        ['exec', '-i', containerName, 'sh', '-lc', `cat > ${versionPath}`],
        installedVersion,
        signal,
      );
    }
    if (!(await this.isReachable(saved.port, saved.accessToken, signal))) {
      await this.callPodman(
        this.agentLaunchArgs(containerName, saved.accessToken, versionPath, installedVersion),
        undefined,
        signal,
      );
      await this.waitUntilReachable(saved.port, saved.accessToken, signal);
    }
  }

  private async restartAndRecover(
    workspace: string,
    workspaceKey: string,
    containerName: string,
    saved: SavedContainerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    const endpointUrl = `http://127.0.0.1:${saved.port}`;
    if (await this.hasActiveExecutorTransaction(workspace, endpointUrl)) {
      throw new Error(
        'Container Executor connection timed out; restart skipped because an Executor transaction is active.',
      );
    }

    const now = Date.now();
    const previousAttempt = this.restartAttempts.get(workspaceKey);
    if (previousAttempt !== undefined && now - previousAttempt < CONTAINER_RESTART_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((CONTAINER_RESTART_COOLDOWN_MS - (now - previousAttempt)) / 1_000);
      throw new Error(`Container Executor restart was attempted recently; retry in ${remainingSeconds} seconds.`);
    }
    this.restartAttempts.set(workspaceKey, now);

    let restartError: unknown;
    try {
      await this.callPodman(['restart', containerName], undefined, signal);
    } catch (error) {
      if (signal.aborted) throw abortError();
      restartError = error;
    }

    const state = await this.inspectContainer(containerName, signal);
    if (!state.exists || !state.running) {
      throw new Error(
        `Container Executor restart did not leave the container running.${restartError ? ` ${message(restartError)}` : ''}`,
      );
    }

    const afterRestart = await this.probeConnection(saved.port, saved.accessToken, signal);
    if (afterRestart.reachable) {
      this.restartAttempts.delete(workspaceKey);
      return;
    }
    if (afterRestart.responded) {
      throw new Error(`Container Executor returned HTTP ${afterRestart.status ?? 'an error'} after restart.`);
    }

    const versionPath = `${EXECUTOR_PATH}.version`;
    if (!(await this.containerFileExists(containerName, EXECUTOR_PATH, signal))) {
      throw new Error(
        'Container restarted, but its existing Executor agent file is missing; automatic recovery stopped.',
      );
    }
    const installedVersion = (await this.containerFileExists(containerName, versionPath, signal))
      ? (await this.callPodman(['exec', containerName, 'cat', versionPath], undefined, signal)).stdout.trim() ||
        'unknown'
      : 'unknown';
    await this.callPodman(
      this.agentLaunchArgs(containerName, saved.accessToken, versionPath, installedVersion),
      undefined,
      signal,
    );
    await this.waitUntilReachable(saved.port, saved.accessToken, signal);
    this.restartAttempts.delete(workspaceKey);
  }

  private async hasActiveExecutorTransaction(workspace: string, endpointUrl: string): Promise<boolean> {
    if (this.client.hasInFlightExecutionAt(endpointUrl)) return true;
    for (const workspacePath of this.store.listRunningContainerExecutorWorkspacePaths()) {
      try {
        if ((await realpath(workspacePath)) === workspace) return true;
      } catch {
        // A removed workspace cannot identify the live canonical container path.
      }
    }
    return false;
  }

  private agentLaunchArgs(
    containerName: string,
    accessToken: string,
    versionPath: string,
    installedVersion: string,
  ): string[] {
    return [
      'exec',
      '-d',
      containerName,
      'env',
      'PICO_EXECUTOR_HOST=0.0.0.0',
      `PICO_EXECUTOR_PORT=${CONTAINER_PORT}`,
      `PICO_EXECUTOR_TOKEN=${accessToken}`,
      'PICO_EXECUTOR_WORKSPACE_ROOT=/workspace',
      'PICO_EXECUTOR_DB_PATH=/opt/pico/data/executor.sqlite',
      'PICO_EXECUTOR_PLUGIN_DIR=/opt/pico/executor-plugins',
      `PICO_EXECUTOR_INSTALL_PATH=${EXECUTOR_PATH}`,
      `PICO_EXECUTOR_VERSION_FILE=${versionPath}`,
      `PICO_EXECUTOR_VERSION=${installedVersion}`,
      'node',
      EXECUTOR_PATH,
    ];
  }

  private async inspectContainer(
    containerName: string,
    signal?: AbortSignal,
  ): Promise<{ exists: boolean; running: boolean }> {
    try {
      const result = await this.callPodman(
        ['container', 'inspect', containerName, '--format', '{{.State.Running}}'],
        undefined,
        signal,
      );
      return { exists: true, running: result.stdout.trim() === 'true' };
    } catch (error) {
      if (/no such container|not found|does not exist/i.test(message(error))) return { exists: false, running: false };
      throw error;
    }
  }

  private async containerFileExists(containerName: string, path: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.callPodman(['exec', containerName, 'sh', '-lc', `test -s ${path}`], undefined, signal);
      return true;
    } catch (error) {
      if (/exit code 1|returned non-zero|command exited/i.test(message(error))) return false;
      // Podman versions format command failures differently; test the container state
      // before treating the missing file as a provisioning requirement.
      if (/no such|not running|container state/i.test(message(error))) throw error;
      return false;
    }
  }

  private async isReachable(port: number, accessToken: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.probeConnection(port, accessToken, signal)).reachable;
  }

  private async probeConnection(port: number, accessToken: string, signal?: AbortSignal): Promise<ContainerProbe> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(500)]) : AbortSignal.timeout(500),
      });
      return { reachable: response.ok, responded: true, status: response.status };
    } catch {
      if (signal?.aborted) throw abortError();
      return { reachable: false, responded: false };
    }
  }

  private async waitUntilReachable(port: number, accessToken: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      if (await this.isReachable(port, accessToken, signal)) return;
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolvePromise();
        }, 150);
        const onAbort = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw new Error('Container Executor did not become ready within 15 seconds.');
  }

  private async callPodman(
    args: string[],
    input?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    if (signal?.aborted) throw abortError();
    if (this.storageArgs) {
      try {
        return await this.runPodmanCommand([...this.storageArgs, ...args], input, signal);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw sanitizedPodmanError(error);
      }
    }
    try {
      return await this.runPodmanCommand(args, input, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (!isUnsupportedBtrfsOverlay(error)) throw sanitizedPodmanError(error);
      let fallbackError: unknown;
      if (this.mountProgram) {
        const storageArgs = ['--storage-opt', `overlay.mount_program=${this.mountProgram}`];
        try {
          const result = await this.runPodmanCommand([...storageArgs, ...args], input, signal);
          this.storageArgs = storageArgs;
          return result;
        } catch (caught) {
          if (signal?.aborted) throw abortError();
          fallbackError = sanitizedPodmanError(caught);
        }
      }
      const storageArgs = ['--root', this.vfsRoot, '--storage-driver', 'vfs'];
      try {
        const result = await this.runPodmanCommand([...storageArgs, ...args], input, signal);
        this.storageArgs = storageArgs;
        return result;
      } catch (caught) {
        if (signal?.aborted) throw abortError();
        const safeCaught = sanitizedPodmanError(caught);
        safeCaught.message = `Could not initialize Container Executor Podman storage. ${fallbackError ? message(fallbackError) : message(sanitizedPodmanError(error))}; ${message(safeCaught)}`;
        throw safeCaught;
      }
    }
  }
}
