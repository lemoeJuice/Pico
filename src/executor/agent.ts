import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  prepareLegacyContainerIdleMarkers,
  startRemoteExecutorServer,
  writeLegacyContainerIdleMarker,
  type RunningRemoteExecutorServer,
} from './remote-server.js';

async function notifySupervisor(type: 'idle' | 'restart', version?: string): Promise<void> {
  if (!process.send) return;
  await new Promise<void>((resolvePromise) => {
    process.send!({ type, ...(version ? { version } : {}) }, () => resolvePromise());
  });
}

async function main(): Promise<void> {
  const installPath = process.env.PICO_EXECUTOR_INSTALL_PATH ?? process.argv[1];
  const versionFile =
    process.env.PICO_EXECUTOR_VERSION_FILE ??
    (installPath?.endsWith('.mjs') ? `${resolve(installPath)}.version` : undefined);
  const installedVersion =
    process.env.PICO_EXECUTOR_VERSION ??
    ((versionFile ? (await readFile(versionFile, 'utf8').catch(() => '')).trim() : '') || undefined);
  let server: RunningRemoteExecutorServer;
  const supervised = process.env.PICO_EXECUTOR_SUPERVISED === '1';
  const legacyContainerOptIn = await prepareLegacyContainerIdleMarkers(installPath);
  const legacyContainerHealthIdle = legacyContainerOptIn && !supervised;
  const containerIdleEnabled = supervised || legacyContainerHealthIdle;
  let localHostIdleEnabled = false;
  if (installPath && basename(installPath) === 'executor-host.mjs' && process.env.PICO_EXECUTOR_FILESYSTEM_MODE === 'host') {
    try {
      const marker = await lstat(`${resolve(installPath)}.idle-enabled`);
      localHostIdleEnabled = marker.isFile() && !marker.isSymbolicLink();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const idleTimeoutText = process.env.PICO_EXECUTOR_IDLE_TIMEOUT_MS;
  const configuredIdleTimeoutMs = idleTimeoutText === undefined ? undefined : Number(idleTimeoutText);
  const idleTimeoutMs = containerIdleEnabled || localHostIdleEnabled ? (configuredIdleTimeoutMs ?? 60_000) : configuredIdleTimeoutMs;
  if (idleTimeoutMs !== undefined && (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1)) {
    throw new Error('PICO_EXECUTOR_IDLE_TIMEOUT_MS must be a positive number.');
  }
  const update = installPath?.endsWith('.mjs')
    ? async (bundle: Buffer, version: string): Promise<void> => {
        const target = resolve(installPath);
        const versionPath = process.env.PICO_EXECUTOR_VERSION_FILE ?? `${target}.version`;
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${process.pid}.next`;
        const temporaryVersion = `${versionPath}.${process.pid}.next`;
        await writeFile(temporary, bundle, { mode: 0o700 });
        await chmod(temporary, 0o700);
        await writeFile(temporaryVersion, version, { mode: 0o600 });
        await rename(temporary, target);
        await rename(temporaryVersion, versionPath);
        const restart = setTimeout(() => {
          void server.close().then(async () => {
            if (process.env.PICO_EXECUTOR_SUPERVISED === '1') {
              await notifySupervisor('restart', version);
              process.exit(0);
            }
            const child = spawn(process.execPath, [target], {
              cwd: process.cwd(),
              env: { ...process.env, PICO_EXECUTOR_VERSION: version, PICO_EXECUTOR_VERSION_FILE: versionPath },
              detached: true,
              stdio: 'inherit',
            });
            child.unref();
            process.exit(0);
          });
        }, 800);
        restart.unref();
      }
    : undefined;
  server = await startRemoteExecutorServer({
    ...(process.env.PICO_EXECUTOR_HOST ? { host: process.env.PICO_EXECUTOR_HOST } : {}),
    ...(process.env.PICO_EXECUTOR_PORT ? { port: Number(process.env.PICO_EXECUTOR_PORT) } : {}),
    token: process.env.PICO_EXECUTOR_TOKEN ?? '',
    workspaceRoot: process.env.PICO_EXECUTOR_WORKSPACE_ROOT ?? process.cwd(),
    // Older local Host agents restart themselves with their original environment
    // after an update, before the Runtime can launch them with the new flag.
    filesystemMode:
      process.env.PICO_EXECUTOR_FILESYSTEM_MODE === 'host' ||
      (process.env.PICO_EXECUTOR_FILESYSTEM_MODE === undefined &&
        process.env.PICO_EXECUTOR_WORKSPACE_ROOT === '/' &&
        basename(process.env.PICO_EXECUTOR_INSTALL_PATH ?? '') === 'executor-host.mjs')
        ? 'host'
        : 'scoped',
    ...(process.env.PICO_EXECUTOR_NAME ? { name: process.env.PICO_EXECUTOR_NAME } : {}),
    databasePath: process.env.PICO_EXECUTOR_DB_PATH ?? join(process.cwd(), 'data', 'executor.sqlite'),
    ...(installedVersion ? { executorVersion: installedVersion } : {}),
    ...(idleTimeoutMs !== undefined
      ? {
          idle: {
            timeoutMs: idleTimeoutMs,
            ...(legacyContainerHealthIdle ? { retryOnError: true } : {}),
            onIdle: async () => {
              if (supervised) {
                await server.close();
                await notifySupervisor('idle');
                process.exit(0);
              }
              if (legacyContainerHealthIdle) {
                await writeLegacyContainerIdleMarker();
                return;
              }
              await server.close();
              process.exit(0);
            },
          },
        }
      : {}),
    ...(update ? { update } : {}),
  });
  console.log(`Pico Executor is ready on port ${server.port}`);
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
