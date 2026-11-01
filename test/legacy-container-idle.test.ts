import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_CONTAINER_IDLE_ENABLE_MARKER,
  LEGACY_CONTAINER_IDLE_MARKER,
  LEGACY_CONTAINER_AGENT_PATH,
  prepareLegacyContainerIdleMarkers,
  startRemoteExecutorServer,
  writeLegacyContainerIdleMarker,
} from '../src/executor/remote-server.js';

const token = 'legacy-idle-test-token-that-is-long-enough';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('legacy Container health-check idle lifecycle', () => {
  it('clears a stale idle marker only for the explicitly opted-in Container agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-legacy-idle-'));
    try {
      const enable = join(directory, LEGACY_CONTAINER_IDLE_ENABLE_MARKER);
      const idle = join(directory, LEGACY_CONTAINER_IDLE_MARKER);
      await writeFile(enable, '', { mode: 0o600 });
      await writeFile(idle, '', { mode: 0o600 });

      await expect(prepareLegacyContainerIdleMarkers('/usr/local/bin/executor-host.mjs', directory)).resolves.toBe(
        false,
      );
      await expect(lstat(idle)).resolves.toBeDefined();
      await expect(prepareLegacyContainerIdleMarkers('/opt/pico/remote-agent.mjs', directory)).resolves.toBe(false);
      await expect(prepareLegacyContainerIdleMarkers(LEGACY_CONTAINER_AGENT_PATH, directory)).resolves.toBe(true);
      await expect(lstat(idle)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not opt in without the marker or when the marker is not a regular file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-legacy-idle-'));
    try {
      const idle = join(directory, LEGACY_CONTAINER_IDLE_MARKER);
      await writeFile(idle, 'stale');
      await expect(prepareLegacyContainerIdleMarkers(LEGACY_CONTAINER_AGENT_PATH, directory)).resolves.toBe(false);
      await expect(readFile(idle, 'utf8')).resolves.toBe('stale');

      await mkdir(join(directory, LEGACY_CONTAINER_IDLE_ENABLE_MARKER));
      await expect(prepareLegacyContainerIdleMarkers(LEGACY_CONTAINER_AGENT_PATH, directory)).rejects.toThrow(
        /regular file/,
      );
      await expect(readFile(idle, 'utf8')).resolves.toBe('stale');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes the idle marker atomically without leftover temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-legacy-idle-'));
    try {
      await writeLegacyContainerIdleMarker(directory);
      await expect(readFile(join(directory, LEGACY_CONTAINER_IDLE_MARKER), 'utf8')).resolves.toBe('');
      await expect(readdir(directory)).resolves.toEqual([LEGACY_CONTAINER_IDLE_MARKER]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks an empty lease set as draining, rejects renewal and leaves shutdown to the health supervisor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-legacy-idle-'));
    const workspaceRoot = join(directory, 'workspace');
    await mkdir(workspaceRoot);
    const onIdle = vi.fn(() => writeLegacyContainerIdleMarker(directory));
    const server = await startRemoteExecutorServer({
      host: '127.0.0.1',
      port: 0,
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      idle: { timeoutMs: 30, onIdle },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    try {
      await wait(60);
      expect(onIdle).toHaveBeenCalledTimes(1);
      await expect(readFile(join(directory, LEGACY_CONTAINER_IDLE_MARKER), 'utf8')).resolves.toBe('');

      const infoResponse = await fetch(`${base}/api/info`, { headers });
      expect(infoResponse.status).toBe(200);
      await expect(infoResponse.json()).resolves.toMatchObject({ leaseHeartbeat: true, draining: true });

      const heartbeat = await fetch(`${base}/api/leases/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runtimeId: 'late-runtime', source: 'runtime', leaseId: 'late-runtime' }),
      });
      expect(heartbeat.status).toBe(503);
      await expect(heartbeat.json()).resolves.toMatchObject({ code: 'executor_draining', retryable: true });
      await expect(readFile(join(directory, LEGACY_CONTAINER_IDLE_MARKER), 'utf8')).resolves.toBe('');

      const stillServingInfo = await fetch(`${base}/api/info`, { headers });
      expect(stillServingInfo.status).toBe(200);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
