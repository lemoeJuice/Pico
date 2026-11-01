import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { startRemoteExecutorServer, type RunningRemoteExecutorServer } from './remote-server.js';

async function main(): Promise<void> {
  const installPath = process.env.PICO_EXECUTOR_INSTALL_PATH ?? process.argv[1];
  const versionFile =
    process.env.PICO_EXECUTOR_VERSION_FILE ??
    (installPath?.endsWith('.mjs') ? `${resolve(installPath)}.version` : undefined);
  const installedVersion =
    process.env.PICO_EXECUTOR_VERSION ??
    ((versionFile ? (await readFile(versionFile, 'utf8').catch(() => '')).trim() : '') || undefined);
  let server: RunningRemoteExecutorServer;
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
          void server.close().then(() => {
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
