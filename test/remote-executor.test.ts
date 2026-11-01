import { setToolPolicy } from '../src/plugins/test/helpers.js';
import { permissionPlugin } from '../src/plugins/permissions.js';
import { collaborationPlugin } from '../src/plugins/collaboration.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { startRemoteExecutorServer } from '../src/executor/remote-server.js';
import { RemoteHostExecutor } from '../src/executor/remote-executor.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { assistantPayload, FakeModel, response, setupRuntime, setupTestCatalog } from './helpers.js';

const token = 'pico-test-remote-executor-token-0123456789abcdef';

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  return (await response.json()) as T;
}

async function waitForExecution(baseUrl: string, executionId: string): Promise<{ status: string }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/executions/${encodeURIComponent(executionId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = (await response.json()) as { status: string };
    if (['completed', 'failed', 'interrupted'].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Execution ${executionId} did not settle before timeout.`);
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makePendingRemoteToolExecution(store: PicoStore, id: string): { threadId: string; executionId: string } {
  const project = store.createProject(`Recovery ${id}`, '/workspace');
  const thread = store.createThread(project.id, 'host');
  const modelExecution = store.createModelExecution(`${id}-model`, thread.id, 0);
  store.transitionExecution(modelExecution.id, 'running');
  const call = { id: `${id}-call`, name: 'read_file', arguments: { path: 'note.txt' } };
  store.commitModelStep({
    assistantRecordId: `${id}-assistant`,
    modelExecutionId: modelExecution.id,
    threadId: thread.id,
    payload: assistantPayload({ content: '', batchId: id, toolCalls: [call] }),
    toolCalls: [{ call, executionId: id }],
  });
  return { threadId: thread.id, executionId: id };
}

describe('Remote Host Executor', () => {
  it('recovers an uncertain submission by querying its ID and preserves unknown outcomes without replay', async () => {
    const store = new PicoStore(':memory:');
    const project = store.createProject('Recovery test', '/workspace');
    const thread = store.createThread(project.id, 'host');
    const executionId = 'recovery-unknown-submission';
    const modelExecution = store.createModelExecution('recovery-model', thread.id, 0);
    store.transitionExecution(modelExecution.id, 'running');
    store.commitModelStep({
      assistantRecordId: 'recovery-assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({
        content: '',
        batchId: 'recovery-batch',
        toolCalls: [{ id: 'recovery-call', name: 'read_file', arguments: { path: 'note.txt' } }],
      }),
      toolCalls: [{ call: { id: 'recovery-call', name: 'read_file', arguments: { path: 'note.txt' } }, executionId }],
    });
    const binding = store.executorForThread(thread.id)!;
    let submissions = 0;
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        submissions += 1;
        throw new TypeError('connection reset after submission');
      }
      return new Response(JSON.stringify({ error: 'missing' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.execute(executionId, binding)).rejects.toThrow('outcome is unknown');
      expect(submissions).toBe(1);
      expect(recoveryCalls).toBe(1);
      expect(store.getExecution(executionId)?.status).toBe('pending');
      await expect(executor.execute(executionId, binding)).rejects.toThrow('outcome is unknown');
      expect(submissions).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('keeps polling the same ID when uncertain submission recovery finds it pending', async () => {
    const store = new PicoStore(':memory:');
    const project = store.createProject('Pending recovery test', '/workspace');
    const thread = store.createThread(project.id, 'host');
    const executionId = 'recovery-pending-submission';
    const modelExecution = store.createModelExecution('pending-recovery-model', thread.id, 0);
    store.transitionExecution(modelExecution.id, 'running');
    store.commitModelStep({
      assistantRecordId: 'pending-recovery-assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ content: '', batchId: 'pending-recovery-batch' }),
      toolCalls: [{ call: { id: 'pending-recovery-call', name: 'read_file', arguments: {} }, executionId }],
    });
    const binding = store.executorForThread(thread.id)!;
    let submissions = 0;
    let queries = 0;
    const queryPaths: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        submissions += 1;
        throw new TypeError('submission reply lost');
      }
      queries += 1;
      queryPaths.push(url.pathname);
      const status = queries === 1 ? 'pending' : 'completed';
      return new Response(
        JSON.stringify({ id: executionId, status, result: status === 'completed' ? 'finished' : undefined }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => undefined,
    );
    try {
      await expect(executor.execute(executionId, binding)).resolves.toMatchObject({
        status: 'completed',
        result: 'finished',
      });
      expect(submissions).toBe(1);
      expect(queries).toBe(2);
      expect(queryPaths).toEqual([`/api/executions/${executionId}`, `/api/executions/${executionId}`]);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not run recovery for authentication or protocol responses', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.checkConnection(binding)).rejects.toThrow('unauthorized');
      expect(recoveryCalls).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('recovers one local resolver startup failure and retries resolution only once', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let resolutions = 0;
    let recoveryCalls = 0;
    const info = { protocolVersion: 2, kind: 'executor', name: 'local', workspaceRoot: '/', tools: [] };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => {
        resolutions += 1;
        if (resolutions === 1) {
          throw Object.assign(new Error('local startup connection timed out'), { transientConnectionFailure: true });
        }
        return { endpointUrl: 'http://executor.test', accessToken: token };
      },
      async (endpoint, _signal, recoveredBinding) => {
        recoveryCalls += 1;
        expect(endpoint).toBe(`local://host/${encodeURIComponent(binding.id)}`);
        expect(recoveredBinding?.id).toBe(binding.id);
      },
    );
    try {
      await expect(executor.checkConnection(binding)).resolves.toMatchObject({ kind: 'executor' });
      expect(resolutions).toBe(2);
      expect(recoveryCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('shares resolver recovery by a caller-supplied physical Executor key', async () => {
    const store = new PicoStore(':memory:');
    const project = store.createProject('Shared container recovery', '/workspace');
    const firstThread = store.createThread(project.id, 'container');
    const secondThread = store.createThread(project.id, 'container');
    const firstBinding = store.executorForThread(firstThread.id)!;
    const secondBinding = store.executorForThread(secondThread.id)!;
    expect(firstBinding.id).not.toBe(secondBinding.id);
    const resolverCalls = new Map<string, number>();
    let recoveryCalls = 0;
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const info = { protocolVersion: 2, kind: 'executor', name: 'container', workspaceRoot: '/', tools: [] };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async (binding) => {
        const count = (resolverCalls.get(binding.id) ?? 0) + 1;
        resolverCalls.set(binding.id, count);
        if (count === 1) {
          throw Object.assign(new Error('container agent unavailable'), { transientConnectionFailure: true });
        }
        return { endpointUrl: 'http://container.test', accessToken: token, workspacePath: '/workspace' };
      },
      async () => {
        recoveryCalls += 1;
        await recoveryGate;
      },
      async () => 'local://container/shared-workspace-key',
    );
    try {
      const checks = Promise.all([executor.checkConnection(firstBinding), executor.checkConnection(secondBinding)]);
      await until(() => recoveryCalls === 1);
      releaseRecovery();
      await expect(checks).resolves.toHaveLength(2);
      expect(resolverCalls.get(firstBinding.id)).toBe(2);
      expect(resolverCalls.get(secondBinding.id)).toBe(2);
      expect(recoveryCalls).toBe(1);
    } finally {
      releaseRecovery();
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('latches a failed recovery until a successful independent health check', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let online = false;
    let recoveryCalls = 0;
    const info = { protocolVersion: 2, kind: 'executor', name: 'test', workspaceRoot: '/', tools: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!online) throw new TypeError('connection still down');
      return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.checkConnection(binding)).rejects.toThrow('connection still down');
      expect(recoveryCalls).toBe(1);
      await expect(executor.checkConnection(binding)).rejects.toThrow('connection still down');
      expect(recoveryCalls).toBe(1);
      online = true;
      await expect(executor.checkConnection(binding)).resolves.toMatchObject({ kind: 'executor' });
      online = false;
      await expect(executor.checkConnection(binding)).rejects.toThrow('connection still down');
      expect(recoveryCalls).toBe(2);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not recover resolver authentication, permission, or protocol errors without an explicit transient marker', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    const error = Object.assign(new Error('Workspace authorization failed.'), { status: 403 });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => {
        throw error;
      },
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.checkConnection(binding)).rejects.toBe(error);
      expect(recoveryCalls).toBe(0);
    } finally {
      await executor.shutdown();
      store.close();
    }
  });

  it('sends authenticated Runtime lease heartbeats and releases through the resolved Executor address', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    let resolutions = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ ok: true, leaseToken: 'lease-token-1', expiresAt: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(store, undefined, async () => {
      resolutions += 1;
      return { endpointUrl: 'http://executor.test', accessToken: token };
    });
    const identity = { runtimeId: 'runtime-1', source: 'thread' as const, leaseId: 'thread-1' };
    try {
      await expect(executor.heartbeat(binding, identity)).resolves.toBe('lease-token-1');
      await executor.release(binding, identity);
      expect(resolutions).toBe(1);
      expect(calls).toEqual([
        { url: 'http://executor.test/api/leases/heartbeat', authorization: `Bearer ${token}`, body: identity },
        {
          url: 'http://executor.test/api/leases/release',
          authorization: `Bearer ${token}`,
          body: { ...identity, leaseToken: 'lease-token-1' },
        },
      ]);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('recovers and retries one failed heartbeat for transport loss or a draining response', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const identity = { runtimeId: 'runtime-1', source: 'thread' as const, leaseId: 'thread-heartbeat-retry' };
    const calls: Array<{ path: string; body: unknown }> = [];
    let failureMode: 'transport' | 'draining' = 'transport';
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ path: url.pathname, body });
      if (
        url.pathname.endsWith('/heartbeat') &&
        calls.filter((call) => call.path.endsWith('/heartbeat')).length % 2 === 1
      ) {
        if (failureMode === 'transport') throw new TypeError('connection reset');
        return new Response(JSON.stringify({ error: 'Executor is draining.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          leaseToken: `lease-token-${calls.filter((call) => call.path.endsWith('/heartbeat')).length}`,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.heartbeat(binding, identity)).resolves.toBe('lease-token-2');
      failureMode = 'draining';
      await expect(executor.heartbeat(binding, identity)).resolves.toBe('lease-token-4');
      const heartbeatCalls = calls.filter((call) => call.path.endsWith('/heartbeat'));
      expect(heartbeatCalls).toHaveLength(4);
      expect(heartbeatCalls.map((call) => call.body)).toEqual([identity, identity, identity, identity]);
      expect(recoveryCalls).toBe(2);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not recover or retry a heartbeat after an authentication failure', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(
        executor.heartbeat(binding, { runtimeId: 'runtime-1', source: 'thread', leaseId: 'thread-auth-fail' }),
      ).rejects.toThrow('unauthorized');
      expect(recoveryCalls).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('uses only an authenticated health probe as the default Remote heartbeat recovery', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const paths: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/api/leases/heartbeat' && paths.filter((path) => path === url.pathname).length === 1) {
        return new Response(JSON.stringify({ error: 'Executor is draining.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/info') {
        return new Response(
          JSON.stringify({
            protocolVersion: 2,
            kind: 'executor',
            name: 'remote',
            workspaceRoot: '/',
            leaseHeartbeat: true,
            tools: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, leaseToken: 'lease-token-remote' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(store, undefined, async () => ({
      endpointUrl: 'http://executor.test',
      accessToken: token,
    }));
    try {
      await expect(
        executor.heartbeat(binding, { runtimeId: 'runtime-1', source: 'thread', leaseId: 'thread-remote' }),
      ).resolves.toBe('lease-token-remote');
      expect(paths).toEqual(['/api/leases/heartbeat', '/api/info', '/api/leases/heartbeat']);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('serializes a late heartbeat before release and releases with its newest token', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const identity = { runtimeId: 'runtime-1', source: 'thread' as const, leaseId: 'thread-race' };
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let releaseLateHeartbeat!: () => void;
    const lateHeartbeatGate = new Promise<void>((resolve) => {
      releaseLateHeartbeat = resolve;
    });
    let heartbeatCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/heartbeat')) {
        heartbeatCalls += 1;
        if (heartbeatCalls === 2) await lateHeartbeatGate;
        return new Response(JSON.stringify({ ok: true, leaseToken: `lease-token-${heartbeatCalls}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(store, undefined, async () => ({
      endpointUrl: 'http://executor.test',
      accessToken: token,
    }));
    try {
      await executor.heartbeat(binding, identity);
      const delayed = executor.heartbeat(binding, identity);
      await until(() => heartbeatCalls === 2);
      const released = executor.release(binding, identity);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toHaveLength(2);
      releaseLateHeartbeat();
      await expect(delayed).resolves.toBe('lease-token-2');
      await released;
      expect(calls[2]).toEqual({
        path: '/api/leases/release',
        body: { ...identity, leaseToken: 'lease-token-2' },
      });
      await expect(executor.heartbeat(binding, identity)).resolves.toBe('lease-token-3');
      expect(calls[3]?.path).toBe('/api/leases/heartbeat');
    } finally {
      releaseLateHeartbeat();
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('stops renewing after a failed release while retaining the token for release retry', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const identity = { runtimeId: 'runtime-1', source: 'thread' as const, leaseId: 'thread-release-fails' };
    let resolutions = 0;
    let heartbeatCalls = 0;
    const releaseBodies: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.leaseToken) {
        releaseBodies.push(body);
        if (releaseBodies.length === 1) {
          return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      heartbeatCalls += 1;
      return new Response(JSON.stringify({ ok: true, leaseToken: 'lease-token-kept' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(store, undefined, async () => {
      resolutions += 1;
      return { endpointUrl: 'http://executor.test', accessToken: token };
    });
    try {
      await executor.heartbeat(binding, identity);
      await expect(executor.release(binding, identity)).rejects.toThrow('temporarily unavailable');
      expect(heartbeatCalls).toBe(1);
      expect(resolutions).toBe(1);
      await executor.release(binding, identity);
      expect(releaseBodies).toEqual([
        { ...identity, leaseToken: 'lease-token-kept' },
        { ...identity, leaseToken: 'lease-token-kept' },
      ]);
      expect(resolutions).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('shares one recovery across concurrent failures for the same Executor identity', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let failures = 2;
    let recoveryCalls = 0;
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const info = { protocolVersion: 2, kind: 'executor', name: 'test', workspaceRoot: '/', tools: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new TypeError('connection reset');
      }
      return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
        await recoveryGate;
      },
    );
    try {
      const checks = Promise.all([executor.checkConnection(binding), executor.checkConnection(binding)]);
      await until(() => recoveryCalls === 1);
      releaseRecovery();
      await expect(checks).resolves.toHaveLength(2);
      expect(recoveryCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      releaseRecovery();
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('bounds each operation to one request retry after recovery', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection reset'));
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.checkConnection(binding)).rejects.toThrow('Remote Executor request failed');
      expect(recoveryCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('recovers one workspace download transport failure without retrying protocol responses', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    let downloadCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/info') {
        return new Response(
          JSON.stringify({
            protocolVersion: 2,
            kind: 'executor',
            name: 'executor',
            workspaceRoot: '/',
            workspaceFileDownload: true,
            tools: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      downloadCalls += 1;
      if (downloadCalls === 1) throw new TypeError('download socket reset');
      return new Response('downloaded file', { status: 200 });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token, workspacePath: '/workspace' }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      const response = await executor.readWorkspaceFile(binding, 'note.txt');
      await expect(response.text()).resolves.toBe('downloaded file');
      expect(downloadCalls).toBe(2);
      expect(recoveryCalls).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not recover workspace downloads after auth failures or user abort', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    let recoveryCalls = 0;
    let abortController: AbortController | undefined;
    let infoUnavailable = true;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/info') {
        if (infoUnavailable) {
          infoUnavailable = false;
          return new Response(JSON.stringify({ error: 'draining' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            protocolVersion: 2,
            kind: 'executor',
            name: 'executor',
            workspaceRoot: '/',
            workspaceFileDownload: true,
            tools: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (abortController) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
          abortController!.abort();
        });
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token, workspacePath: '/workspace' }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.readWorkspaceFile(binding, 'note.txt')).rejects.toMatchObject({ status: 502 });
      expect(recoveryCalls).toBe(0);
      await expect(executor.readWorkspaceFile(binding, 'secret.txt')).rejects.toMatchObject({ status: 502 });
      expect(recoveryCalls).toBe(0);
      abortController = new AbortController();
      await expect(executor.readWorkspaceFile(binding, 'note.txt', abortController.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(recoveryCalls).toBe(0);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('recovers status transport failures and preserves the confirmed-missing 404 transition', async () => {
    const store = new PicoStore(':memory:');
    const completed = makePendingRemoteToolExecution(store, 'status-recover-completed');
    store.transitionExecution(completed.executionId, 'running');
    const missing = makePendingRemoteToolExecution(store, 'status-recover-missing');
    store.transitionExecution(missing.executionId, 'running');
    const binding = store.executorForThread(completed.threadId)!;
    let recoveryCalls = 0;
    let stateQueries = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(completed.executionId)) {
        stateQueries += 1;
        if (stateQueries === 1) throw new TypeError('status socket reset');
        return new Response(JSON.stringify({ id: completed.executionId, status: 'completed', result: 'done' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'missing' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.status(completed.executionId, binding)).resolves.toMatchObject({ status: 'completed' });
      await expect(executor.status(missing.executionId, binding)).resolves.toMatchObject({
        status: 'interrupted',
      });
      expect(recoveryCalls).toBe(1);
      expect(stateQueries).toBe(2);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('recovers an idempotent interrupt request after a transport failure', async () => {
    const store = new PicoStore(':memory:');
    const seeded = makePendingRemoteToolExecution(store, 'interrupt-recover');
    const binding = store.executorForThread(seeded.threadId)!;
    let recoveryCalls = 0;
    let submissionCalls = 0;
    let interruptCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname === `/api/executions/${seeded.executionId}`) {
        submissionCalls += 1;
        return new Response(JSON.stringify({ id: seeded.executionId, status: 'running' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/interrupt')) {
        interruptCalls += 1;
        if (interruptCalls === 1) throw new TypeError('interrupt socket reset');
        return new Response(JSON.stringify({ id: seeded.executionId, status: 'interrupted' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: seeded.executionId, status: 'running' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.interrupt(seeded.executionId, binding)).resolves.toMatchObject({ status: 'interrupted' });
      expect(submissionCalls).toBe(0);
      expect(interruptCalls).toBe(2);
      expect(recoveryCalls).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('requires the optional-workspace capability only for workspace-free Threads', async () => {
    const store = new PicoStore(':memory:');
    const thread = store.createThread(null, 'host');
    const binding = store.executorForThread(thread.id)!;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            protocolVersion: 2,
            executorVersion: '0.2.1',
            kind: 'executor',
            name: 'old',
            workspaceRoot: '/',
            tools: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const executor = new RemoteHostExecutor(store, undefined, async () => ({
      endpointUrl: 'http://127.0.0.1:1234',
      accessToken: token,
    }));
    try {
      await expect(executor.listTools(binding)).rejects.toThrow('does not support Threads without a workspace');
      await expect(executor.listTools({ ...binding, workspacePath: '/some/project' })).resolves.toEqual([]);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('runs Host tools without a Project workspace and accepts absolute file paths', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-host-no-workspace-')),
    );
    const target = join(directory, 'target.txt');
    await writeFile(target, 'outside the runtime cwd');
    const server = await startRemoteExecutorServer({
      token,
      workspaceRoot: '/',
      filesystemMode: 'host',
      databasePath: join(directory, 'ledger.sqlite'),
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const accepted = await fetch(`${baseUrl}/api/executions/host-no-project`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'read_file', arguments: { path: target }, workspacePath: '' }),
      });
      expect(accepted.status).toBe(202);
      expect(await waitForExecution(baseUrl, 'host-no-project')).toMatchObject({ status: 'completed' });
      expect(await getJson(`${baseUrl}/api/executions/host-no-project`, token)).toMatchObject({
        result: { contents: 'outside the runtime cwd' },
      });
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs without a Project workspace while retaining the remote execution root', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-no-workspace-')),
    );
    const workspaceRoot = join(directory, 'root');
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, 'note.txt'), 'remote root');
    const server = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'ledger.sqlite'),
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const accepted = await fetch(`${baseUrl}/api/executions/no-project`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'read_file', arguments: { path: 'note.txt' }, workspacePath: '' }),
      });
      expect(accepted.status).toBe(202);
      expect(await waitForExecution(baseUrl, 'no-project')).toMatchObject({ status: 'completed' });
      expect(await getJson(`${baseUrl}/api/executions/no-project`, token)).toMatchObject({
        result: { contents: 'remote root' },
      });
      const download = await fetch(`${baseUrl}/api/workspaces/download`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '', path: 'note.txt' }),
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('remote root');
      const escape = await fetch(`${baseUrl}/api/workspaces/download`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '', path: '../outside' }),
      });
      expect(escape.status).toBe(400);
      const badPath = await fetch(`${baseUrl}/api/executions/bad-path`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'read_file', arguments: { path: '../outside' }, workspacePath: '' }),
      });
      expect(badPath.status).toBe(202);
      expect(await waitForExecution(baseUrl, 'bad-path')).toMatchObject({ status: 'failed' });
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('authenticates, confines selected workspaces, and deduplicates durable execution IDs', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-executor-')),
    );
    const workspaceRoot = join(directory, 'workspaces');
    const workspace = join(workspaceRoot, 'project');
    const outside = join(directory, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    await writeFile(join(workspace, 'read-me.txt'), 'Remote tool read succeeded.');
    const databasePath = join(directory, 'executor.sqlite');
    let server = await startRemoteExecutorServer({ token, workspaceRoot, databasePath, port: 0 });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${baseUrl}/api/info`)).status).toBe(401);
      const info = await getJson<{ kind: string; workspaceRoot: string; tools: Array<{ name: string }> }>(
        `${baseUrl}/api/info`,
        token,
      );
      expect(info.kind).toBe('executor');
      expect(info.workspaceRoot).toBe(workspaceRoot);
      expect(info.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['read_file', 'search_files', 'apply_patch', 'shell']),
      );

      const invalidWorkspace = await fetch(`${baseUrl}/api/workspaces/validate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: outside }),
      });
      expect(invalidWorkspace.status).toBe(400);

      const readId = 'remote-read-file-execution';
      const readAccepted = await fetch(`${baseUrl}/api/executions/${readId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          toolName: 'read_file',
          arguments: { path: 'read-me.txt' },
          workspacePath: workspace,
        }),
      });
      expect(readAccepted.status).toBe(202);
      await waitForExecution(baseUrl, readId);
      expect(
        await getJson<{ result: { contents: string } }>(`${baseUrl}/api/executions/${readId}`, token),
      ).toMatchObject({
        result: { contents: 'Remote tool read succeeded.' },
      });

      const patchId = 'remote-apply-patch-execution';
      const patchAccepted = await fetch(`${baseUrl}/api/executions/${patchId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          toolName: 'apply_patch',
          arguments: {
            patch: [
              '*** Begin Patch',
              '*** Add File: remote-patch.txt',
              '+Remote patch succeeded.',
              '*** End Patch',
            ].join('\n'),
          },
          workspacePath: workspace,
        }),
      });
      expect(patchAccepted.status).toBe(202);
      await waitForExecution(baseUrl, patchId);
      expect(await readFile(join(workspace, 'remote-patch.txt'), 'utf8')).toBe('Remote patch succeeded.\n');

      const executionId = 'stable-execution-id';
      const request = {
        toolName: 'shell',
        arguments: { command: "node -e \"require('node:fs').appendFileSync('runs.log', 'x')\"" },
        workspacePath: workspace,
      };
      const accepted = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      expect((await accepted.json()).status).toBe('running');
      expect(await waitForExecution(baseUrl, executionId)).toMatchObject({ status: 'completed' });

      const duplicate = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect((await duplicate.json()).status).toBe('completed');
      expect(await readFile(join(workspace, 'runs.log'), 'utf8')).toBe('x');

      const changedInput = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, arguments: { command: 'true' } }),
      });
      expect(changedInput.status).toBe(400);

      await rm(workspace, { recursive: true, force: true });
      await server.close();
      server = await startRemoteExecutorServer({ token, workspaceRoot, databasePath, port: 0 });
      baseUrl = `http://127.0.0.1:${server.port}`;
      const afterRestart = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect((await afterRestart.json()).status).toBe('completed');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('discovers and executes a custom Remote Executor tool with the versioned schema', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-plugin-')),
    );
    const workspaceRoot = join(directory, 'workspaces');
    const workspace = join(workspaceRoot, 'project');
    const pluginDirectory = join(directory, 'executor-plugins');
    await mkdir(workspace, { recursive: true });
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'custom.mjs'),
      `import { writeFile } from 'node:fs/promises';
       export default {
         id: 'test.remote-marker', name: 'Remote marker', version: '1',
         activateExecutor({ tools }) {
           tools.register({ name: 'write_marker', description: 'Write a marker in this Remote Executor workspace.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }, async (args, context) => {
             await writeFile(context.workspacePath + '/remote-marker.txt', String(args.content));
             return { executionId: context.executionId, workspacePath: context.workspacePath };
           });
         }
       };
      `,
    );
    const server = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      pluginDirectory,
      tools: new ToolCatalog(),
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const info = await getJson<{
        protocolVersion: number;
        tools: Array<{ name: string; parameters: Record<string, unknown> }>;
      }>(`${baseUrl}/api/info`, token);
      expect(info.protocolVersion).toBe(2);
      expect(info.tools.map((tool) => tool.name)).toEqual(['write_marker']);
      expect(info.tools.find((tool) => tool.name === 'write_marker')?.parameters).toMatchObject({
        type: 'object',
        required: ['content'],
      });
      const executionId = 'remote-plugin-execution';
      const accepted = await fetch(`${baseUrl}/api/executions/${executionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          toolName: 'write_marker',
          arguments: { content: 'remote bundle works' },
          workspacePath: workspace,
        }),
      });
      expect(accepted.status).toBe(202);
      expect(await waitForExecution(baseUrl, executionId)).toMatchObject({
        status: 'completed',
        result: { executionId, workspacePath: workspace },
      });
      expect(await readFile(join(workspace, 'remote-marker.txt'), 'utf8')).toBe('remote bundle works');
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs a Thread against a manually connected remote workspace without exposing its token', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-thread-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    await writeFile(join(remoteWorkspace, 'remote.txt'), 'This file is on the remote machine.');
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
      name: 'Build host',
    });
    const model = new FakeModel((_prompt, callNumber) => {
      if (callNumber === 1) {
        return response('', [{ id: 'remote-read', name: 'read_file', arguments: { path: 'remote.txt' } }]);
      }
      if (callNumber === 3) {
        return response('', [
          {
            id: 'remote-child',
            name: 'spawn_thread',
            arguments: { title: 'Remote child', prompt: 'Inspect this workspace.' },
          },
        ]);
      }
      return response('Remote workspace inspected.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin, collaborationPlugin] });
    try {
      const connection = await env.runtime.addRemoteExecutorConnection(
        'Build host',
        `http://127.0.0.1:${remote.port}`,
        token,
      );
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Remote task',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      expect(thread.executorRemote).toBe(true);
      expect(thread.workspacePath).toBe(remoteWorkspace);
      setToolPolicy(env.store, thread.id, 'read_file', 'allow');

      await env.runtime.submit(thread.id, 'remote-user-message', 'Read the remote file.');
      await env.runtime.drain();

      expect(model.calls).toBe(2);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('This file is on the remote machine.'),
        ),
      ).toBe(true);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'completed',
      );
      expect(env.store.executorForThread(thread.id)).toMatchObject({
        remoteConnectionId: connection.id,
        workspacePath: remoteWorkspace,
      });
      expect(JSON.stringify(thread)).not.toContain(token);
      expect(JSON.stringify(env.runtime.remoteExecutorConnections())).not.toContain(token);

      await env.runtime.submit(thread.id, 'remote-child-request', 'Delegate a check to a child Thread.');
      await env.runtime.drain();
      const child = env.runtime.listThreads(env.project.id).find((item) => item.parentThreadId === thread.id);
      expect(child?.executorRemote).toBe(true);
      expect(child?.workspacePath).toBe(remoteWorkspace);
      expect(env.store.executorForThread(child!.id)).toMatchObject({ remoteConnectionId: connection.id });
    } finally {
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rotates a remote Executor token without changing an existing Thread binding', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-token-rotation-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    const databasePath = join(directory, 'executor.sqlite');
    const rotatedToken = 'pico-test-remote-executor-token-rotated-abcdef1234567890';
    await mkdir(remoteWorkspace, { recursive: true });
    await writeFile(join(remoteWorkspace, 'before.txt'), 'The original credential works.');
    await writeFile(join(remoteWorkspace, 'after.txt'), 'The replacement credential works.');
    let remote = await startRemoteExecutorServer({ token, workspaceRoot, databasePath, port: 0 });
    const port = remote.port;
    const endpoint = `http://127.0.0.1:${port}`;
    const model = new FakeModel((_prompt, callNumber) => {
      if (callNumber === 1) {
        return response('', [{ id: 'before-rotation', name: 'read_file', arguments: { path: 'before.txt' } }]);
      }
      if (callNumber === 3) {
        return response('', [{ id: 'after-rotation', name: 'read_file', arguments: { path: 'after.txt' } }]);
      }
      return response('The remote workspace is still available.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Existing work',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      const originalBinding = env.store.executorForThread(thread.id)!;
      await expect(
        env.runtime.updateRemoteExecutorConnection(connection.id, connection.name, 'http://127.0.0.1:1', token),
      ).rejects.toThrow(/Add a new connection and create a new Thread/);
      expect(env.store.executorForThread(thread.id)).toMatchObject({
        id: originalBinding.id,
        remoteConnectionId: connection.id,
        remoteEndpointUrl: endpoint,
        workspacePath: remoteWorkspace,
      });
      setToolPolicy(env.store, thread.id, 'read_file', 'allow');

      await env.runtime.submit(thread.id, 'before-rotation-message', 'Read the file before rotation.');
      await env.runtime.drain();
      expect(
        model.prompts[1]?.turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('original')),
      ).toBe(true);

      await remote.close();
      remote = await startRemoteExecutorServer({ token: rotatedToken, workspaceRoot, databasePath, port });
      expect(
        (
          await fetch(`${endpoint}/api/info`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${endpoint}/api/info`, {
            headers: { authorization: `Bearer ${rotatedToken}` },
          })
        ).status,
      ).toBe(200);

      const updated = await env.runtime.updateRemoteExecutorConnection(
        connection.id,
        connection.name,
        connection.endpointUrl,
        rotatedToken,
      );
      expect(updated).toMatchObject({ id: connection.id, endpointUrl: endpoint });
      expect(env.store.executorForThread(thread.id)).toMatchObject({
        id: originalBinding.id,
        remoteConnectionId: connection.id,
        remoteEndpointUrl: endpoint,
        workspacePath: remoteWorkspace,
      });
      expect(JSON.stringify(updated)).not.toContain(rotatedToken);

      await env.runtime.submit(thread.id, 'after-rotation-message', 'Read the file after rotation.');
      await env.runtime.drain();

      expect(
        model.prompts[3]?.turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('replacement')),
      ).toBe(true);
      expect(env.store.executorForThread(thread.id)).toMatchObject({
        id: originalBinding.id,
        remoteConnectionId: connection.id,
        remoteEndpointUrl: endpoint,
        workspacePath: remoteWorkspace,
      });
      const toolExecutions = env.store.listExecutions(thread.id).filter((execution) => execution.kind === 'tool');
      expect(toolExecutions.map((execution) => execution.status)).toEqual(['completed', 'completed']);
    } finally {
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not start a fresh execution when a running ID is absent from the remote ledger', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-lost-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const model = new FakeModel(() => response('Recovered after the missing execution.'));
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    try {
      const connection = await env.runtime.addRemoteExecutorConnection(
        'Build host',
        `http://127.0.0.1:${remote.port}`,
        token,
      );
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Remote execution with a missing ledger entry',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      setToolPolicy(env.store, thread.id, 'shell', 'allow');
      const modelExecution = env.store.createModelExecution('lost-remote-model', thread.id, 0);
      env.store.transitionExecution(modelExecution.id, 'running');
      const call = { id: 'lost-remote-call', name: 'shell', arguments: { command: 'touch should-not-run' } };
      env.store.commitModelStep({
        assistantRecordId: 'lost-remote-model:assistant',
        modelExecutionId: modelExecution.id,
        threadId: thread.id,
        payload: {
          content: '',
          toolCalls: [call],
          batchId: 'lost-remote-model:batch',
          projectionThrough: 0,
          usage: null,
          model: 'test-model',
        },
        toolCalls: [{ call, executionId: `${thread.id}:lost-remote-model:lost-remote-call`, source: 'executor' }],
      });
      const lostExecutionId = `${thread.id}:lost-remote-model:lost-remote-call`;
      env.store.transitionExecution(lostExecutionId, 'running');

      env.runtime.continue(thread.id);
      await env.runtime.drain();

      expect(env.store.getExecution(lostExecutionId)).toMatchObject({
        status: 'interrupted',
      });
      expect(model.calls).toBe(1);
      await expect(readFile(join(remoteWorkspace, 'should-not-run'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a Remote execution after transient status disconnects without resubmitting it', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-reconnect-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${remote.port}`;
    const executionCommand = "node -e \"setTimeout(() => require('node:fs').appendFileSync('runs.log', 'x'), 1500)\"";
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'long-remote-call', name: 'shell', arguments: { command: executionCommand } }])
        : response('Recovered the remote result.'),
    );
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    const originalFetch = globalThis.fetch;
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Reconnect after transient disconnects',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      setToolPolicy(env.store, thread.id, 'shell', 'allow');

      let acceptedRemoteSubmission = false;
      let submissionAttempts = 0;
      let statusConnectionFailures = 0;
      let firstRecoveredStatus = false;
      globalThis.fetch = async (input, init) => {
        const requestUrl = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (
          requestUrl.origin === endpoint &&
          requestUrl.pathname.startsWith('/api/executions/') &&
          init?.method === 'POST' &&
          !requestUrl.pathname.endsWith('/interrupt')
        ) {
          const result = await originalFetch(input, init);
          acceptedRemoteSubmission = true;
          submissionAttempts += 1;
          if (submissionAttempts === 1) {
            throw new TypeError('Simulated lost response after Remote Executor accepted the execution.');
          }
          return result;
        }
        if (
          acceptedRemoteSubmission &&
          requestUrl.origin === endpoint &&
          requestUrl.pathname.startsWith('/api/executions/') &&
          init?.method !== 'POST' &&
          statusConnectionFailures < 2
        ) {
          if (statusConnectionFailures === 0) {
            statusConnectionFailures = 1;
            throw new TypeError('Simulated temporary Remote Executor connection loss.');
          }
          if (!firstRecoveredStatus) {
            firstRecoveredStatus = true;
            return originalFetch(input, init);
          }
          statusConnectionFailures = 2;
          throw new TypeError('Simulated second independent Remote Executor connection loss.');
        }
        return originalFetch(input, init);
      };

      await env.runtime.submit(thread.id, 'remote-reconnect-message', 'Run and recover the remote command.');
      await until(() => statusConnectionFailures > 0);
      await until(() =>
        env.store.listExecutions(thread.id).some((item) => item.kind === 'tool' && item.status === 'running'),
      );
      const toolExecution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool');
      expect(toolExecution?.status).toBe('running');
      expect(env.runtime.getThread(thread.id)?.state).toBe('running');

      await env.runtime.drain();

      expect(submissionAttempts).toBe(1);
      expect(statusConnectionFailures).toBe(2);
      expect(env.store.getExecution(toolExecution!.id)?.status).toBe('completed');
      expect(await readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).toBe('x');
      expect(model.calls).toBe(2);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      globalThis.fetch = originalFetch;
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resumes a still-running Remote execution after the Runtime process is recreated', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-runtime-restart-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    const projectWorkspace = join(directory, 'project-workspace');
    const databasePath = join(directory, 'runtime.sqlite');
    await mkdir(remoteWorkspace, { recursive: true });
    await mkdir(projectWorkspace);
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${remote.port}`;
    const command = "node -e \"setTimeout(() => require('node:fs').appendFileSync('runs.log', 'x'), 3000)\"";
    const firstModel = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'runtime-restart-call', name: 'shell', arguments: { command } }])
        : response('First Runtime resumed the call.'),
    );
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, { model: firstModel, pluginDirectory: join(directory, 'empty-plugins') });
    try {
      await runtime.initialize();
      const project = await runtime.createProject('Runtime restart', projectWorkspace);
      const connection = await runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const catalog = await setupTestCatalog(runtime);
      const thread = await runtime.createRemoteThread(project.id, connection.id, remoteWorkspace);
      runtime.updateThreadModelSelection(thread.id, catalog.select());
      setToolPolicy(store, thread.id, 'shell', 'allow');
      await runtime.submit(thread.id, 'runtime-restart-message', 'Run a command that outlives this Runtime.');
      await until(() =>
        store
          .listExecutions(thread.id)
          .some((execution) => execution.kind === 'tool' && execution.status === 'running'),
      );
      const execution = store.listExecutions(thread.id).find((item) => item.kind === 'tool');
      expect(execution).toBeDefined();
      expect(await getJson<{ status: string }>(`${endpoint}/api/executions/${execution!.id}`, token)).toMatchObject({
        status: 'running',
      });

      await runtime.shutdown();
      expect(store.getExecution(execution!.id)?.status).toBe('running');
      expect(runtime.getThread(thread.id)?.state).toBe('running');
      store.close();

      store = new PicoStore(databasePath);
      const resumedModel = new FakeModel(() => response('Resumed after Runtime restart.'));
      runtime = new PicoRuntime(store, { model: resumedModel, pluginDirectory: join(directory, 'empty-plugins') });
      await setupTestCatalog(runtime);
      await runtime.initialize();
      expect(runtime.getThread(thread.id)?.state).toBe('running');
      await runtime.drain();

      expect(store.getExecution(execution!.id)?.status).toBe('completed');
      expect(await readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).toBe('x');
      expect(resumedModel.calls).toBe(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      store.close();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reconciles a paused Thread’s active Remote Tool after Runtime restart without continuing the Model', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-paused-restart-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    const projectWorkspace = join(directory, 'project-workspace');
    const databasePath = join(directory, 'runtime.sqlite');
    await mkdir(remoteWorkspace, { recursive: true });
    await mkdir(projectWorkspace);
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${remote.port}`;
    const command = "node -e \"setTimeout(() => require('node:fs').appendFileSync('runs.log', 'x'), 1500)\"";
    const firstModel = new FakeModel(() =>
      response('', [{ id: 'paused-restart-call', name: 'shell', arguments: { command } }]),
    );
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, { model: firstModel, pluginDirectory: join(directory, 'empty-plugins') });
    try {
      await runtime.initialize();
      const project = await runtime.createProject('Paused Runtime restart', projectWorkspace);
      const connection = await runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const catalog = await setupTestCatalog(runtime);
      const thread = await runtime.createRemoteThread(project.id, connection.id, remoteWorkspace);
      runtime.updateThreadModelSelection(thread.id, catalog.select());
      setToolPolicy(store, thread.id, 'shell', 'allow');
      await runtime.submit(thread.id, 'paused-runtime-restart-message', 'Run while the Runtime restarts.');
      await until(() =>
        store
          .listExecutions(thread.id)
          .some((execution) => execution.kind === 'tool' && execution.status === 'running'),
      );
      const execution = store.listExecutions(thread.id).find((item) => item.kind === 'tool');
      expect(execution).toBeDefined();

      runtime.pause(thread.id);
      await runtime.shutdown();
      expect(store.getThread(thread.id)?.pauseRequested).toBe(true);
      expect(store.getExecution(execution!.id)?.status).toBe('running');
      store.close();

      store = new PicoStore(databasePath);
      const resumedModel = new FakeModel(() => response('Continued after explicit Continue.'));
      runtime = new PicoRuntime(store, { model: resumedModel, pluginDirectory: join(directory, 'empty-plugins') });
      await setupTestCatalog(runtime);
      await runtime.initialize();
      await runtime.drain();

      expect(store.getExecution(execution!.id)?.status).toBe('completed');
      expect(runtime.getThread(thread.id)?.state).toBe('paused');
      expect(resumedModel.calls).toBe(0);
      expect(await readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).toBe('x');

      runtime.continue(thread.id);
      await runtime.drain();
      expect(resumedModel.calls).toBe(1);
      expect(runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      await runtime.shutdown();
      store.close();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('sends explicit Interrupt to the connected Executor and records the settled result', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-interrupt-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [
            { id: 'long-running', name: 'shell', arguments: { command: 'node -e "setTimeout(() => {}, 60000)"' } },
          ])
        : response('Interrupted safely.'),
    );
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    try {
      const connection = await env.runtime.addRemoteExecutorConnection(
        'Build host',
        `http://127.0.0.1:${remote.port}`,
        token,
      );
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Interrupt remote execution',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      setToolPolicy(env.store, thread.id, 'shell', 'allow');
      await env.runtime.submit(thread.id, 'remote-interrupt-message', 'Start then interrupt a command.');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.kind === 'tool' && execution.status === 'running'),
      );

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'interrupted',
      );
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('interrupts a Remote Tool whose accepted submission response was lost', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-interrupt-pending-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${remote.port}`;
    const command = "node -e \"setTimeout(() => require('node:fs').appendFileSync('runs.log', 'x'), 1200)\"";
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'lost-ack-interrupt-call', name: 'shell', arguments: { command } }])
        : response('The interrupted command did not continue.'),
    );
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    const originalFetch = globalThis.fetch;
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Interrupt after lost acknowledgement',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      setToolPolicy(env.store, thread.id, 'shell', 'allow');

      let acceptedSubmissionResponseWasLost = false;
      let submissionAttempts = 0;
      globalThis.fetch = async (input, init) => {
        const requestUrl = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (
          requestUrl.origin === endpoint &&
          /^\/api\/executions\/[^/]+$/.test(requestUrl.pathname) &&
          init?.method === 'POST'
        ) {
          const result = await originalFetch(input, init);
          submissionAttempts += 1;
          if (!acceptedSubmissionResponseWasLost) {
            acceptedSubmissionResponseWasLost = true;
            throw new TypeError('Simulated lost response after Remote Executor accepted the execution.');
          }
          return result;
        }
        return originalFetch(input, init);
      };

      await env.runtime.submit(thread.id, 'lost-ack-interrupt-message', 'Start then interrupt the command.');
      await until(() => {
        const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool');
        return acceptedSubmissionResponseWasLost && execution?.status === 'running';
      });
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool')!;
      expect(await getJson<{ status: string }>(`${endpoint}/api/executions/${execution.id}`, token)).toMatchObject({
        status: 'running',
      });

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(env.store.getExecution(execution.id)?.status).toBe('interrupted');
      expect(submissionAttempts).toBe(1);
      expect(await getJson<{ status: string }>(`${endpoint}/api/executions/${execution.id}`, token)).toMatchObject({
        status: 'interrupted',
      });
      expect(env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result')).toMatchObject({
        payload: { status: 'interrupted' },
      });
      expect(model.calls).toBe(1);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1400));
      await expect(readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      globalThis.fetch = originalFetch;
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 5000);

  it('does not resubmit a tool when recovery after a lost acknowledgement fails', async () => {
    const store = new PicoStore(':memory:');
    const seeded = makePendingRemoteToolExecution(store, 'failed-recovery-unknown');
    const binding = store.executorForThread(seeded.threadId)!;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection lost'));
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => { throw new Error('recovery failed'); },
    );
    try {
      await expect(executor.execute(seeded.executionId, binding)).rejects.toThrow('recovery failed');
      expect(store.getExecution(seeded.executionId)).toMatchObject({
        status: 'pending', error: expect.stringContaining('outcome is unknown'),
      });
      await expect(executor.execute(seeded.executionId, binding)).rejects.toThrow('outcome is unknown');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not resubmit a tool whose submission was interrupted after it began', async () => {
    const store = new PicoStore(':memory:');
    const seeded = makePendingRemoteToolExecution(store, 'aborted-submission-unknown');
    const binding = store.executorForThread(seeded.threadId)!;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => { submitted = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      submitted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const executor = new RemoteHostExecutor(store, undefined, async () => ({ endpointUrl: 'http://executor.test', accessToken: token }));
    const controller = new AbortController();
    try {
      const execution = executor.execute(seeded.executionId, binding, controller.signal);
      await started;
      controller.abort();
      await expect(execution).rejects.toThrow();
      expect(store.getExecution(seeded.executionId)).toMatchObject({
        status: 'pending', error: expect.stringContaining('outcome is unknown'),
      });
      await expect(executor.execute(seeded.executionId, binding)).rejects.toThrow('outcome is unknown');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('keeps an accepted but unqueryable submission pending when Interrupt finds a reset ledger', async () => {
    const store = new PicoStore(':memory:');
    const seeded = makePendingRemoteToolExecution(store, 'interrupt-reset-ledger');
    const binding = store.executorForThread(seeded.threadId)!;
    let submissionAttempts = 0;
    let stateQueries = 0;
    let recoveryCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        submissionAttempts += 1;
        // Model an accepted request whose acknowledgement was lost and whose ledger
        // was subsequently reset before the client can inspect the durable ID.
        throw new TypeError('accepted submission acknowledgement lost');
      }
      stateQueries += 1;
      return new Response(JSON.stringify({ error: 'Execution not found.' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const executor = new RemoteHostExecutor(
      store,
      undefined,
      async () => ({ endpointUrl: 'http://executor.test', accessToken: token }),
      async () => {
        recoveryCalls += 1;
      },
    );
    try {
      await expect(executor.execute(seeded.executionId, binding)).rejects.toThrow('outcome is unknown');
      await expect(executor.interrupt(seeded.executionId, binding)).rejects.toThrow('outcome is unknown');
      expect(store.getExecution(seeded.executionId)).toMatchObject({
        status: 'pending',
        error: expect.stringContaining('outcome is unknown'),
      });
      expect(submissionAttempts).toBe(1);
      expect(stateQueries).toBe(2);
      expect(recoveryCalls).toBe(1);
    } finally {
      fetchMock.mockRestore();
      await executor.shutdown();
      store.close();
    }
  });

  it('does not replay an in-flight submission as an interrupt barrier when its ledger entry is missing', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-interrupt-reorder-')),
    );
    const workspaceRoot = join(directory, 'remote-root');
    const remoteWorkspace = join(workspaceRoot, 'repo');
    await mkdir(remoteWorkspace, { recursive: true });
    const remote = await startRemoteExecutorServer({
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${remote.port}`;
    const command = "node -e \"setTimeout(() => require('node:fs').appendFileSync('runs.log', 'x'), 1200)\"";
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'reordered-interrupt-call', name: 'shell', arguments: { command } }])
        : response('The command was interrupted before it could continue.'),
    );
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    const originalFetch = globalThis.fetch;
    let heldSubmission = false;
    let submissionRequests = 0;
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Interrupt after reordered submission',
      );
      env.runtime.updateThreadModelSelection(thread.id, env.catalog.select());
      setToolPolicy(env.store, thread.id, 'shell', 'allow');

      globalThis.fetch = async (input, init) => {
        const requestUrl = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
        if (
          requestUrl.origin === endpoint &&
          /^\/api\/executions\/[^/]+$/.test(requestUrl.pathname) &&
          init?.method === 'POST'
        ) {
          submissionRequests += 1;
          if (!heldSubmission) {
            heldSubmission = true;
            return await new Promise<Response>((_resolve, reject) => {
              const signal = init.signal;
              if (!signal) throw new Error('Expected the in-flight submission to be cancellable.');
              const onAbort = (): void => {
                signal.removeEventListener('abort', onAbort);
                reject(new DOMException('Simulated delayed submission was cancelled.', 'AbortError'));
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            });
          }
        }
        return originalFetch(input, init);
      };

      await env.runtime.submit(thread.id, 'reordered-interrupt-message', 'Start then interrupt the command.');
      await until(
        () => heldSubmission && env.store.listExecutions(thread.id).some((item) => item.status === 'pending'),
      );
      const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool')!;

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(submissionRequests).toBe(1);
      expect(env.store.getExecution(execution.id)).toMatchObject({
        status: 'pending',
        error: expect.stringContaining('outcome is unknown'),
      });
      expect(await getJson<{ status: string }>(`${endpoint}/api/executions/${execution.id}`, token)).toMatchObject({
        error: 'Execution not found.',
      });
      expect(model.calls).toBe(1);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1400));
      await expect(readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      globalThis.fetch = originalFetch;
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 7000);
});
