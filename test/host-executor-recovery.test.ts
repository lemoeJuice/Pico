import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { HostExecutor } from '../src/executor/host-executor.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const accessToken = 'host-recovery-test-token-with-at-least-32-bytes';
const originalDatabasePath = process.env.PICO_DB_PATH;

function infoResponse(protocolVersion = 2): Response {
  return new Response(
    JSON.stringify({
      protocolVersion,
      kind: 'executor',
      name: 'local host agent',
      workspaceRoot: '/',
      workspaceOptional: true,
      tools: [],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: `agent returned ${status}` }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function connectionFailure(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  return new TypeError('fetch failed', { cause });
}

function fakeChild(exitCode: number | null = null): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 12345;
  child.exitCode = exitCode;
  child.signalCode = null;
  child.kill = vi.fn();
  return child as unknown as ChildProcess;
}

async function fixture(recovery?: (endpointUrl: string, signal: AbortSignal) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pico-host-recovery-'));
  process.env.PICO_DB_PATH = join(directory, 'runtime.sqlite');
  const store = new PicoStore(':memory:');
  store.setSetting('executor-host-connection', { port: 43211, accessToken });
  const thread = store.createThread(null, 'host');
  const binding = store.executorForThread(thread.id)!;
  const pluginDirectory = join(directory, 'plugins');
  const executor = new HostExecutor(store, undefined, pluginDirectory, recovery);
  const agentPath = join(directory, 'executor-host.mjs');
  return { directory, store, binding, executor, agentPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  if (originalDatabasePath === undefined) delete process.env.PICO_DB_PATH;
  else process.env.PICO_DB_PATH = originalDatabasePath;
});

describe('Host Executor transport recovery', () => {
  it.each([401, 503])('fails closed on HTTP %s without creating a second Host agent', async (status) => {
    const recovery = vi.fn(async () => undefined);
    const env = await fixture(recovery);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(status));
    try {
      await expect(env.executor.listTools(env.binding)).rejects.toThrow(`agent returned ${status}`);
      expect(recovery).not.toHaveBeenCalled();
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      expect(existsSync(env.agentPath)).toBe(false);
    } finally {
      await env.executor.shutdown();
      fetchMock.mockRestore();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });

  it('fails closed when an occupied local port serves an incompatible Executor protocol', async () => {
    const env = await fixture();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(infoResponse(1));
    const portCheck = vi
      .spyOn(
        env.executor as unknown as { agentPortIsAvailable(port: number): Promise<boolean> },
        'agentPortIsAvailable',
      )
      .mockResolvedValue(false);
    try {
      await expect(env.executor.checkConnection(env.binding)).rejects.toThrow(/protocol version 1 is incompatible/);
      expect(portCheck).not.toHaveBeenCalled();
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      expect(existsSync(env.agentPath)).toBe(false);
    } finally {
      await env.executor.shutdown();
      fetchMock.mockRestore();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });

  it('reconnects to a live local agent and invokes the shared recovery hook without spawning', async () => {
    const recovery = vi.fn(async () => undefined);
    const env = await fixture(recovery);
    const child = fakeChild();
    (env.executor as unknown as { process: ChildProcess | null }).process = child;
    let infoCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      infoCalls += 1;
      if (infoCalls === 2) throw connectionFailure();
      return infoResponse();
    });
    try {
      await expect(env.executor.checkConnection(env.binding)).resolves.toMatchObject({ kind: 'executor' });
      expect(infoCalls).toBe(4);
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(existsSync(env.agentPath)).toBe(false);
    } finally {
      await env.executor.shutdown();
      fetchMock.mockRestore();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });

  it('does not spawn over an unresponsive process that is still alive', async () => {
    vi.useFakeTimers();
    const env = await fixture();
    const child = fakeChild();
    (env.executor as unknown as { process: ChildProcess | null }).process = child;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(connectionFailure());
    try {
      const request = env.executor.checkConnection(env.binding);
      const rejectedRequest = expect(request).rejects.toThrow(/will not start a duplicate Host process/);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(31_000);
      await rejectedRequest;
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(existsSync(env.agentPath)).toBe(false);
    } finally {
      await env.executor.shutdown();
      fetchMock.mockRestore();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('coalesces a restart after the previous agent process has exited', async () => {
    const env = await fixture();
    await writeFile(env.agentPath, 'preinstalled executor', { mode: 0o700 });
    await writeFile(`${env.agentPath}.version`, 'test-version', { mode: 0o600 });
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    (env.executor as unknown as { process: ChildProcess | null }).process = fakeChild(0);
    const portCheck = vi
      .spyOn(
        env.executor as unknown as { agentPortIsAvailable(port: number): Promise<boolean> },
        'agentPortIsAvailable',
      )
      .mockResolvedValue(true);
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw connectionFailure();
      return infoResponse();
    });
    try {
      const result = await Promise.all([
        env.executor.checkConnection(env.binding),
        env.executor.checkConnection(env.binding),
      ]);
      expect(result).toHaveLength(2);
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
      expect(portCheck).toHaveBeenCalledTimes(1);
      const spawnOptions = vi.mocked(spawn).mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
      expect(spawnOptions.env.PICO_EXECUTOR_IDLE_TIMEOUT_MS).toBe('60000');
    } finally {
      await env.executor.shutdown();
      fetchMock.mockRestore();
      env.store.close();
      await rm(env.directory, { recursive: true, force: true });
    }
  });
});
