import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { startRemoteExecutorServer } from '../src/executor/remote-server.js';

const token = 'executor-heartbeat-test-token-that-is-long-enough';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(
  idle?: { timeoutMs: number; onIdle: () => void | Promise<void> },
  extra: {
    tools?: ToolCatalog;
    update?: (bundle: Buffer, version: string) => Promise<void>;
    executorVersion?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'pico-executor-leases-'));
  const workspaceRoot = join(directory, 'workspace');
  await mkdir(workspaceRoot);
  const server = await startRemoteExecutorServer({
    host: '127.0.0.1',
    port: 0,
    token,
    workspaceRoot,
    databasePath: join(directory, 'executor.sqlite'),
    ...extra,
    ...(idle ? { idle } : {}),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: unknown, authorization = `Bearer ${token}`) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { directory, server, request };
}

describe('Remote Executor lease heartbeat', () => {
  const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
  afterEach(async () => {
    for (const item of fixtures.splice(0)) {
      await item.server.close();
      await rm(item.directory, { recursive: true, force: true });
    }
  });

  it('requires the existing bearer token and tracks independent runtime and source leases', async () => {
    const onIdle = vi.fn();
    const server = await fixture({ timeoutMs: 180, onIdle });
    fixtures.push(server);
    const lease = (runtimeId: string, source: string, leaseId: string) => ({ runtimeId, source, leaseId });
    expect((await server.request('/api/leases/heartbeat', lease('r1', 'thread', 't1'), 'Bearer invalid')).status).toBe(
      401,
    );
    const firstResponse = await server.request('/api/leases/heartbeat', lease('r1', 'thread', 't1'));
    expect(firstResponse.status).toBe(200);
    const firstLease = (await firstResponse.json()) as { leaseToken: string };
    const renewedResponse = await server.request('/api/leases/heartbeat', lease('r1', 'thread', 't1'));
    const renewedLease = (await renewedResponse.json()) as { leaseToken: string };
    expect(renewedLease.leaseToken).not.toBe(firstLease.leaseToken);
    const secondResponse = await server.request('/api/leases/heartbeat', lease('r2', 'viewer', 'v1'));
    const secondLease = (await secondResponse.json()) as { leaseToken: string };
    await server.request('/api/leases/release', { ...lease('r1', 'thread', 't1'), leaseToken: firstLease.leaseToken });
    await wait(100);
    expect(onIdle).not.toHaveBeenCalled();
    await server.request('/api/leases/release', {
      ...lease('r1', 'thread', 't1'),
      leaseToken: renewedLease.leaseToken,
    });
    await server.request('/api/leases/release', {
      ...lease('r2', 'viewer', 'v1'),
      leaseToken: secondLease.leaseToken,
    });
    await wait(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('expires from an empty startup and remains disabled for ordinary Remote Executors', async () => {
    const onIdle = vi.fn();
    const enabled = await fixture({ timeoutMs: 35, onIdle });
    fixtures.push(enabled);
    await wait(60);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const disabledCallback = vi.fn();
    const disabled = await fixture();
    fixtures.push(disabled);
    expect(
      (await disabled.request('/api/leases/heartbeat', { runtimeId: 'r', source: 'runtime', leaseId: 'r' })).status,
    ).toBe(404);
    await wait(50);
    expect(disabledCallback).not.toHaveBeenCalled();
  });

  it('fences heartbeats and new executions once the idle callback has been queued', async () => {
    let finishIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => {
      finishIdle = resolve;
    });
    const onIdle = vi.fn(() => idleGate);
    const server = await fixture({ timeoutMs: 30, onIdle });
    fixtures.push(server);
    const deadline = Date.now() + 500;
    while (!onIdle.mock.calls.length && Date.now() < deadline) await wait(5);
    expect(onIdle).toHaveBeenCalledTimes(1);

    const leaseResponse = await server.request('/api/leases/heartbeat', {
      runtimeId: 'runtime-after-drain',
      source: 'runtime',
      leaseId: 'runtime-after-drain',
    });
    expect(leaseResponse.status).toBe(503);
    expect(leaseResponse.headers.get('retry-after')).toBe('1');
    await expect(leaseResponse.json()).resolves.toMatchObject({ code: 'executor_draining', retryable: true });

    const executionResponse = await server.request('/api/executions/new-after-drain', {
      toolName: 'any_tool',
      arguments: {},
      workspacePath: '',
    });
    expect(executionResponse.status).toBe(503);
    await expect(executionResponse.json()).resolves.toMatchObject({ code: 'executor_draining', retryable: true });
    finishIdle();
  });

  it('does not expire while a tool is executing, then checks idle after it settles', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const tools = new ToolCatalog();
    tools.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'wait_tool', description: 'wait', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        await gate;
        return { ok: true };
      },
    });
    const onIdle = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), 'pico-executor-leases-'));
    const workspaceRoot = join(directory, 'workspace');
    await mkdir(workspaceRoot);
    const server = await startRemoteExecutorServer({
      host: '127.0.0.1',
      port: 0,
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      tools,
      idle: { timeoutMs: 35, onIdle },
    });
    const base = `http://127.0.0.1:${server.port}`;
    fixtures.push({
      directory,
      server,
      request: (path, body) =>
        fetch(
          `${base}${path}`,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
        ),
    });
    await fetch(`${base}/api/executions/tool-active`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'wait_tool', arguments: {}, workspacePath: '' }),
    });
    await wait(65);
    expect(onIdle).not.toHaveBeenCalled();
    finish();
    await wait(55);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace and update requests admitted until their responses finish', async () => {
    let finishUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const onIdle = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), 'pico-executor-leases-'));
    const workspaceRoot = join(directory, 'workspace');
    await mkdir(workspaceRoot);
    const server = await startRemoteExecutorServer({
      host: '127.0.0.1',
      port: 0,
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      executorVersion: '1.0.0',
      update: async () => {
        updateStarted();
        await updateGate;
      },
      idle: { timeoutMs: 150, onIdle },
    });
    const base = `http://127.0.0.1:${server.port}`;
    fixtures.push({
      directory,
      server,
      request: (path, body) =>
        fetch(
          `${base}${path}`,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
        ),
    });

    const validation = await fetch(`${base}/api/workspaces/validate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspaceRoot }),
    });
    expect(validation.status).toBe(200);
    const updateResponse = fetch(`${base}/api/update`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-pico-executor-version': '1.0.1',
      },
      body: Buffer.from('bundle'),
    });
    await started;
    await wait(180);
    expect(onIdle).not.toHaveBeenCalled();
    finishUpdate();
    await updateResponse;
    await wait(180);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('releases admission once when a client disconnects before response finish', async () => {
    let finishUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const onIdle = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), 'pico-executor-leases-'));
    const workspaceRoot = join(directory, 'workspace');
    await mkdir(workspaceRoot);
    const server = await startRemoteExecutorServer({
      host: '127.0.0.1',
      port: 0,
      token,
      workspaceRoot,
      databasePath: join(directory, 'executor.sqlite'),
      executorVersion: '1.0.0',
      update: async () => {
        updateStarted();
        await updateGate;
      },
      idle: { timeoutMs: 35, onIdle },
    });
    const base = `http://127.0.0.1:${server.port}`;
    fixtures.push({
      directory,
      server,
      request: (path, body) =>
        fetch(
          `${base}${path}`,
          body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
              },
        ),
    });

    const controller = new AbortController();
    const updateResponse = fetch(`${base}/api/update`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-pico-executor-version': '1.0.1',
      },
      body: Buffer.from('bundle'),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(updateResponse).rejects.toMatchObject({ name: 'AbortError' });
    await wait(70);
    expect(onIdle).toHaveBeenCalledTimes(1);
    finishUpdate();
  });

  it('rejects an update while an accepted tool is still running', async () => {
    let finishTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const tools = new ToolCatalog();
    tools.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'wait_tool', description: 'wait', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        await toolGate;
        return { ok: true };
      },
    });
    const update = vi.fn(async () => undefined);
    const server = await fixture(undefined, { tools, update, executorVersion: '1.0.0' });
    fixtures.push(server);

    const execution = await server.request('/api/executions/tool-during-update', {
      toolName: 'wait_tool',
      arguments: {},
      workspacePath: '',
    });
    expect(execution.status).toBe(202);
    const response = await fetch(`http://127.0.0.1:${server.server.port}/api/update`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-pico-executor-version': '1.0.1',
      },
      body: Buffer.from('bundle'),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'executor_busy' });
    expect(update).not.toHaveBeenCalled();
    finishTool();
  });

  it('fences new tool admissions as soon as a valid update is accepted', async () => {
    let finishUpdate!: () => void;
    let updateStarted!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const update = vi.fn(async () => {
      updateStarted();
      await updateGate;
    });
    const tools = new ToolCatalog();
    const execute = vi.fn(async () => ({ ok: true }));
    tools.register({
      owner: 'test',
      source: 'executor',
      definition: { name: 'quick_tool', description: 'quick', parameters: { type: 'object', properties: {} } },
      execute,
    });
    const server = await fixture(undefined, { tools, update, executorVersion: '1.0.0' });
    fixtures.push(server);
    const updateResponsePromise = fetch(`http://127.0.0.1:${server.server.port}/api/update`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-pico-executor-version': '1.0.1',
      },
      body: Buffer.from('bundle'),
    });
    await started;

    const execution = await server.request('/api/executions/tool-after-update', {
      toolName: 'quick_tool',
      arguments: {},
      workspacePath: '',
    });
    expect(execution.status).toBe(409);
    await expect(execution.json()).resolves.toMatchObject({ code: 'executor_updating' });
    expect(execute).not.toHaveBeenCalled();

    finishUpdate();
    expect((await updateResponsePromise).status).toBe(200);
  });
});
