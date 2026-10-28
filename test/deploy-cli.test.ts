import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import * as manifestUntyped from '../scripts/deploy/manifest.mjs';

const manifest = manifestUntyped as unknown as {
  buildReleaseManifest(root: string): unknown;
  writeReleaseBaseline(file: string, baseline: unknown): void;
};
const run = promisify(execFile);
const roots: string[] = [];

async function put(root: string, name: string, content: string): Promise<void> {
  const file = join(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(withBaseline: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pico-deploy-cli-'));
  roots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await cp(join(process.cwd(), 'scripts/deploy-production.mjs'), join(root, 'scripts/deploy-production.mjs'));
  await cp(join(process.cwd(), 'scripts/deploy'), join(root, 'scripts/deploy'), { recursive: true });
  await put(root, 'src/server.ts', 'server v1');
  await put(root, 'src/web/App.tsx', 'web v1');
  await put(root, 'plugins/pico.todo/webui/index.html', 'plugin UI');
  if (withBaseline) {
    manifest.writeReleaseBaseline(join(root, '.pico-deploy-state.json'), manifest.buildReleaseManifest(root));
    await put(root, 'src/server.ts', 'server v2');
    await put(root, 'src/web/App.tsx', 'web v2');
  }
  return root;
}

async function cli(root: string, ...args: string[]) {
  try {
    const output = await run(process.execPath, [join(root, 'scripts/deploy-production.mjs'), ...args], { cwd: root });
    return { status: 0, output: output.stdout + output.stderr };
  } catch (error) {
    const failed = error as Error & { code: number; stdout: string; stderr: string };
    return { status: failed.code, output: (failed.stdout ?? '') + (failed.stderr ?? '') + failed.message };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('requires a deployment scope and only reports differences in the unscoped preview', async () => {
  const root = await fixture(true);
  const missing = await cli(root);
  expect(missing.status).not.toBe(0);
  expect(missing.output).toContain('Explicitly select');
  const preview = await cli(root, '--plan');
  expect(preview.status).toBe(0);
  expect(preview.output).toContain('差异 runtime');
  expect(preview.output).toContain('差异 web');
  expect(preview.output).not.toContain('已选择：');
});

it('warns about other changed targets without widening an explicitly selected WebUI release', async () => {
  const root = await fixture(true);
  const rejected = await cli(root, '--plan', '--web');
  expect(rejected.status).not.toBe(0);
  expect(rejected.output).toContain('Unselected release targets also changed: runtime');
  const accepted = await cli(root, '--plan', '--web', '--accept-warnings');
  expect(accepted.status).toBe(0);
  expect(accepted.output).toContain('已选择：主 WebUI');
  expect(accepted.output).not.toContain('已选择：完整部署');
  const full = await cli(root, '--plan', '--full');
  expect(full.status).toBe(0);
  expect(full.output).toContain('已选择：完整部署');
});

it('requires an existing baseline for UI release but allows a checks-only preview', async () => {
  const root = await fixture(false);
  const web = await cli(root, '--plan', '--web', '--accept-warnings');
  expect(web.status).not.toBe(0);
  expect(web.output).toContain('trusted baseline');
  const checks = await cli(root, '--plan', '--checks');
  expect(checks.status).toBe(0);
  expect(checks.output).toContain('已选择：仅运行检查');
});

it('keeps explicit plugin choices separate from the main WebUI and rejects conflicting scopes', async () => {
  const root = await fixture(true);
  const plugin = await cli(root, '--plan', '--plugin-ui=pico.todo', '--accept-warnings');
  expect(plugin.status).toBe(0);
  expect(plugin.output).toContain('已选择：插件 UI pico.todo');
  expect(plugin.output).not.toContain('已选择：主 WebUI');
  const all = await cli(root, '--plan', '--all-plugin-uis', '--accept-warnings');
  expect(all.status).toBe(0);
  expect(all.output).toContain('已选择：插件 UI pico.todo');
  const conflict = await cli(root, '--plan', '--full', '--web');
  expect(conflict.status).not.toBe(0);
  expect(conflict.output).toContain('cannot be combined');
});
