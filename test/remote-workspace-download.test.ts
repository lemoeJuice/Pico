import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startRemoteExecutorServer } from '../src/executor/remote-server.js';

const token = 'pico-test-remote-executor-token-0123456789abcdef';

describe('Remote Executor workspace downloads', () => {
  let directory: string | undefined;
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('authenticates, confines downloads, and streams binary files with a safe filename', async () => {
    directory = await mkdtemp(join(tmpdir(), 'pico-remote-download-'));
    const workspaceRoot = join(directory, 'workspaces');
    const workspace = join(workspaceRoot, 'project');
    const outside = join(directory, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    const bytes = Buffer.from([0, 255, 1, 128, 13, 10, 42]);
    await writeFile(join(workspace, 'artifact.bin'), bytes);
    await writeFile(join(outside, 'secret.bin'), 'private');
    await symlink(join(outside, 'secret.bin'), join(workspace, 'outside-link.bin'));

    const server = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    closeServer = () => server.close();
    const baseUrl = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${baseUrl}/api/info`)).status).toBe(401);
    const infoResponse = await fetch(`${baseUrl}/api/info`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(infoResponse.status).toBe(200);
    expect(await infoResponse.json()).toMatchObject({ workspaceFileDownload: true });

    const download = (workspacePath: string, path: string, authorization = token) =>
      fetch(`${baseUrl}/api/workspaces/download`, {
        method: 'POST',
        headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath, path }),
      });

    const response = await download(workspace, 'artifact.bin');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(/filename="?artifact\.bin"?/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    expect((await download(outside, 'secret.bin')).status).toBe(400);
    expect((await download(workspace, '../outside/secret.bin')).status).toBe(400);
    expect((await download(workspace, 'outside-link.bin')).status).toBe(404);
    const unauthorized = await download(workspace, 'artifact.bin', 'wrong-token');
    expect(unauthorized.status).toBe(401);
    expect(await readFile(join(workspace, 'artifact.bin'))).toEqual(bytes);
  });
});
