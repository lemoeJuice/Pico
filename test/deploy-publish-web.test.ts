import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Deployment scripts are JavaScript and have no declaration files.
import { prepareWebPublication } from '../scripts/deploy/publish-web.mjs';

const roots: string[] = [];
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pico-web-publish-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('prepares versioned main and plugin assets, commits entrypoints, and rolls them back', async () => {
  const source = await makeRoot();
  const target = await makeRoot();
  await mkdir(join(source, 'dist/client/assets'), { recursive: true });
  await writeFile(
    join(source, 'dist/client/index.html'),
    '<script type="module" src="/assets/app.js"></script><link href="/pico-plugin-ui.css" rel="stylesheet">',
  );
  await writeFile(join(source, 'dist/client/assets/app.js'), 'new main');
  await writeFile(join(source, 'dist/client/pico-plugin-ui.css'), 'css');
  await writeFile(join(source, 'dist/client/pico-plugin-ui-bridge.js'), 'bridge');
  await mkdir(join(source, 'plugins/example.webui/webui'), { recursive: true });
  await writeFile(
    join(source, 'plugins/example.webui/webui/index.html'),
    '<script src="/pico-plugin-ui-bridge.js"></script><script src="./app.js"></script>',
  );
  await writeFile(join(source, 'plugins/example.webui/webui/app.js'), 'plugin');
  await writeFile(join(source, 'plugins/example.webui/webui/theme-assets.json'), '{"assets":["themes/forest.webp"]}');
  await mkdir(join(source, 'plugins/example.webui/webui/themes'), { recursive: true });
  await writeFile(join(source, 'plugins/example.webui/webui/themes/forest.webp'), 'forest image');
  await mkdir(join(target, 'dist/client'), { recursive: true });
  await writeFile(join(target, 'dist/client/index.html'), 'old main');
  const transaction = await prepareWebPublication({
    sourceRoot: source,
    targetRoot: target,
    releaseId: 'r-20261028',
    scope: { mainWeb: true, pluginIds: ['example.webui'] },
  });
  expect(transaction.urls).toContain('/releases/r-20261028/assets/app.js');
  expect(transaction.urls).toContain('/releases/r-20261028/pico-plugin-ui-bridge.js');
  expect(transaction.urls).toContain('/releases/r-20261028/pico-plugin-ui.css');
  expect(transaction.urls).toContain('/_pico/plugin-ui/example.webui/webui/releases/r-20261028/app.js');
  expect(transaction.urls).toContain('/_pico/plugin-ui/example.webui/webui/releases/r-20261028/themes/forest.webp');
  expect(transaction.urls).toContain('/_pico/plugin-ui/example.webui/webui/releases/r-20261028/theme-assets.json');
  expect(transaction.hashes['/_pico/plugin-ui/example.webui/webui/releases/r-20261028/index.html']).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(
    transaction.assets.find((asset: { url: string }) => asset.url === '/releases/r-20261028/pico-plugin-ui-bridge.js'),
  ).toMatchObject({ contentType: 'text/javascript', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(
    transaction.assets.find((asset: { url: string }) => asset.url === '/releases/r-20261028/pico-plugin-ui.css'),
  ).toMatchObject({ contentType: 'text/css', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(
    transaction.assets.find(
      (asset: { url: string }) =>
        asset.url === '/_pico/plugin-ui/example.webui/webui/releases/r-20261028/themes/forest.webp',
    ),
  ).toMatchObject({ contentType: 'image/webp', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await readFile(join(target, 'dist/client/index.html'), 'utf8')).toBe('old main');
  await transaction.commit();
  const mainIndex = await readFile(join(target, 'dist/client/index.html'), 'utf8');
  expect(mainIndex).toContain('/releases/r-20261028/assets/app.js');
  const pluginIndex = await readFile(
    join(target, 'dist/plugin-ui/example.webui/webui/releases/r-20261028/index.html'),
    'utf8',
  );
  expect(pluginIndex).toContain('/releases/r-20261028/pico-plugin-ui-bridge.js');
  expect(pluginIndex).toContain('./app.js');
  expect(await readFile(join(target, 'dist/plugin-ui/example.webui/webui/index.html'), 'utf8')).toContain(
    '/_pico/plugin-ui/example.webui/webui/releases/r-20261028/app.js',
  );
  expect(await readFile(join(target, 'dist/plugin-ui/example.webui/webui/index.html'), 'utf8')).toMatch(
    /^<!-- pico-plugin-ui-release:r-20261028 -->/,
  );
  await transaction.rollback();
  expect(await readFile(join(target, 'dist/client/index.html'), 'utf8')).toBe('old main');
  expect(existsSync(join(target, 'dist/plugin-ui/example.webui/webui/index.html'))).toBe(false);
  expect(await readFile(join(target, 'dist/client/releases/r-20261028/assets/app.js'), 'utf8')).toBe('new main');
});

it('keeps each theme asset bound to its published release across successive publications', async () => {
  const source = await makeRoot();
  const target = await makeRoot();
  await mkdir(join(source, 'plugins/example.webui/webui/themes'), { recursive: true });
  await writeFile(join(source, 'plugins/example.webui/webui/index.html'), '<!doctype html><p>Plugin</p>');
  await writeFile(join(source, 'plugins/example.webui/webui/theme-assets.json'), '{"assets":["themes/bg.png"]}');
  await writeFile(join(source, 'plugins/example.webui/webui/themes/bg.png'), 'first image');
  const first = await prepareWebPublication({
    sourceRoot: source,
    targetRoot: target,
    releaseId: 'release-first',
    scope: { mainWeb: false, pluginIds: ['example.webui'] },
  });
  await first.commit();

  await writeFile(join(source, 'plugins/example.webui/webui/themes/bg.png'), 'second image');
  const second = await prepareWebPublication({
    sourceRoot: source,
    targetRoot: target,
    releaseId: 'release-second',
    scope: { mainWeb: false, pluginIds: ['example.webui'] },
  });
  await second.commit();

  const stable = await readFile(join(target, 'dist/plugin-ui/example.webui/webui/index.html'), 'utf8');
  expect(stable).toMatch(/^<!-- pico-plugin-ui-release:release-second -->/);
  expect(
    await readFile(join(target, 'dist/plugin-ui/example.webui/webui/releases/release-first/themes/bg.png'), 'utf8'),
  ).toBe('first image');
  expect(
    await readFile(join(target, 'dist/plugin-ui/example.webui/webui/releases/release-second/themes/bg.png'), 'utf8'),
  ).toBe('second image');
  await second.rollback();
  expect(await readFile(join(target, 'dist/plugin-ui/example.webui/webui/index.html'), 'utf8')).toMatch(
    /^<!-- pico-plugin-ui-release:release-first -->/,
  );
});

it.each([
  ['path traversal', '{"assets":["../secret.png"]}', '[Uu]nsafe'],
  ['missing images', '{"assets":["themes/missing.webp"]}', 'missing'],
  ['non-image files', '{"assets":["themes/theme.css"]}', 'image'],
])('rejects invalid theme asset manifests (%s)', async (_name, manifest, message) => {
  const source = await makeRoot();
  const target = await makeRoot();
  await mkdir(join(source, 'plugins/example.webui/webui/themes'), { recursive: true });
  await writeFile(join(source, 'plugins/example.webui/webui/index.html'), '<!doctype html>');
  await writeFile(join(source, 'plugins/example.webui/webui/theme-assets.json'), manifest);
  if (manifest.includes('theme.css'))
    await writeFile(join(source, 'plugins/example.webui/webui/themes/theme.css'), 'css');
  await expect(
    prepareWebPublication({
      sourceRoot: source,
      targetRoot: target,
      releaseId: 'release-invalid',
      scope: { mainWeb: false, pluginIds: ['example.webui'] },
    }),
  ).rejects.toThrow(new RegExp(message));
});

it('rejects unsafe ids before creating release paths', async () => {
  const source = await makeRoot();
  const target = await makeRoot();
  await expect(
    prepareWebPublication({
      sourceRoot: source,
      targetRoot: target,
      releaseId: '../escape',
      scope: { mainWeb: false, pluginIds: [] },
    }),
  ).rejects.toThrow(/safe path segment/);
});

it('rejects an unversioned absolute plugin resource instead of publishing a mixed release', async () => {
  const source = await makeRoot();
  const target = await makeRoot();
  await mkdir(join(source, 'plugins/example.webui/webui'), { recursive: true });
  await writeFile(join(source, 'plugins/example.webui/webui/index.html'), '<script src="/assets/app.js"></script>');
  await expect(
    prepareWebPublication({
      sourceRoot: source,
      targetRoot: target,
      releaseId: 'r-2',
      sharedReleaseId: 'r-1',
      scope: { mainWeb: false, pluginIds: ['example.webui'] },
    }),
  ).rejects.toThrow(/unversioned local resource/);
});
