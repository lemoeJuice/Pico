import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webBuildOutputDirectory } from '../vite.config.js';

describe('WebUI build output isolation', () => {
  it('uses the deployment output in an isolated source snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-vite-output-'));
    try {
      expect(webBuildOutputDirectory(root)).toBe('dist/client');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['.pico-deploy-state.json', 'dist/client/releases', 'dist/plugin-ui'])(
    'keeps builds away from the live WebUI when %s exists',
    async (marker) => {
      const root = await mkdtemp(join(tmpdir(), 'pico-vite-output-'));
      try {
        if (marker.endsWith('.json')) await writeFile(join(root, marker), '{}');
        else await mkdir(join(root, marker), { recursive: true });
        expect(webBuildOutputDirectory(root)).toBe('dist/client-build');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
