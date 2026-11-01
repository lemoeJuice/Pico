import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PicoStore } from '../src/core/store.js';
import type { ExecutorBinding } from '../src/core/types.js';
import { HostExecutor } from '../src/executor/host-executor.js';

const token = 'host-executor-heartbeat-test-token-is-at-least-32-bytes';
const originalDatabasePath = process.env.PICO_DB_PATH;
const identity = (leaseId: string) => ({ runtimeId: 'runtime-a', source: 'thread' as const, leaseId });

function infoResponse(): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: 2,
      kind: 'executor',
      name: 'local host executor',
      workspaceRoot: '/',
      workspaceOptional: true,
      tools: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function leaseResponse(status = 200): Response {
  return new Response(
    JSON.stringify(status === 200 ? { ok: true, leaseToken: 'lease-token' } : { error: 'not found' }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function setup(): { store: PicoStore; binding: ExecutorBinding; executor: HostExecutor } {
  const store = new PicoStore(':memory:');
  store.setSetting('executor-host-connection', { port: 43210, accessToken: token });
  const thread = store.createThread(null, 'host');
  const binding = store.executorForThread(thread.id)!;
  return { store, binding, executor: new HostExecutor(store) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalDatabasePath === undefined) delete process.env.PICO_DB_PATH;
  else process.env.PICO_DB_PATH = originalDatabasePath;
});

describe('Host Executor heartbeat lifecycle', () => {
  it('keeps the idle opt-in marker visible while an older Host agent handles update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-host-update-marker-'));
    process.env.PICO_DB_PATH = join(directory, 'runtime.sqlite');
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const executor = new HostExecutor(store);
    const markerPath = join(directory, 'executor-host.mjs.idle-enabled');
    const update = vi.spyOn(
      (executor as unknown as { client: { update: HostExecutor['update'] } }).client,
      'update',
    ).mockImplementation(async () => {
      // The old agent updates itself and restarts using its original environment;
      // the newly installed agent must see this marker on startup.
      expect(existsSync(markerPath)).toBe(true);
      return { executorVersion: '0.2.3' };
    });
    try {
      await expect(executor.update(binding, new Uint8Array([1]), '0.2.3')).resolves.toEqual({
        executorVersion: '0.2.3',
      });
      expect(update).toHaveBeenCalledOnce();
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      await executor.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes only an idle marker it created when update fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-host-update-marker-'));
    process.env.PICO_DB_PATH = join(directory, 'runtime.sqlite');
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const executor = new HostExecutor(store);
    const markerPath = join(directory, 'executor-host.mjs.idle-enabled');
    const update = vi.spyOn(
      (executor as unknown as { client: { update: HostExecutor['update'] } }).client,
      'update',
    ).mockRejectedValue(new Error('update failed'));
    try {
      await expect(executor.update(binding, new Uint8Array([1]), '0.2.3')).rejects.toThrow('update failed');
      expect(update).toHaveBeenCalledOnce();
      expect(existsSync(markerPath)).toBe(false);

      await writeFile(markerPath, '', { mode: 0o600 });
      await expect(executor.update(binding, new Uint8Array([1]), '0.2.3')).rejects.toThrow('update failed');
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      await executor.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a newly created idle marker when the update outcome is unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-host-update-marker-'));
    process.env.PICO_DB_PATH = join(directory, 'runtime.sqlite');
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const executor = new HostExecutor(store);
    const markerPath = join(directory, 'executor-host.mjs.idle-enabled');
    const update = vi.spyOn(
      (executor as unknown as { client: { update: HostExecutor['update'] } }).client,
      'update',
    ).mockRejectedValue(
      new Error('Remote Executor update outcome is unknown; the update bundle was not resubmitted.'),
    );
    try {
      await expect(executor.update(binding, new Uint8Array([1]), '0.2.3')).rejects.toThrow(
        'update outcome is unknown',
      );
      expect(update).toHaveBeenCalledOnce();
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      await executor.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start or contact an agent when asked to release a lease it never acquired', async () => {
    const { store, binding, executor } = setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('agent must not be started'));
    try {
      await expect(executor.release(binding, identity('unknown-lease'))).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await executor.shutdown();
      fetchMock.mockRestore();
      store.close();
    }
  });

  it('renews active leases and releases only this Runtime’s leases on shutdown without killing the shared agent', async () => {
    vi.useFakeTimers();
    const { store, binding, executor } = setup();
    const leaseRequests: Array<{ action: string; body: unknown }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/info') return infoResponse();
      if (url.pathname.startsWith('/api/leases/')) {
        leaseRequests.push({ action: url.pathname.split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
        return leaseResponse();
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const kill = vi.fn();
    (executor as unknown as { process: { pid: number; exitCode: null; signalCode: null; kill: typeof kill } }).process =
      {
        pid: 123,
        exitCode: null,
        signalCode: null,
        kill,
      };

    try {
      await executor.heartbeat(binding, identity('thread-1'));
      await executor.heartbeat(binding, identity('thread-2'));
      expect(leaseRequests).toEqual([
        { action: 'heartbeat', body: identity('thread-1') },
        { action: 'heartbeat', body: identity('thread-2') },
      ]);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(leaseRequests.slice(2)).toEqual([
        { action: 'heartbeat', body: identity('thread-1') },
        { action: 'heartbeat', body: identity('thread-2') },
      ]);

      await executor.release(binding, identity('thread-1'));
      await executor.shutdown();
      expect(leaseRequests.slice(-2)).toEqual([
        { action: 'release', body: { ...identity('thread-1'), leaseToken: 'lease-token' } },
        { action: 'release', body: { ...identity('thread-2'), leaseToken: 'lease-token' } },
      ]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await executor.shutdown();
      fetchMock.mockRestore();
      store.close();
    }
  });

  it('reports that an older Host agent cannot provide safe idle shutdown', async () => {
    const { store, binding, executor } = setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/info') return infoResponse();
      if (url.pathname === '/api/leases/heartbeat') return leaseResponse(404);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      await expect(executor.heartbeat(binding, identity('thread-1'))).rejects.toThrow(
        'does not support lease heartbeats',
      );
      await executor.shutdown();
    } finally {
      fetchMock.mockRestore();
      store.close();
    }
  });

  it('renews other leases even when one active lease heartbeat fails', async () => {
    vi.useFakeTimers();
    const { store, binding, executor } = setup();
    const heartbeatBodies: Array<{ runtimeId: string; source: string; leaseId: string }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/info') return infoResponse();
      if (url.pathname === '/api/leases/heartbeat') {
        const body = JSON.parse(String(init?.body)) as { runtimeId: string; source: string; leaseId: string };
        heartbeatBodies.push(body);
        if (body.leaseId === 'lease-one' && heartbeatBodies.filter((item) => item.leaseId === 'lease-one').length > 1) {
          return leaseResponse(500);
        }
        return leaseResponse();
      }
      if (url.pathname === '/api/leases/release') return leaseResponse();
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await executor.heartbeat(binding, identity('lease-one'));
      await executor.heartbeat(binding, identity('lease-two'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(heartbeatBodies.slice(2).map((item) => item.leaseId)).toEqual(['lease-one', 'lease-two', 'lease-one']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('lease-one'));
    } finally {
      await executor.shutdown();
      fetchMock.mockRestore();
      log.mockRestore();
      store.close();
    }
  });

  it('stops renewing a lease before attempting a release that fails', async () => {
    vi.useFakeTimers();
    const { store, binding, executor } = setup();
    let rejectRelease = false;
    let heartbeats = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/api/info') return infoResponse();
      if (url.pathname === '/api/leases/heartbeat') {
        heartbeats += 1;
        return leaseResponse();
      }
      if (url.pathname === '/api/leases/release') {
        if (rejectRelease) throw new TypeError('connection lost');
        return leaseResponse();
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    try {
      await executor.heartbeat(binding, identity('thread-1'));
      rejectRelease = true;
      await expect(executor.release(binding, identity('thread-1'))).rejects.toThrow('connection lost');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(heartbeats).toBe(1);
    } finally {
      await executor.shutdown();
      fetchMock.mockRestore();
      store.close();
    }
  });
});
