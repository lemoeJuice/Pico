import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PICO_EXECUTOR_VERSION } from './version.js';

let bundlePromise: Promise<Buffer> | undefined;

export function currentExecutorVersion(): string {
  return PICO_EXECUTOR_VERSION;
}

export function currentExecutorBundle(): Promise<Buffer> {
  bundlePromise ??= loadBundle();
  return bundlePromise;
}

async function loadBundle(): Promise<Buffer> {
  const builtPath = resolve(process.cwd(), 'dist', 'executor-agent.mjs');
  const developmentRun = process.env.npm_lifecycle_event?.startsWith('dev') === true;
  if (existsSync(builtPath) && !developmentRun) return readFile(builtPath);

  const sourcePath = resolve(process.cwd(), 'src', 'executor', 'agent.ts');
  const outputPath = join(tmpdir(), `pico-executor-agent-${process.pid}.mjs`);
  const { build } = await import('esbuild');
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: [sourcePath],
    outfile: outputPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    },
    packages: 'bundle',
    external: ['node:*'],
  });
  return readFile(outputPath);
}
