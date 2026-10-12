import { join } from 'node:path';
import { startRemoteExecutorServer } from './remote-server.js';

async function main(): Promise<void> {
  const server = await startRemoteExecutorServer({
    ...(process.env.PICO_EXECUTOR_HOST ? { host: process.env.PICO_EXECUTOR_HOST } : {}),
    ...(process.env.PICO_EXECUTOR_PORT ? { port: Number(process.env.PICO_EXECUTOR_PORT) } : {}),
    token: process.env.PICO_EXECUTOR_TOKEN ?? '',
    workspaceRoot: process.env.PICO_EXECUTOR_WORKSPACE_ROOT ?? process.cwd(),
    ...(process.env.PICO_EXECUTOR_NAME ? { name: process.env.PICO_EXECUTOR_NAME } : {}),
    databasePath: process.env.PICO_EXECUTOR_DB_PATH ?? join(process.cwd(), 'data', 'executor.sqlite'),
  });
  console.log(`Pico Remote Host Executor is ready on port ${server.port}`);
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
