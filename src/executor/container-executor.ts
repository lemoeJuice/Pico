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
import { ServiceError } from '../contracts/service-error.js';

const CONTAINER_SETTING_PREFIX = 'executor-container-connection:';
const CONTAINER_NAME_SETTING_PREFIX = 'executor-container-name:';
const CONTAINER_WORKSPACE_KEY_PREFIX = 'executor-container-workspace-key:';
const CONTAINER_ATTACH_SETTING_PREFIX = 'executor-container-attach:';
const CONTAINER_INDEPENDENT_VOLUME_SETTING_PREFIX = 'executor-container-independent-volume:';
const CONTAINER_INSTALLATION_SETTING = 'executor-container-installation-id';
const CONTAINER_NAME_PREFIX = process.env.PICO_CONTAINER_NAME?.trim() || 'pico-executor';
const CONTAINER_PORT = 4174;
const EXECUTOR_PATH = '/opt/pico/executor-agent.mjs';
const INDEPENDENT_WORKSPACE_ROOT = '/pico-thread-work';
const DEFAULT_CONTAINER_IMAGE = 'docker.io/library/node:22-bookworm-slim';

interface SavedContainerConnection {
  port: number;
  accessToken: string;
}

interface ContainerWorkspaceAttachment {
  image: string | null;
  workspace: string;
  status: 'pending' | 'attached' | 'rolled_back';
  snapshotImage?: string;
  snapshotImages?: string[];
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

export interface WorkspaceContainerPlan {
  workspace: string;
  workspaceKey: string;
  attachExecutorId?: string;
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
  private readonly manualRestartPromises = new Map<string, Promise<void>>();
  private readonly manualRestartPathPromises = new Map<string, Promise<void>>();
  private readonly workspaceAttachPromises = new Map<string, Promise<void>>();
  private readonly workspaceRecoveryPromises = new Map<string, Promise<void>>();
  private readonly workspaceRollbackPromises = new Map<string, Promise<void>>();
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
    // Workspace containers and their execution ledgers persist across Runtime restarts.
    await this.client.shutdown();
  }

  async planWorkspaceContainer(
    workspacePath: string,
    candidates: ExecutorBinding[],
  ): Promise<WorkspaceContainerPlan> {
    const workspace = await realpath(resolve(workspacePath));
    if (!(await stat(workspace)).isDirectory()) throw new Error('Container workspace must be a directory.');
    const pathKey = this.workspacePathKey(workspace);
    const savedWorkspaceKey = this.store.getSetting<string | null>(
      `${CONTAINER_WORKSPACE_KEY_PREFIX}${pathKey}`,
      null,
    );
    if (savedWorkspaceKey && /^[a-f0-9]{64}$/.test(savedWorkspaceKey)) {
      return { workspace, workspaceKey: savedWorkspaceKey };
    }

    const pathContainerConfigured =
      this.store.getSetting<string | null>(`${CONTAINER_NAME_SETTING_PREFIX}${pathKey}`, null) !== null ||
      this.store.getSetting<SavedContainerConnection | null>(`${CONTAINER_SETTING_PREFIX}${pathKey}`, null) !== null;
    if (pathContainerConfigured) return { workspace, workspaceKey: pathKey };

    const seed = candidates.find(
      (binding) => binding.kind === 'container' && !binding.remoteConnectionId && !binding.workspacePath.trim(),
    );
    if (!seed) return { workspace, workspaceKey: pathKey };
    return {
      workspace,
      workspaceKey: createHash('sha256').update(`executor:${seed.id}`).digest('hex'),
      attachExecutorId: seed.id,
    };
  }

  setWorkspaceContainerKey(workspacePath: string, workspaceKey: string): void {
    const pathKey = this.workspacePathKey(workspacePath);
    if (!/^[a-f0-9]{64}$/.test(workspaceKey)) throw new Error('Invalid Container workspace key.');
    this.store.setSetting(`${CONTAINER_WORKSPACE_KEY_PREFIX}${pathKey}`, workspaceKey);
  }

  restart(binding: ExecutorBinding): Promise<void> {
    const independent = !binding.workspacePath.trim();
    const stableKey = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const pathKey = independent ? `executor:${binding.id}` : resolve(binding.workspacePath);
    const existing = this.manualRestartPathPromises.get(pathKey);
    if (existing) return existing;
    let promise!: Promise<void>;
    promise = Promise.resolve()
      .then(async () => {
        const attaching = this.workspaceAttachPromises.get(stableKey);
        if (attaching) await attaching;
        if (this.workspaceAttachPromises.has(stableKey)) {
          throw new ServiceError(409, 'Container Executor workspace attachment is pending commit.');
        }
        const workspace = independent ? null : await realpath(binding.workspacePath);
        if (workspace && !(await stat(workspace)).isDirectory())
          throw new Error('Container workspace must be a directory.');
        const attached = this.store.getSetting<ContainerWorkspaceAttachment | null>(
          `${CONTAINER_ATTACH_SETTING_PREFIX}${stableKey}`,
          null,
        );
        if (independent && attached && attached.status !== 'rolled_back') {
          throw new ServiceError(409, 'This Container Executor has been attached to a Project workspace.');
        }
        const workspaceKey = independent
          ? stableKey
          : await this.workspaceContainerKey(workspace!, stableKey, attached);
        const canonicalExisting = this.manualRestartPromises.get(workspaceKey);
        if (canonicalExisting && canonicalExisting !== promise) return canonicalExisting;
        this.manualRestartPromises.set(workspaceKey, promise);
        try {
          const containerName = this.containerName(workspaceKey);
          const setup = this.setupPromises.get(workspaceKey);
          if (setup) await setup.promise.catch(() => undefined);
          const saved = await this.connection(workspaceKey);
          const state = await this.inspectContainer(containerName);
          if (!state.exists) throw new Error('Container Executor has not been created for this workspace.');
          await this.restartAndRecover(workspace, containerName, saved, new AbortController().signal);
        } finally {
          if (this.manualRestartPromises.get(workspaceKey) === promise) this.manualRestartPromises.delete(workspaceKey);
        }
      })
      .finally(() => {
        if (this.manualRestartPathPromises.get(pathKey) === promise) this.manualRestartPathPromises.delete(pathKey);
      });
    this.manualRestartPathPromises.set(pathKey, promise);
    return promise;
  }

  /** Attach a Project workspace to an independent Thread container without replacing its environment. */
  attachWorkspace(binding: ExecutorBinding, workspacePath: string): Promise<void> {
    if (binding.kind !== 'container' || binding.workspacePath.trim()) {
      return Promise.reject(new Error('Only an independent Container Executor can be attached to a workspace.'));
    }
    const pathKey = resolve(workspacePath);
    const stableKey = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const prior = this.workspaceAttachPromises.get(stableKey);
    if (prior) {
      return prior.then(async () => {
        const requestedWorkspace = await realpath(pathKey);
        const record = this.store.getSetting<ContainerWorkspaceAttachment | null>(
          `${CONTAINER_ATTACH_SETTING_PREFIX}${stableKey}`,
          null,
        );
        if (record?.workspace !== requestedWorkspace) {
          throw new Error('Container Executor is already attached to a different workspace.');
        }
      });
    }
    const promise = (async () => {
      const workspace = await realpath(pathKey);
      if (!(await stat(workspace)).isDirectory()) throw new Error('Container workspace must be a directory.');
      const pendingAttachment = this.store.getSetting<ContainerWorkspaceAttachment | null>(
        `${CONTAINER_ATTACH_SETTING_PREFIX}${stableKey}`,
        null,
      );
      if (pendingAttachment?.image) await this.rollbackWorkspaceAttachment(binding);
      else if (pendingAttachment?.status === 'attached') {
        if (pendingAttachment.workspace !== workspace)
          throw new Error('This Container Executor has already been attached to a different Project workspace.');
        return;
      }
      await this.ensureService(null, stableKey, this.containerName(stableKey));
      const saved = await this.connection(stableKey);
      const endpointUrl = `http://127.0.0.1:${saved.port}`;
      if (await this.hasActiveExecutorTransaction(null, endpointUrl)) {
        throw new ServiceError(409, 'Container workspace attach skipped because an Executor transaction is active.');
      }
      const name = this.containerName(stableKey);
      const mount = await this.containerWorkspaceMount(name);
      if (mount === workspace) return;
      if (mount !== null) throw new Error('Container Executor is already attached to a different workspace.');
      await this.recreateWithWorkspace(name, stableKey, workspace, saved);
    })();
    this.workspaceAttachPromises.set(stableKey, promise);
    void promise.catch(() => {
      if (this.workspaceAttachPromises.get(stableKey) === promise) this.workspaceAttachPromises.delete(stableKey);
    });
    return promise;
  }

  /** Copy an independent workspace into a private host staging directory. */
  async copyIndependentWorkspace(binding: ExecutorBinding, stagingPath: string): Promise<void> {
    const key = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const name = this.containerName(key);
    const state = await this.inspectContainer(name);
    if (!state.exists) {
      const savedConnection = this.store.getSetting<SavedContainerConnection | null>(
        `${CONTAINER_SETTING_PREFIX}${key}`,
        null,
      );
      if (savedConnection) {
        throw new Error(
          'Existing independent Container is missing. Automatic workspace copying stopped to protect its container filesystem.',
        );
      }
      return;
    }
    await this.callPodman(['cp', `${name}:${INDEPENDENT_WORKSPACE_ROOT}/.`, resolve(stagingPath)]);
  }

  async finalizeWorkspaceAttachment(binding: ExecutorBinding): Promise<void> {
    const key = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const recovery = this.workspaceRecoveryPromises.get(key);
    if (recovery) await recovery;
    const record = this.store.getSetting<ContainerWorkspaceAttachment | null>(
      `${CONTAINER_ATTACH_SETTING_PREFIX}${key}`,
      null,
    );
    if (!record || record.status === 'rolled_back') {
      throw new Error(
        'Container workspace attachment cannot be finalized because its migration record is missing or rolled back.',
      );
    }
    try {
      this.store.setSetting(`${CONTAINER_ATTACH_SETTING_PREFIX}${key}`, {
        image: null,
        ...((record.image ?? record.snapshotImage) ? { snapshotImage: record.image ?? record.snapshotImage } : {}),
        snapshotImages: [
          ...new Set(
            [...(record.snapshotImages ?? []), record.image, record.snapshotImage].filter((image): image is string =>
              Boolean(image),
            ),
          ),
        ],
        workspace: record.workspace,
        status: 'attached',
      } satisfies ContainerWorkspaceAttachment);
      this.workspaceAttachPromises.delete(key);
      await this.pruneUnreferencedSnapshots(key, record);
    } finally {
      this.workspaceAttachPromises.delete(key);
    }
  }

  async rollbackWorkspaceAttachment(binding: ExecutorBinding): Promise<void> {
    const key = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const prior = this.workspaceRollbackPromises.get(key);
    if (prior) return prior;
    const inProgressRecovery = this.workspaceRecoveryPromises.get(key);
    if (inProgressRecovery) await inProgressRecovery;
    const concurrentRollback = this.workspaceRollbackPromises.get(key);
    if (concurrentRollback) return concurrentRollback;
    const rollback = this.rollbackWorkspaceAttachmentOnce(key)
      .catch((error: unknown) => {
        this.workspaceAttachPromises.delete(key);
        throw error;
      })
      .finally(() => {
        if (this.workspaceRollbackPromises.get(key) === rollback) this.workspaceRollbackPromises.delete(key);
      });
    this.workspaceRollbackPromises.set(key, rollback);
    return rollback;
  }

  private async rollbackWorkspaceAttachmentOnce(key: string): Promise<void> {
    const record = this.store.getSetting<ContainerWorkspaceAttachment | null>(
      `${CONTAINER_ATTACH_SETTING_PREFIX}${key}`,
      null,
    );
    if (record?.status === 'rolled_back') return;
    if (!record?.image) {
      this.workspaceAttachPromises.delete(key);
      return;
    }
    const name = this.containerName(key);
    const saved = await this.connection(key);
    if (await this.hasActiveExecutorTransaction(null, `http://127.0.0.1:${saved.port}`)) {
      throw new ServiceError(409, 'Container workspace rollback skipped because an Executor transaction is active.');
    }
    const state = await this.inspectContainer(name);
    if (!state.exists) {
      await this.runContainer(name, key, record.image, null, saved);
      await this.startAgent(name, saved, INDEPENDENT_WORKSPACE_ROOT);
      await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
      this.store.setSetting(`${CONTAINER_ATTACH_SETTING_PREFIX}${key}`, {
        image: null,
        snapshotImage: record.image,
        snapshotImages: [...new Set([...(record.snapshotImages ?? []), record.image])],
        workspace: record.workspace,
        status: 'rolled_back',
      } satisfies ContainerWorkspaceAttachment);
      this.workspaceAttachPromises.delete(key);
      return;
    }
    const mount = await this.containerWorkspaceMount(name);
    if (mount === null) {
      this.store.setSetting(`${CONTAINER_ATTACH_SETTING_PREFIX}${key}`, {
        image: null,
        snapshotImage: record.image,
        snapshotImages: [...new Set([...(record.snapshotImages ?? []), record.image])],
        workspace: record.workspace,
        status: 'rolled_back',
      } satisfies ContainerWorkspaceAttachment);
      this.workspaceAttachPromises.delete(key);
      return;
    }
    if (mount !== record.workspace) throw new Error('Container workspace changed during attachment rollback.');
    await this.callPodman(['rm', '-f', name]).catch(() => undefined);
    await this.runContainer(name, key, record.image, null, saved);
    await this.startAgent(name, saved, INDEPENDENT_WORKSPACE_ROOT);
    await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
    this.store.setSetting(`${CONTAINER_ATTACH_SETTING_PREFIX}${key}`, {
      image: null,
      snapshotImage: record.image,
      snapshotImages: [...new Set([...(record.snapshotImages ?? []), record.image])],
      workspace: record.workspace,
      status: 'rolled_back',
    } satisfies ContainerWorkspaceAttachment);
    this.workspaceAttachPromises.delete(key);
  }

  private async restorePendingWorkspaceAttachment(binding: ExecutorBinding, workspace: string): Promise<void> {
    const key = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const prior = this.workspaceRecoveryPromises.get(key);
    if (prior) return prior;
    const rollback = this.workspaceRollbackPromises.get(key);
    if (rollback) await rollback;
    const record = this.store.getSetting<ContainerWorkspaceAttachment | null>(
      `${CONTAINER_ATTACH_SETTING_PREFIX}${key}`,
      null,
    );
    if (record?.status === 'rolled_back') {
      throw new ServiceError(409, 'Container workspace attachment was rolled back; retry Project setup.');
    }
    if (!record || record.workspace !== workspace) {
      throw new Error('Container workspace attachment has no matching retained filesystem snapshot.');
    }
    if (record.status === 'attached') {
      const state = await this.inspectContainer(this.containerName(key));
      if (!state.exists) {
        throw new Error(
          'Attached Container is missing. Its attach-time snapshot is retained, but later root filesystem changes cannot be guaranteed from that snapshot; restore or inspect it manually before retrying.',
        );
      }
      const mountedWorkspace = await this.containerWorkspaceMount(this.containerName(key));
      if (mountedWorkspace !== workspace) {
        throw new Error('Attached Container workspace mount is missing or changed; automatic recovery stopped.');
      }
      return;
    }
    const snapshot = record.image;
    if (!snapshot) throw new Error('Pending Container workspace attachment has no recoverable filesystem snapshot.');
    const recovery = this.restoreContainerFromSnapshotOnce(key, workspace, snapshot).finally(() => {
      if (this.workspaceRecoveryPromises.get(key) === recovery) this.workspaceRecoveryPromises.delete(key);
    });
    this.workspaceRecoveryPromises.set(key, recovery);
    return recovery;
  }

  private async restoreContainerFromSnapshotOnce(key: string, workspace: string, image: string): Promise<void> {
    const saved = await this.connection(key);
    if (await this.hasActiveExecutorTransaction(workspace, `http://127.0.0.1:${saved.port}`)) {
      throw new ServiceError(409, 'Container workspace recovery skipped because an Executor transaction is active.');
    }
    const name = this.containerName(key);
    const state = await this.inspectContainer(name);
    let createFromSnapshot = !state.exists;
    if (state.exists) {
      const mountedWorkspace = await this.containerWorkspaceMount(name);
      if (mountedWorkspace !== null && mountedWorkspace !== workspace) {
        throw new Error('Container is mounted to a different workspace; pending recovery stopped.');
      }
      if (mountedWorkspace === null) {
        await this.callPodman(['rm', '-f', name]);
        createFromSnapshot = true;
      } else if (!state.running) await this.callPodman(['start', name]);
    }
    if (createFromSnapshot) {
      await this.runContainer(name, key, image, workspace, saved);
    }
    const probe = await this.probeConnection(saved.port, saved.accessToken);
    if (!probe.reachable) {
      if (probe.responded) throw new Error(`Container Executor endpoint returned HTTP ${probe.status ?? 'an error'}.`);
      await this.startAgent(name, saved, '/workspace');
      await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
    }
  }

  private async pruneUnreferencedSnapshots(key: string, record: ContainerWorkspaceAttachment): Promise<void> {
    const retained = record.image ?? record.snapshotImage;
    for (const image of record.snapshotImages ?? []) {
      if (!image || image === retained) continue;
      try {
        const references = await this.callPodman(['ps', '-a', '--filter', `ancestor=${image}`, '--format', '{{.ID}}']);
        if (references.stdout.trim()) continue;
        await this.callPodman(['image', 'rm', image]);
        const latest = this.store.getSetting<ContainerWorkspaceAttachment | null>(
          `${CONTAINER_ATTACH_SETTING_PREFIX}${key}`,
          null,
        );
        if (!latest) continue;
        this.store.setSetting(`${CONTAINER_ATTACH_SETTING_PREFIX}${key}`, {
          ...latest,
          snapshotImages: (latest.snapshotImages ?? []).filter((candidate) => candidate !== image),
        } satisfies ContainerWorkspaceAttachment);
      } catch {
        // Keep failed/unverifiable snapshots; they may still back a container image layer.
      }
    }
  }

  private async recreateWithWorkspace(
    name: string,
    key: string,
    workspace: string,
    saved: SavedContainerConnection,
  ): Promise<void> {
    const image = `${CONTAINER_NAME_PREFIX}-snapshot-${this.installationId.slice(0, 12)}-${key.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
    const setting = `${CONTAINER_ATTACH_SETTING_PREFIX}${key}`;
    const previous = this.store.getSetting<ContainerWorkspaceAttachment | null>(setting, null);
    // Stop all container processes before the snapshot so writes cannot race the
    // snapshot and subsequent removal of the original container.
    await this.callPodman(['stop', name]);
    try {
      // A running Container carries its Executor credential in its environment.
      // Do not preserve that credential in the resulting image configuration.
      await this.callPodman(['commit', '--change', 'ENV PICO_EXECUTOR_TOKEN=', name, image]);
      this.store.setSetting(setting, {
        image,
        workspace,
        status: 'pending',
        snapshotImages: [
          ...new Set(
            [...(previous?.snapshotImages ?? []), previous?.snapshotImage].filter((item): item is string =>
              Boolean(item),
            ),
          ),
        ],
      } satisfies ContainerWorkspaceAttachment);
    } catch (error) {
      try {
        await this.callPodman(['start', name]);
        await this.startAgent(name, saved, INDEPENDENT_WORKSPACE_ROOT);
        await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
      } catch (restartError) {
        throw new AggregateError([error, restartError], 'Container snapshot failed and the original Container could not be restarted.', { cause: restartError });
      }
      throw error;
    }
    try {
      await this.callPodman(['rm', '-f', name]);
      await this.runContainer(name, key, image, workspace, saved);
      await this.startAgent(name, saved);
      await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
    } catch (error) {
      await this.callPodman(['rm', '-f', name]).catch(() => undefined);
      try {
        await this.runContainer(name, key, image, null, saved);
        await this.startAgent(name, saved, INDEPENDENT_WORKSPACE_ROOT);
        await this.waitUntilReachable(saved.port, saved.accessToken, new AbortController().signal);
        this.store.setSetting(setting, {
          image: null,
          snapshotImage: image,
          snapshotImages: [
            ...new Set(
              [...(previous?.snapshotImages ?? []), previous?.snapshotImage, image].filter((item): item is string =>
                Boolean(item),
              ),
            ),
          ],
          workspace,
          status: 'rolled_back',
        } satisfies ContainerWorkspaceAttachment);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Workspace attachment failed and container rollback failed: ${message(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  private async containerWorkspaceMount(containerName: string): Promise<string | null> {
    const result = await this.callPodman(['container', 'inspect', containerName, '--format', '{{json .Mounts}}']);
    const mounts = JSON.parse(result.stdout.trim() || '[]') as Array<{ Destination?: string; Source?: string }>;
    const workspace = mounts.find((mount) => mount.Destination === '/workspace');
    return workspace?.Source ? await realpath(workspace.Source) : null;
  }

  private async runContainer(
    name: string,
    key: string,
    image: string,
    workspace: string | null,
    saved: SavedContainerConnection,
  ): Promise<void> {
    const independentVolume = this.store.getSetting<boolean>(
      `${CONTAINER_INDEPENDENT_VOLUME_SETTING_PREFIX}${key}`,
      false,
    );
    await this.callPodman([
      'run',
      '-d',
      '--name',
      name,
      '--restart=unless-stopped',
      '--label',
      `io.pico.executor=${workspace ? 'workspace' : 'container'}`,
      '--label',
      `io.pico.executor-key=${key}`,
      ...(workspace ? ['--label', `io.pico.workspace-key=${key}`] : []),
      '--label',
      `io.pico.installation-id=${this.installationId}`,
      '-p',
      `127.0.0.1:${saved.port}:${CONTAINER_PORT}`,
      ...(workspace ? ['--volume', `${workspace}:/workspace:rw`] : []),
      ...(independentVolume ? ['--volume', `${this.independentWorkspaceVolume(key)}:${INDEPENDENT_WORKSPACE_ROOT}:rw`] : []),
      '--volume',
      `pico-executor-data-${this.installationId.slice(0, 16)}-${key.slice(0, 32)}:/opt/pico/data:rw`,
      '--volume',
      `${this.pluginDirectory}:/opt/pico/executor-plugins:ro`,
      '-e',
      `PICO_EXECUTOR_TOKEN=${saved.accessToken}`,
      image,
      'sleep',
      'infinity',
    ]);
  }

  private independentWorkspaceVolume(key: string): string {
    return `pico-thread-work-${this.installationId.slice(0, 16)}-${key.slice(0, 32)}`;
  }

  private async startAgent(name: string, saved: SavedContainerConnection, workspaceRoot = '/workspace'): Promise<void> {
    const versionPath = `${EXECUTOR_PATH}.version`;
    const installedVersion = (await this.containerFileExists(name, versionPath))
      ? (await this.callPodman(['exec', name, 'cat', versionPath])).stdout.trim() || 'unknown'
      : 'unknown';
    await this.callPodman(this.agentLaunchArgs(name, saved.accessToken, versionPath, installedVersion, workspaceRoot));
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
    const independentKey = createHash('sha256').update(`executor:${binding.id}`).digest('hex');
    const attaching = this.workspaceAttachPromises.get(independentKey);
    if (attaching) await awaitWithSignal(attaching, signal);
    if (this.workspaceAttachPromises.has(independentKey)) {
      throw new ServiceError(
        409,
        'Container workspace attachment is being committed. Retry after Project setup completes.',
      );
    }
    const attachment = this.store.getSetting<ContainerWorkspaceAttachment | null>(
      `${CONTAINER_ATTACH_SETTING_PREFIX}${independentKey}`,
      null,
    );
    if (!binding.workspacePath.trim()) {
      if (attachment?.image) await this.rollbackWorkspaceAttachment(binding);
      if (attachment?.status === 'attached')
        throw new Error('This Container Executor has been attached to a Project workspace.');
      const workspaceKey = independentKey;
      const containerName = this.containerName(workspaceKey);
      await this.ensureService(null, workspaceKey, containerName, signal);
      const saved = await this.connection(workspaceKey);
      return { endpointUrl: `http://127.0.0.1:${saved.port}`, accessToken: saved.accessToken, workspacePath: '' };
    }
    const workspace = await realpath(binding.workspacePath);
    const workspaceInfo = await stat(workspace);
    if (!workspaceInfo.isDirectory()) throw new Error('Container workspace must be a directory.');
    if (attachment?.status === 'attached' || attachment?.image) {
      if (attachment.workspace !== workspace) {
        throw new Error('Container attachment record does not match the Project workspace.');
      }
      await this.restorePendingWorkspaceAttachment(binding, workspace);
    }
    const currentAttachment = this.store.getSetting<ContainerWorkspaceAttachment | null>(
      `${CONTAINER_ATTACH_SETTING_PREFIX}${independentKey}`,
      null,
    );
    const workspaceKey = await this.workspaceContainerKey(workspace, independentKey, currentAttachment);
    const containerName = this.containerName(workspaceKey);
    await this.ensureService(workspace, workspaceKey, containerName, signal);
    const saved = await this.connection(workspaceKey);
    if (currentAttachment?.image && currentAttachment.workspace === workspace) {
      const mountedWorkspace = await this.containerWorkspaceMount(containerName);
      if (mountedWorkspace !== workspace)
        throw new Error('Attached Container Executor workspace mount does not match the Project.');
      await this.finalizeWorkspaceAttachment(binding);
    }
    return {
      endpointUrl: `http://127.0.0.1:${saved.port}`,
      accessToken: saved.accessToken,
      workspacePath: '/workspace',
    };
  }

  private workspacePathKey(workspace: string): string {
    return createHash('sha256').update(workspace).digest('hex');
  }

  private async workspaceContainerKey(
    workspace: string,
    independentKey: string,
    attachment: ContainerWorkspaceAttachment | null,
  ): Promise<string> {
    const pathKey = this.workspacePathKey(workspace);
    // Existing attached bindings keep their original container and execution ledger.
    // New independent-to-Project conversions write an explicit path alias below.
    if (
      (attachment?.status === 'attached' || attachment?.status === 'pending') &&
      attachment.workspace === workspace
    ) {
      return independentKey;
    }

    const savedWorkspaceKey = this.store.getSetting<string | null>(
      `${CONTAINER_WORKSPACE_KEY_PREFIX}${pathKey}`,
      null,
    );
    if (savedWorkspaceKey && /^[a-f0-9]{64}$/.test(savedWorkspaceKey)) return savedWorkspaceKey;

    return pathKey;
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
    workspace: string | null,
    workspaceKey: string,
    containerName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    const manualRestart = this.manualRestartPromises.get(workspaceKey);
    if (manualRestart) await awaitWithSignal(manualRestart, signal);
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
    workspace: string | null,
    workspaceKey: string,
    containerName: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.callPodman(['info', '--format', '{{.Version.Version}}'], undefined, signal);
    const root = workspace ? await realpath(workspace) : null;
    if (root && !(await stat(root)).isDirectory()) throw new Error('Container workspace must be a directory.');
    await mkdir(this.pluginDirectory, { recursive: true });
    const connectionSetting = `${CONTAINER_SETTING_PREFIX}${workspaceKey}`;
    const hadSavedConnection = this.store.getSetting<SavedContainerConnection | null>(connectionSetting, null) !== null;
    const saved = await this.connection(workspaceKey);
    const running = await this.inspectContainer(containerName, signal);
    if (running.exists && running.running) {
      const probe = await this.probeConnection(saved.port, saved.accessToken, signal);
      if (!probe.reachable) {
        if (probe.responded) {
          throw new Error(`Container Executor endpoint returned HTTP ${probe.status ?? 'an error'}.`);
        }
        throw new Error('Container Executor connection timed out; use the Thread manual restart action to recover it.');
      }
    }
    if (!running.exists) {
      if (!root && hadSavedConnection) {
        throw new Error(
          'Existing independent Container is missing. Automatic recreation stopped to protect its container filesystem; recover the original Container before retrying.',
        );
      }
      if (!root && !hadSavedConnection) {
        this.store.setSetting(`${CONTAINER_INDEPENDENT_VOLUME_SETTING_PREFIX}${workspaceKey}`, true);
      }
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
          ...(root ? ['--volume', `${root}:/workspace:rw`] : []),
          ...(this.store.getSetting<boolean>(`${CONTAINER_INDEPENDENT_VOLUME_SETTING_PREFIX}${workspaceKey}`, false)
            ? ['--volume', `${this.independentWorkspaceVolume(workspaceKey)}:${INDEPENDENT_WORKSPACE_ROOT}:rw`]
            : []),
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
      [
        'exec',
        containerName,
        'sh',
        '-lc',
        `mkdir -p ${root ? '/workspace' : INDEPENDENT_WORKSPACE_ROOT} /workspace /opt/pico/data /opt/pico/executor-plugins`,
      ],
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
        this.agentLaunchArgs(
          containerName,
          saved.accessToken,
          versionPath,
          installedVersion,
          root ? '/workspace' : INDEPENDENT_WORKSPACE_ROOT,
        ),
        undefined,
        signal,
      );
      await this.waitUntilReachable(saved.port, saved.accessToken, signal);
    }
  }

  private async restartAndRecover(
    workspace: string | null,
    containerName: string,
    saved: SavedContainerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    const endpointUrl = `http://127.0.0.1:${saved.port}`;
    if (await this.hasActiveExecutorTransaction(workspace, endpointUrl)) {
      throw new ServiceError(409, 'Container Executor restart skipped because an Executor transaction is active.');
    }

    let restartError: unknown;
    try {
      const state = await this.inspectContainer(containerName, signal);
      if (!state.exists) throw new Error('Container Executor does not exist.');
      await this.callPodman([state.running ? 'restart' : 'start', containerName], undefined, signal);
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
      return;
    }
    if (afterRestart.responded) {
      throw new Error(`Container Executor returned HTTP ${afterRestart.status ?? 'an error'} after restart.`);
    }

    const versionPath = `${EXECUTOR_PATH}.version`;
    if (!(await this.containerFileExists(containerName, EXECUTOR_PATH, signal))) {
      throw new Error('Container restarted, but its existing Executor agent file is missing; recovery stopped.');
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
  }

  private async hasActiveExecutorTransaction(workspace: string | null, endpointUrl: string): Promise<boolean> {
    if (this.client.hasInFlightExecutionAt(endpointUrl)) return true;
    const activePaths = this.store.listRunningContainerExecutorWorkspacePaths();
    if (!workspace) return activePaths.includes('');
    for (const workspacePath of activePaths) {
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
    workspaceRoot = '/workspace',
  ): string[] {
    return [
      'exec',
      '-d',
      containerName,
      'env',
      'PICO_EXECUTOR_HOST=0.0.0.0',
      `PICO_EXECUTOR_PORT=${CONTAINER_PORT}`,
      `PICO_EXECUTOR_TOKEN=${accessToken}`,
      `PICO_EXECUTOR_WORKSPACE_ROOT=${workspaceRoot}`,
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
