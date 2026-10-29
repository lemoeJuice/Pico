import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorBinding } from '../src/core/types.js';
import { startServer } from '../src/server.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Container Executor restart API', () => {
  it('allows only Container Threads, returns status, and reports missing Threads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-container-restart-api-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();

      const project = await server.runtime.createProject('Restart API', directory);
      const hostThread = server.runtime.createThread(project.id, 'host');
      const runtimeThread = server.runtime.createThread(project.id, 'runtime');
      const containerThread = server.runtime.createThread(project.id, 'container');
      const status = {
        requiresExecutor: true,
        connected: true,
        compatible: true,
        kind: 'container',
        label: 'Container Executor',
        executorVersion: '0.2.0',
        targetVersion: '0.2.0',
        updateAvailable: false,
        updateSupported: false,
      };
      const runtimeInternals = server.runtime as unknown as {
        containerExecutor: { restart(binding: ExecutorBinding): Promise<void> };
      };
      const restart = vi.spyOn(runtimeInternals.containerExecutor, 'restart').mockResolvedValue();
      vi.spyOn(server.runtime, 'executorStatus').mockResolvedValue(status);
      const endpoint = (threadId: string): string =>
        `http://127.0.0.1:${server!.port}/api/threads/${threadId}/executor/restart`;
      const post = (threadId: string): Promise<Response> => fetch(endpoint(threadId), { method: 'POST' });

      const missing = await post('missing-thread');
      expect(missing.status).toBe(404);
      expect((await missing.json()).code).toBe('not_found');

      for (const thread of [hostThread, runtimeThread]) {
        const response = await post(thread.id);
        expect(response.status).toBe(400);
        expect((await response.json()).code).toBe('invalid_request');
      }
      expect(restart).not.toHaveBeenCalled();

      const response = await post(containerThread.id);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(status);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledWith(expect.objectContaining({ kind: 'container' }));
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
