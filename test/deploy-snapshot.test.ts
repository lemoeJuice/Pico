import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import * as snapshotUntyped from '../scripts/deploy/snapshot.mjs';

const { createSourceSnapshot, removeSourceSnapshot } = snapshotUntyped as unknown as {
  createSourceSnapshot(projectRoot: string): Promise<string>;
  removeSourceSnapshot(snapshotRoot: string): Promise<void>;
};
const run = promisify(execFile);
const roots: string[] = [];
const snapshots: string[] = [];

afterEach(async () => {
  await Promise.all(snapshots.splice(0).map((snapshot) => removeSourceSnapshot(snapshot)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('includes the root LICENSE in the source snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pico-deploy-snapshot-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'LICENSE'), 'license terms');
  await writeFile(join(root, 'src/server.ts'), 'export {};');
  await run('git', ['init', '--quiet'], { cwd: root });

  const snapshot = await createSourceSnapshot(root);
  snapshots.push(snapshot);

  await expect(readFile(join(snapshot, 'LICENSE'), 'utf8')).resolves.toBe('license terms');
  await expect(access(join(snapshot, 'src/server.ts'))).resolves.toBeUndefined();
});
