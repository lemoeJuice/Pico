import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

const keys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const previous = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('serves local Thread files only within the workspace and behind authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-workspace-file-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(join(workspace, 'prototype'), { recursive: true });
    await writeFile(join(workspace, 'prototype', 'window-composite.mjs'), 'export const glass = true;\n');
    await writeFile(join(workspace, 'page.html'), '<script>alert(1)</script>');
    await writeFile(join(workspace, 'image.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(dir, 'secret.txt'), 'outside');
    await symlink(join(dir, 'secret.txt'), join(workspace, 'outside.txt'));
    process.env.PICO_HOST = '127.0.0.1';
    process.env.PICO_PORT = '0';
    process.env.PICO_DB_PATH = join(dir, 'pico.sqlite');
    process.env.PICO_ACCESS_TOKEN = 'a'.repeat(32);
    server = await startServer();
    const project = await server.runtime.createProject('test', workspace);
    const thread = server.runtime.createThread(project.id, 'container');
    const host = server.runtime.createThread(project.id, 'host');
    const chat = server.runtime.createThread(project.id, 'runtime');
    const connection = server.runtime.store.createRemoteExecutorConnection(
      'remote',
      'http://example.test',
      'token',
      '/',
    );
    const remote = server.runtime.store.createThread(project.id, 'host', 'remote', {
      remoteConnectionId: connection.id,
      workspacePath: workspace,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const url = (id: string, path: string) =>
      `${base}/api/threads/${id}/workspace-file?${new URLSearchParams({ path })}`;
    expect((await fetch(url(thread.id, 'prototype/window-composite.mjs'))).status).toBe(401);
    const login = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(32) }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (id: string, path: string) => fetch(url(id, path), { headers: { cookie } });
    const file = await get(thread.id, 'prototype/window-composite.mjs');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment;.*window-composite\.mjs/);
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe('export const glass = true;\n');
    expect(await (await get(host.id, 'prototype/window-composite.mjs')).text()).toBe('export const glass = true;\n');
    const html = await get(thread.id, 'page.html');
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;.*page\.html/);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    const binary = await get(thread.id, 'image.bin');
    expect(binary.headers.get('content-disposition')).toContain('attachment');
    expect(Array.from(new Uint8Array(await binary.arrayBuffer()))).toEqual([0, 1, 2]);
    expect((await get(thread.id, '../secret.txt')).status).toBe(400);
    expect((await get(thread.id, join(dir, 'secret.txt'))).status).toBe(400);
    expect((await get(thread.id, 'outside.txt')).status).toBe(404);
    expect((await get(thread.id, 'missing.txt')).status).toBe(404);
    expect((await get(thread.id, 'prototype')).status).toBe(404);
    expect((await get('missing', 'prototype/window-composite.mjs')).status).toBe(404);
    expect((await get(chat.id, 'prototype/window-composite.mjs')).status).toBe(409);
    expect((await get(remote.id, 'prototype/window-composite.mjs')).status).toBe(409);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
