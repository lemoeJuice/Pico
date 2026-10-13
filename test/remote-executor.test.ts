import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { startRemoteExecutorServer } from '../src/executor/remote-server.js';
import { PicoRuntime } from '../src/runtime/runtime.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

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

describe('Remote Host Executor', () => {
  it('authenticates, confines selected workspaces, and deduplicates durable execution IDs', async () => {
    const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), 'pico-remote-executor-')),
    );
    const workspaceRoot = join(directory, 'workspaces');
    const workspace = join(workspaceRoot, 'project');
    const outside = join(directory, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    const databasePath = join(directory, 'executor.sqlite');
    let server = await startRemoteExecutorServer({ token, workspaceRoot, databasePath, port: 0 });
    let baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${baseUrl}/api/info`)).status).toBe(401);
      const info = await getJson<{ kind: string; workspaceRoot: string; tools: Array<{ name: string }> }>(
        `${baseUrl}/api/info`,
        token,
      );
      expect(info.kind).toBe('host');
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
      expect(accepted.status).toBe(202);
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
    const env = await setupRuntime(model);
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
      expect(thread.executorRemote).toBe(true);
      expect(thread.workspacePath).toBe(remoteWorkspace);
      env.runtime.setToolPermission(thread.id, 'read_file', 'allow');

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
    const env = await setupRuntime(model);
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(
        env.project.id,
        connection.id,
        remoteWorkspace,
        'Existing work',
      );
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
      env.runtime.setToolPermission(thread.id, 'read_file', 'allow');

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
    const env = await setupRuntime(model);
    try {
      const connection = await env.runtime.addRemoteExecutorConnection(
        'Build host',
        `http://127.0.0.1:${remote.port}`,
        token,
      );
      const thread = await env.runtime.createRemoteThread(env.project.id, connection.id, remoteWorkspace);
      env.runtime.setToolPermission(thread.id, 'shell', 'allow');
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
        toolCalls: [{ call, executionId: `${thread.id}:lost-remote-model:lost-remote-call` }],
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

  it('keeps a Remote execution running through a dropped status connection and resumes the same ID', async () => {
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
    const env = await setupRuntime(model);
    const originalFetch = globalThis.fetch;
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Build host', endpoint, token);
      const thread = await env.runtime.createRemoteThread(env.project.id, connection.id, remoteWorkspace);
      env.runtime.setToolPermission(thread.id, 'shell', 'allow');

      let acceptedRemoteSubmission = false;
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
          return result;
        }
        if (
          acceptedRemoteSubmission &&
          requestUrl.origin === endpoint &&
          requestUrl.pathname.startsWith('/api/executions/')
        ) {
          throw new TypeError('Simulated temporary Remote Executor connection loss.');
        }
        return originalFetch(input, init);
      };

      await env.runtime.submit(thread.id, 'remote-reconnect-message', 'Run and recover the remote command.');
      await env.runtime.drain();
      await until(() => {
        const execution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool');
        return env.runtime.getThread(thread.id)?.state === 'paused' && execution?.status === 'running';
      });
      const toolExecution = env.store.listExecutions(thread.id).find((item) => item.kind === 'tool');
      expect(toolExecution?.status).toBe('running');
      expect(env.runtime.getThread(thread.id)?.pauseReason).toContain('Tool Batch returned');

      globalThis.fetch = originalFetch;
      env.runtime.continue(thread.id);
      await env.runtime.drain();

      expect(env.store.getExecution(toolExecution!.id)?.status).toBe('completed');
      expect(await readFile(join(remoteWorkspace, 'runs.log'), 'utf8')).toBe('x');
      expect(model.calls).toBe(2);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
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
      const thread = await runtime.createRemoteThread(project.id, connection.id, remoteWorkspace);
      runtime.setToolPermission(thread.id, 'shell', 'allow');
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
      const thread = await runtime.createRemoteThread(project.id, connection.id, remoteWorkspace);
      runtime.setToolPermission(thread.id, 'shell', 'allow');
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
    const env = await setupRuntime(model);
    try {
      const connection = await env.runtime.addRemoteExecutorConnection(
        'Build host',
        `http://127.0.0.1:${remote.port}`,
        token,
      );
      const thread = await env.runtime.createRemoteThread(env.project.id, connection.id, remoteWorkspace);
      env.runtime.setToolPermission(thread.id, 'shell', 'allow');
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
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
    } finally {
      await env.cleanup();
      await remote.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
