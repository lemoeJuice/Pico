import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startRemoteExecutorServer } from '../src/executor/remote-server.js';
import { currentExecutorVersion } from '../src/executor/bundle.js';
import { startServer } from '../src/server.js';

const keys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const previous = new Map(keys.map((key) => [key, process.env[key]]));
const remoteToken = 'pico-test-workspace-download-token-0123456789';

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('downloads remote Thread files through its bound Executor and preserves local executor behavior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-workspace-file-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let remote: Awaited<ReturnType<typeof startRemoteExecutorServer>> | undefined;
  let oldExecutor: Server | undefined;
  try {
    const workspace = join(dir, 'workspace');
    const remoteRoot = join(dir, 'remote-workspaces');
    const remoteWorkspace = join(remoteRoot, 'project');
    await mkdir(join(workspace, 'prototype'), { recursive: true });
    await mkdir(join(remoteWorkspace, 'prototype'), { recursive: true });
    const remoteBytes = Buffer.from([0, 255, 1, 128, 13, 10, 42]);
    await writeFile(join(workspace, 'prototype', 'artifact.bin'), Buffer.from('local copy'));
    await writeFile(join(workspace, 'prototype', 'window-composite.mjs'), 'export const source = "local";\n');
    await writeFile(join(remoteWorkspace, 'prototype', 'artifact.bin'), remoteBytes);
    await writeFile(join(remoteWorkspace, 'prototype', 'window-composite.mjs'), 'export const source = "remote";\n');

    remote = await startRemoteExecutorServer({
      token: remoteToken,
      workspaceRoot: remoteRoot,
      databasePath: join(dir, 'executor.sqlite'),
      port: 0,
    });

    process.env.PICO_HOST = '127.0.0.1';
    process.env.PICO_PORT = '0';
    process.env.PICO_DB_PATH = join(dir, 'pico.sqlite');
    process.env.PICO_ACCESS_TOKEN = 'a'.repeat(32);
    server = await startServer();
    const project = await server.runtime.createProject('test', workspace);
    const local = server.runtime.createThread(project.id, 'host');
    const chat = server.runtime.createThread(project.id, 'runtime');
    const connection = server.runtime.store.createRemoteExecutorConnection(
      'remote',
      `http://127.0.0.1:${remote.port}`,
      remoteToken,
      remoteRoot,
    );
    const remoteThread = await server.runtime.createRemoteThread(project.id, connection.id, remoteWorkspace);

    const base = `http://127.0.0.1:${server.port}`;
    const url = (id: string, path: string) =>
      `${base}/api/threads/${id}/workspace-file?${new URLSearchParams({ path })}`;
    expect((await fetch(url(remoteThread.id, 'prototype/artifact.bin'))).status).toBe(401);
    const login = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(32) }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (id: string, path: string) => fetch(url(id, path), { headers: { cookie } });

    const downloaded = await get(remoteThread.id, 'prototype/window-composite.mjs');
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('export const source = "remote";\n');
    expect(downloaded.headers.get('content-type')).toContain('application/octet-stream');
    expect(downloaded.headers.get('content-disposition')).toMatch(/^attachment;.*window-composite\.mjs/);
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
    const binary = await get(remoteThread.id, 'prototype/artifact.bin');
    expect(binary.status).toBe(200);
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(remoteBytes);
    expect(await (await get(local.id, 'prototype/window-composite.mjs')).text()).toBe(
      'export const source = "local";\n',
    );

    expect((await get(remoteThread.id, '../secret.txt')).status).toBe(400);
    expect((await get(remoteThread.id, 'prototype/missing.bin')).status).toBe(404);
    expect((await get(remoteThread.id, 'prototype')).status).toBe(404);
    expect((await get('missing', 'prototype/artifact.bin')).status).toBe(404);
    expect((await get(chat.id, 'prototype/artifact.bin')).status).toBe(409);

    // An otherwise valid Executor without the download capability must fail with an explicit update hint.
    oldExecutor = createServer((request, response) => {
      if (request.url === '/api/info') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            protocolVersion: 2,
            executorVersion: '0.2.0',
            kind: 'executor',
            name: 'Old Executor',
            workspaceRoot: remoteRoot,
            tools: [],
          }),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      oldExecutor!.once('error', reject);
      oldExecutor!.listen(0, '127.0.0.1', resolve);
    });
    const oldAddress = oldExecutor.address();
    if (!oldAddress || typeof oldAddress === 'string') throw new Error('Old Executor did not bind a TCP port');
    const oldConnection = server.runtime.store.createRemoteExecutorConnection(
      'old executor',
      `http://127.0.0.1:${oldAddress.port}`,
      remoteToken,
      remoteRoot,
    );
    const oldThread = server.runtime.store.createThread(project.id, 'host', 'old executor', {
      remoteConnectionId: oldConnection.id,
      workspacePath: remoteWorkspace,
    });
    const oldResponse = await get(oldThread.id, 'prototype/artifact.bin');
    expect(oldResponse.status).toBe(409);
    expect(await oldResponse.json()).toMatchObject({
      error: expect.stringMatching(/does not support file downloads/i),
    });
    expect(await server.runtime.executorStatus(oldThread.id)).toMatchObject({
      executorVersion: '0.2.0',
      targetVersion: currentExecutorVersion(),
      updateAvailable: true,
    });

    // A connection that is unavailable when the request arrives is reported as a gateway failure.
    const unavailable = server.runtime.store.createRemoteExecutorConnection(
      'unavailable',
      'http://127.0.0.1:1',
      remoteToken,
      remoteRoot,
    );
    const unavailableThread = server.runtime.store.createThread(project.id, 'host', 'unavailable executor', {
      remoteConnectionId: unavailable.id,
      workspacePath: remoteWorkspace,
    });
    expect((await get(unavailableThread.id, 'prototype/artifact.bin')).status).toBe(502);
  } finally {
    await new Promise<void>((resolve) => oldExecutor?.close(() => resolve()) ?? resolve());
    await server?.close();
    await remote?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('closes the upstream Executor response when the browser cancels a download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-workspace-abort-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let executor: Server | undefined;
  let heldResponse: ServerResponse | undefined;
  const abort = new AbortController();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const closedEarly = new Promise<boolean>((resolve) => {
      executor = createServer((request, response) => {
        if (request.url === '/api/info') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              protocolVersion: 2,
              kind: 'executor',
              name: 'Streaming Executor',
              workspaceRoot: workspace,
              workspaceFileDownload: true,
              tools: [],
            }),
          );
          return;
        }
        if (request.url === '/api/workspaces/download') {
          heldResponse = response;
          response.on('close', () => resolve(!response.writableEnded));
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="large.bin"',
          });
          response.flushHeaders();
          response.write(Buffer.from([0, 1, 2, 3]));
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      executor!.once('error', reject);
      executor!.listen(0, '127.0.0.1', resolve);
    });
    const executorAddress = executor!.address();
    if (!executorAddress || typeof executorAddress === 'string') throw new Error('Executor did not bind a TCP port');

    process.env.PICO_HOST = '127.0.0.1';
    process.env.PICO_PORT = '0';
    process.env.PICO_DB_PATH = join(dir, 'pico.sqlite');
    process.env.PICO_ACCESS_TOKEN = 'b'.repeat(32);
    server = await startServer();
    const project = await server.runtime.createProject('abort test', workspace);
    const connection = server.runtime.store.createRemoteExecutorConnection(
      'streaming executor',
      `http://127.0.0.1:${executorAddress.port}`,
      remoteToken,
      workspace,
    );
    const thread = server.runtime.store.createThread(project.id, 'host', 'streaming thread', {
      remoteConnectionId: connection.id,
      workspacePath: workspace,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'b'.repeat(32) }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const response = await fetch(
      `${base}/api/threads/${thread.id}/workspace-file?${new URLSearchParams({ path: 'large.bin' })}`,
      { headers: { cookie }, signal: abort.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 1, 2, 3]));
    abort.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wasClosedEarly = await Promise.race([
      closedEarly,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    expect(wasClosedEarly).toBe(true);
  } finally {
    abort.abort();
    heldResponse?.destroy();
    if (executor) {
      executor.closeAllConnections();
      await new Promise<void>((resolve) => executor!.close(() => resolve()));
    }
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
