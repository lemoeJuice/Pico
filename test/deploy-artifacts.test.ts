import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { runtimeArtifactHashes } from '../scripts/deploy/artifacts.mjs';

it('detects changes to Runtime and plugin artifacts while ignoring frontend releases', () => {
  const root = mkdtempSync(join(tmpdir(), 'pico-deploy-artifacts-'));
  try {
    mkdirSync(join(root, 'dist/server'), { recursive: true });
    mkdirSync(join(root, 'dist/client'), { recursive: true });
    mkdirSync(join(root, 'plugins/pico.test'), { recursive: true });
    writeFileSync(join(root, 'dist/server/server.js'), 'server');
    writeFileSync(join(root, 'dist/executor-agent.mjs'), 'executor');
    writeFileSync(join(root, 'plugins/pico.test.mjs'), 'entry');
    writeFileSync(join(root, 'plugins/pico.test/runtime.mjs'), 'plugin-v1');
    writeFileSync(join(root, 'dist/client/index.html'), 'web-v1');
    const baseline = runtimeArtifactHashes(root);
    writeFileSync(join(root, 'dist/client/index.html'), 'web-v2');
    expect(runtimeArtifactHashes(root)).toEqual(baseline);
    writeFileSync(join(root, 'plugins/pico.test/runtime.mjs'), 'plugin-v2');
    expect(runtimeArtifactHashes(root)).not.toEqual(baseline);
    symlinkSync('/tmp', join(root, 'dist/server/unsafe'));
    expect(() => runtimeArtifactHashes(root)).toThrow(/symbolic link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
