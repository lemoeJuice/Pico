import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Execution, ExecutorBinding } from '../core/types.js';
import { PicoStore } from '../core/store.js';
import { CONTAINER_RUNNER } from './container-runner.js';
import { ToolCatalog } from './tools.js';
import type { ExecutionListener, ExecutorAdapter } from './executor.js';

interface ToolRunnerResponse {
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: unknown;
  error?: string;
}

type PodmanRunner = typeof podman;
const DEFAULT_CONTAINER_IMAGE = 'docker.io/library/node:22-bookworm-slim';

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
      // Continue through PATH until the standard overlay mount helper is found.
    }
  }
  return undefined;
}

function defaultVfsStorageRoot(): string {
  const configured = process.env.PICO_PODMAN_VFS_ROOT?.trim();
  if (configured) return resolve(configured);
  const databasePath = process.env.PICO_DB_PATH;
  const dataDirectory =
    databasePath && databasePath !== ':memory:' ? dirname(resolve(databasePath)) : join(process.cwd(), 'data');
  return join(dataDirectory, 'podman-vfs');
}

function isUnsupportedBtrfsOverlay(error: unknown): boolean {
  return /overlay[^\n]*not supported[^\n]*btrfs|overlay[^\n]*unsupported[^\n]*btrfs/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function podman(args: string[], input?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException('Execution interrupted', 'AbortError'));
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
    const stop = (): void => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_500);
    };
    const onAbort = (): void => {
      stop();
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
      if (signal?.aborted) return reject(new DOMException('Execution interrupted', 'AbortError'));
      if (code !== 0) return reject(new Error(stderr.trim() || `podman exited with code ${code ?? 1}`));
      resolvePromise({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export class ContainerExecutor implements ExecutorAdapter {
  readonly kind = 'container' as const;
  private readonly inFlight = new Map<string, { promise: Promise<Execution>; controller: AbortController }>();
  private readonly containerIds = new Map<string, string>();
  private readonly containerSetupTails = new Map<string, Promise<void>>();
  private podmanStorageArgs: string[] | null = null;

  constructor(
    private readonly store: PicoStore,
    private readonly tools: ToolCatalog,
    private readonly onExecution: ExecutionListener = () => undefined,
    private readonly image = configuredContainerImage(),
    private readonly runPodmanCommand: PodmanRunner = podman,
    private readonly overlayMountProgram = findOverlayMountProgram(),
    private readonly vfsStorageRoot = defaultVfsStorageRoot(),
  ) {}

  async checkConnection(_binding: ExecutorBinding, signal?: AbortSignal): Promise<void> {
    await this.callPodman(['info', '--format', '{{.Version.Version}}'], undefined, signal);
  }

  private async callPodman(
    args: string[],
    input?: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.podmanStorageArgs) {
      return this.runPodmanCommand([...this.podmanStorageArgs, ...args], input, signal);
    }
    try {
      return await this.runPodmanCommand(args, input, signal);
    } catch (error) {
      if (!isUnsupportedBtrfsOverlay(error)) throw error;
      const original = errorMessage(error);
      let fallbackReason = original;
      if (this.overlayMountProgram) {
        const storageArgs = ['--storage-opt', `overlay.mount_program=${this.overlayMountProgram}`];
        try {
          const result = await this.runPodmanCommand([...storageArgs, ...args], input, signal);
          this.podmanStorageArgs = storageArgs;
          return result;
        } catch (fallbackError) {
          fallbackReason += `\nPodman could not use fuse-overlayfs helper ${this.overlayMountProgram}: ${errorMessage(fallbackError)}`;
        }
      } else {
        fallbackReason +=
          '\nNo fuse-overlayfs helper was found; Pico is retrying with an isolated VFS store. Set PICO_PODMAN_OVERLAY_MOUNT_PROGRAM to use a compatible overlay helper.';
      }
      const storageArgs = ['--root', this.vfsStorageRoot, '--storage-driver', 'vfs'];
      try {
        const result = await this.runPodmanCommand([...storageArgs, ...args], input, signal);
        this.podmanStorageArgs = storageArgs;
        return result;
      } catch (fallbackError) {
        throw new Error(
          `${fallbackReason}\nPodman could not initialize isolated VFS storage at ${this.vfsStorageRoot}: ${errorMessage(fallbackError)}`,
          { cause: fallbackError },
        );
      }
    }
  }

  async execute(executionId: string, binding: ExecutorBinding, externalSignal?: AbortSignal): Promise<Execution> {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} was not durably created`);
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const active = this.inFlight.get(executionId);
    if (active) return active.promise;
    if (current.status === 'running') return this.resumeExisting(executionId, binding, externalSignal);
    const tool = current.toolName ? this.tools.get(current.toolName) : undefined;
    if (!tool || tool.source !== 'executor') {
      return this.store.transitionExecution(executionId, 'failed', {
        error: `Container tool “${current.toolName ?? 'unknown'}” is not registered.`,
      });
    }
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', relayAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    const promise = (async () => {
      await this.ensureContainer(binding, controller.signal);
      const running = this.store.transitionExecution(executionId, 'running');
      this.onExecution(running);
      return this.runRemote(executionId, current.toolName!, current.arguments ?? {}, binding, controller.signal);
    })()
      .catch((error: unknown) => {
        const latest = this.store.getExecution(executionId);
        if (!latest || latest.status === 'completed' || latest.status === 'failed' || latest.status === 'interrupted')
          return latest!;
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return this.store.transitionExecution(executionId, 'interrupted', { error: 'Execution was interrupted.' });
        }
        // Once submitted, a lost Podman response cannot prove whether the tool started or finished.
        if (latest.status === 'running') return latest;
        // Before submission, transient setup failures leave the durable execution available for retry.
        if (
          latest.status === 'pending' &&
          /connection|refused|permission denied|read-only/i.test(error instanceof Error ? error.message : String(error))
        )
          return latest;
        return this.store.transitionExecution(executionId, latest.status === 'pending' ? 'failed' : 'interrupted', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(executionId);
      });
    this.inFlight.set(executionId, { promise, controller });
    return promise;
  }

  async status(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current) return null;
    if (
      current.status === 'pending' ||
      current.status === 'completed' ||
      current.status === 'failed' ||
      current.status === 'interrupted'
    )
      return current;
    if (this.inFlight.has(executionId)) return current;
    return this.refreshStatus(executionId, binding);
  }

  private async refreshStatus(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const current = this.store.getExecution(executionId);
    if (!current) return null;
    if (current.status !== 'running') return current;
    const name = this.containerName(binding.id);
    const exists = await this.containerExists(name);
    if (!exists)
      return this.store.transitionExecution(executionId, 'interrupted', {
        error: 'The Container Executor confirmed that its previous container no longer exists.',
        detail: { confirmedMissing: true },
      });
    await this.startContainer(name);
    const response = await this.callRunner(name, 'status', this.executionKey(executionId));
    return this.acceptRunnerResponse(executionId, response);
  }

  async interrupt(executionId: string, binding: ExecutorBinding): Promise<Execution | null> {
    const active = this.inFlight.get(executionId);
    if (active) {
      if (this.store.getExecution(executionId)?.status === 'pending') {
        active.controller.abort();
        return active.promise;
      }
      const response = await this.callRunner(
        this.containerName(binding.id),
        'interrupt',
        this.executionKey(executionId),
      );
      const updated = this.acceptRunnerResponse(executionId, response);
      if (updated.status !== 'running') active.controller.abort();
      return updated;
    }
    const current = this.store.getExecution(executionId);
    if (!current || current.status !== 'running') return current;
    const name = this.containerName(binding.id);
    if (!(await this.containerExists(name))) {
      return this.store.transitionExecution(executionId, 'interrupted', {
        error: 'The Container Executor confirmed that its previous container no longer exists.',
        detail: { confirmedMissing: true },
      });
    }
    const response = await this.callRunner(name, 'interrupt', this.executionKey(executionId));
    return this.acceptRunnerResponse(executionId, response);
  }

  private async resumeExisting(
    executionId: string,
    binding: ExecutorBinding,
    signal?: AbortSignal,
  ): Promise<Execution> {
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    const promise = (async () => {
      const existing = await this.status(executionId, binding);
      if (!existing || existing.status !== 'running') return existing!;
      return this.poll(executionId, binding, controller.signal);
    })()
      .catch((error: unknown) => this.store.getExecution(executionId) ?? Promise.reject(error))
      .finally(() => {
        signal?.removeEventListener('abort', relayAbort);
        this.inFlight.delete(executionId);
      });
    this.inFlight.set(executionId, { promise, controller });
    return promise;
  }

  private async runRemote(
    executionId: string,
    toolName: string,
    args: Record<string, unknown>,
    binding: ExecutorBinding,
    signal: AbortSignal,
  ): Promise<Execution> {
    const name = this.containerName(binding.id);
    const key = this.executionKey(executionId);
    const response = await this.callRunner(name, 'run', key, toolName, args, signal);
    if (response.status === 'running') return this.poll(executionId, binding, signal);
    return this.acceptRunnerResponse(executionId, response);
  }

  private async poll(executionId: string, binding: ExecutorBinding, signal: AbortSignal): Promise<Execution> {
    while (!signal.aborted) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      const status = await this.refreshStatus(executionId, binding);
      if (!status || status.status !== 'running') return status!;
    }
    return this.store.getExecution(executionId)!;
  }

  private acceptRunnerResponse(executionId: string, response: ToolRunnerResponse): Execution {
    const current = this.store.getExecution(executionId);
    if (!current) throw new Error(`Execution ${executionId} not found`);
    if (response.status === 'running') return current;
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted')
      return current;
    const updated = this.store.transitionExecution(executionId, response.status, {
      ...(Object.hasOwn(response, 'result') ? { result: response.result } : {}),
      ...(response.error ? { error: response.error } : {}),
      detail: { source: 'container-runner' },
    });
    this.onExecution(updated);
    return updated;
  }

  private async callRunner(
    name: string,
    mode: 'run' | 'status' | 'interrupt',
    key: string,
    toolName?: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolRunnerResponse> {
    const command = ['exec', '-i', name, 'node', '-e', CONTAINER_RUNNER, mode, key, ...(toolName ? [toolName] : [])];
    const { stdout } = await this.callPodman(command, args ? JSON.stringify(args) : undefined, signal);
    try {
      return JSON.parse(stdout) as ToolRunnerResponse;
    } catch {
      throw new Error(`Container Executor returned invalid status: ${stdout.slice(0, 300)}`);
    }
  }

  private async ensureContainer(binding: ExecutorBinding, signal?: AbortSignal): Promise<void> {
    const previous = this.containerSetupTails.get(binding.id);
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous ? previous.then(() => turn) : turn;
    this.containerSetupTails.set(binding.id, tail);
    void tail.then(() => {
      if (this.containerSetupTails.get(binding.id) === tail) this.containerSetupTails.delete(binding.id);
    });
    try {
      if (previous) await previous;
      if (signal?.aborted) throw new DOMException('Execution interrupted', 'AbortError');
      await this.prepareContainer(binding, signal);
    } finally {
      release();
    }
  }

  private async prepareContainer(binding: ExecutorBinding, signal?: AbortSignal): Promise<void> {
    await this.checkConnection(binding, signal);
    const name = this.containerName(binding.id);
    if (await this.containerExists(name, signal)) {
      await this.startContainer(name, signal);
      return;
    }
    const volume = `${binding.workspacePath}:/workspace:rw`;
    try {
      await this.callPodman(
        [
          'run',
          '-d',
          '--name',
          name,
          '--label',
          'io.pico.executor=true',
          '--volume',
          volume,
          '--workdir',
          '/workspace',
          this.image,
          'sleep',
          'infinity',
        ],
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) await this.callPodman(['rm', '--force', name]).catch(() => undefined);
      throw error;
    }
    this.containerIds.set(binding.id, name);
  }

  private async containerExists(name: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.callPodman(['inspect', '--type', 'container', name], undefined, signal);
      return true;
    } catch (error) {
      if (
        /no such container|no such object|not found|does not exist/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  private async startContainer(name: string, signal?: AbortSignal): Promise<void> {
    await this.callPodman(['start', name], undefined, signal).catch((error: unknown) => {
      if (error instanceof Error && /already running/i.test(error.message)) return;
      throw error;
    });
  }

  private containerName(executorId: string): string {
    const known = this.containerIds.get(executorId);
    if (known) return known;
    const name = `pico-${executorId.replaceAll('-', '').slice(0, 24)}`;
    this.containerIds.set(executorId, name);
    return name;
  }

  private executionKey(executionId: string): string {
    return createHash('sha256').update(executionId).digest('hex');
  }
}
