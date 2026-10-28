import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_PLUGIN_DIR', 'PICO_ENV'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

async function put(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content);
}

function requestRawPath(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.once('error', reject);
    request.end();
  });
}

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('serves versioned main and registered plugin assets from isolated production paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pico-deploy-server-'));
  const originalCwd = process.cwd();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await mkdir(join(directory, 'plugins'), { recursive: true });
    await put(
      directory,
      'plugins/pico.integration.mjs',
      `export default {
        id: 'pico.integration', name: 'Integration fixture', version: '1.0.0',
        activate(context) { context.ui.registerPage({ id: 'webui', label: 'Integration', entry: 'webui' }); },
      };`,
    );
    await put(
      directory,
      'plugins/pico.sibling.mjs',
      `export default {
        id: 'pico.sibling', name: 'Sibling fixture', version: '1.0.0',
        activate(context) { context.ui.registerPage({ id: 'webui', label: 'Sibling', entry: 'webui' }); },
      };`,
    );

    await put(
      directory,
      'dist/client/index.html',
      '<!doctype html><script src="/releases/web-current/assets/main.js"></script>',
    );
    await put(directory, 'dist/client/releases/web-current/assets/main.js', 'main-current');
    await put(directory, 'dist/client/releases/web-old/assets/old.js', 'main-old-page-resource');

    await put(
      directory,
      'dist/plugin-ui/pico.integration/webui/index.html',
      '<!doctype html><script src="/_pico/plugin-ui/pico.integration/webui/releases/plugin-current/app.js"></script>',
    );
    await put(
      directory,
      'dist/plugin-ui/pico.integration/webui/releases/plugin-current/index.html',
      '<!doctype html><script src="./app.js"></script>',
    );
    await put(directory, 'dist/plugin-ui/pico.integration/webui/releases/plugin-current/app.js', 'plugin-current');
    await put(
      directory,
      'dist/plugin-ui/pico.integration/webui/releases/plugin-old/old.js',
      'plugin-old-page-resource',
    );
    await put(
      directory,
      'dist/plugin-ui/pico.sibling/webui/releases/sibling-current/secret.js',
      'sibling-private-asset',
    );

    process.chdir(directory);
    process.env.PICO_HOST = '127.0.0.1';
    process.env.PICO_PORT = '0';
    process.env.PICO_DB_PATH = join(directory, 'runtime.sqlite');
    process.env.PICO_PLUGIN_DIR = join(directory, 'plugins');
    process.env.PICO_ENV = 'production';
    server = await startServer();

    const base = `http://127.0.0.1:${server.port}`;
    const mainPage = await fetch(`${base}/`);
    expect(mainPage.status).toBe(200);
    expect(await mainPage.text()).toContain('/releases/web-current/assets/main.js');
    expect(await fetch(`${base}/releases/web-current/assets/main.js`).then((response) => response.text())).toBe(
      'main-current',
    );
    expect(await fetch(`${base}/releases/web-old/assets/old.js`).then((response) => response.text())).toBe(
      'main-old-page-resource',
    );
    expect((await fetch(`${base}/releases/web-current/assets/missing.js`)).status).toBe(404);

    const pluginPage = await fetch(`${base}/_pico/plugin-ui/pico.integration/webui/index.html`);
    expect(pluginPage.status).toBe(200);
    expect(await pluginPage.text()).toContain('releases/plugin-current/app.js');
    expect(
      await fetch(`${base}/_pico/plugin-ui/pico.integration/webui/releases/plugin-current/app.js`).then((response) =>
        response.text(),
      ),
    ).toBe('plugin-current');
    expect(
      await fetch(`${base}/_pico/plugin-ui/pico.integration/webui/releases/plugin-old/old.js`).then((response) =>
        response.text(),
      ),
    ).toBe('plugin-old-page-resource');
    expect(
      (await fetch(`${base}/_pico/plugin-ui/pico.integration/webui/releases/plugin-current/missing.js`)).status,
    ).toBe(404);
    expect((await fetch(`${base}/_pico/plugin-ui/pico.unknown/webui/releases/sibling-current/secret.js`)).status).toBe(
      404,
    );
    const traversal = await requestRawPath(
      server.port,
      '/_pico/plugin-ui/pico.integration/webui/releases/plugin-current/%2f..%2f..%2fpico.sibling%2fwebui%2freleases%2fsibling-current%2fsecret.js',
    );
    expect(traversal.status).toBe(404);
    expect(traversal.body).not.toContain('sibling-private-asset');
  } finally {
    await server?.close();
    process.chdir(originalCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
