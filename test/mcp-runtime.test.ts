import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import type { Execution, Thread, ToolCall } from '../src/core/types.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { isPublicNetworkAddress, McpManager, resolveMcpTarget } from '../src/runtime/mcp-manager.js';
import { assistantPayload, FakeModel, response, setupRuntime } from './helpers.js';

const sampleTool = {
  name: 'echo_value',
  description: 'Return a value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};

function fakeDependencies() {
  const transports: Array<{
    onclose?: () => void;
    onerror?: (error: Error) => void;
    stderr: PassThrough;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const clients: Array<{
    onToolsChanged(error: Error | null, tools?: unknown[]): void;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const stdioInputs: Array<{ command: string; args: string[]; cwd?: string; env: Record<string, string> }> = [];
  const httpInputs: Array<{ url: URL; bearerToken?: string }> = [];
  const lifecycle: {
    blockNextConnect: boolean;
    cancelConnect: ((error: Error) => void) | null;
    blockNextListTools: boolean;
    nextListToolsError: Error | null;
  } = {
    blockNextConnect: false,
    cancelConnect: null,
    blockNextListTools: false,
    nextListToolsError: null,
  };
  const dependencies = {
    createClient: (options: { onToolsChanged(error: Error | null, tools?: unknown[]): void }) => {
      const client = {
        onToolsChanged: options.onToolsChanged,
        connect: vi.fn(async () => {
          if (lifecycle.blockNextConnect) {
            lifecycle.blockNextConnect = false;
            await new Promise<void>((resolve, reject) => {
              lifecycle.cancelConnect = (error) => reject(error);
              void resolve;
            });
          }
        }),
        close: vi.fn(async () => {
          lifecycle.cancelConnect?.(new Error('connection closed'));
          lifecycle.cancelConnect = null;
          transports.at(-1)?.onclose?.();
        }),
        listTools: vi.fn(async (_params?: undefined, options?: { signal?: AbortSignal }) => {
          if (lifecycle.blockNextListTools) {
            lifecycle.blockNextListTools = false;
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('tool discovery aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          if (lifecycle.nextListToolsError) {
            const error = lifecycle.nextListToolsError;
            lifecycle.nextListToolsError = null;
            throw error;
          }
          return { tools: [sampleTool] };
        }),
        callTool: vi.fn(async () => ({
          content: [{ type: 'text', text: 'echoed configured credential: env-secret-value and xy' }],
        })),
      };
      clients.push(client);
      return client as never;
    },
    createStdioTransport: (input: { command: string; args: string[]; cwd?: string; env: Record<string, string> }) => {
      stdioInputs.push(input);
      const transport = {
        stderr: new PassThrough(),
        close: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
      };
      transports.push(transport);
      return transport as never;
    },
    createHttpTransport: (input: { url: URL; bearerToken?: string }) => {
      httpInputs.push(input);
      const transport = {
        stderr: new PassThrough(),
        close: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
      };
      transports.push(transport);
      return transport as never;
    },
  };
  return { dependencies, transports, clients, stdioInputs, httpInputs, lifecycle };
}

function managerFor(store: PicoStore, catalog = new ToolCatalog()) {
  const fake = fakeDependencies();
  const events: Array<Record<string, unknown>> = [];
  const manager = new McpManager(store, catalog, (event) => events.push(event), fake.dependencies);
  return { manager, catalog, events, ...fake };
}

describe('Runtime MCP manager', () => {
  it('keeps durable MCP tool calls from falling back to an Executor after disconnect', async () => {
    const env = await setupRuntime(new FakeModel(() => response()), { disabledBuiltinPlugins: ['pico.permissions'] });
    const thread = env.createThread('host');
    try {
      const modelExecutionId = 'mcp-disconnected-model';
      env.store.createModelExecution(modelExecutionId, thread.id, 0);
      env.store.transitionExecution(modelExecutionId, 'running');
      const call = { id: 'mcp-disconnected-call', name: 'mcp_server_tool', arguments: {} };
      const executionId = `${thread.id}:${modelExecutionId}:${call.id}`;
      env.store.commitModelStep({
        assistantRecordId: `${modelExecutionId}:assistant`,
        modelExecutionId,
        threadId: thread.id,
        payload: assistantPayload({ toolCalls: [call], batchId: `${modelExecutionId}:batch` }),
        toolCalls: [{ call, executionId, source: 'mcp' }],
      });

      const runtime = env.runtime as unknown as {
        executeToolCall(thread: Thread, call: ToolCall): Promise<Execution>;
      };
      const execution = await runtime.executeToolCall(thread, call);
      expect(execution.status).toBe('failed');
      expect(execution.error).toMatch(/MCP server.*no longer connected/);
      expect(env.store.listExecutionLog(executionId, 'tool-source')).toMatchObject([{ detail: { source: 'mcp' } }]);
    } finally {
      await env.cleanup();
    }
  });

  it('stores local credentials privately, requires first launch confirmation, and exposes the discovered tools', async () => {
    const store = new PicoStore(':memory:');
    const { manager, catalog, stdioInputs, clients, transports } = managerFor(store);
    try {
      const created = await manager.create({
        name: 'Local utilities',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        cwd: '/tmp/mcp-local',
        env: { MCP_PASSWORD: 'env-secret-value', SHORT_SECRET: 'xy' },
        autoStart: true,
      });
      expect(created).toMatchObject({
        status: 'stopped',
        autoStart: true,
        localExecutionConfirmed: false,
        envKeys: ['MCP_PASSWORD', 'SHORT_SECRET'],
      });
      expect(created.executionFingerprint).toEqual(expect.any(String));
      expect(JSON.stringify(created)).not.toContain('env-secret-value');
      expect(JSON.stringify(store.getSetting('mcp-servers', []))).not.toContain('env-secret-value');
      expect(store.getPrivateSecret('pico.mcp', created.id, {})).toEqual({
        env: { MCP_PASSWORD: 'env-secret-value', SHORT_SECRET: 'xy' },
      });
      expect(stdioInputs).toHaveLength(0);
      const unapprovedAutoStart = managerFor(store);
      await unapprovedAutoStart.manager.startAutoStarted();
      expect(unapprovedAutoStart.stdioInputs).toHaveLength(0);
      await unapprovedAutoStart.manager.shutdown();
      await expect(manager.start(created.id)).rejects.toThrow(/explicit execution confirmation/);
      expect(stdioInputs).toHaveLength(0);

      const started = await manager.start(created.id, {
        confirmLocalExecution: true,
        executionFingerprint: created.executionFingerprint!,
      });
      expect(started).toMatchObject({
        status: 'ready',
        localExecutionConfirmed: true,
        tools: [{ name: sampleTool.name, description: sampleTool.description }],
      });
      expect(stdioInputs[0]).toMatchObject({
        command: 'node',
        args: ['server.js'],
        cwd: '/tmp/mcp-local',
        env: { MCP_PASSWORD: 'env-secret-value' },
      });
      expect(catalog.listBySource('mcp')).toHaveLength(1);
      const registered = catalog.listBySource('mcp')[0]!;
      expect(registered.definition.name).toBe('local_utilities__echo_value');
      expect(registered.definition.name.length).toBeLessThanOrEqual(64);
      const result = await registered.execute({ value: 'hello' }, {
        thread: {},
        workspacePath: '/tmp',
        executionId: 'mcp-execution',
        signal: new AbortController().signal,
      } as never);
      expect(clients[0]?.callTool).toHaveBeenCalledWith(
        { name: 'echo_value', arguments: { value: 'hello' } },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(JSON.stringify(result)).not.toContain('env-secret-value');
      expect(JSON.stringify(result)).not.toContain('xy');
      expect(result).toMatchObject({
        content: [{ text: 'echoed configured credential: [redacted] and [redacted]' }],
      });

      clients[0]?.callTool.mockRejectedValueOnce(new Error('remote tool error env-secret-value xy'));
      await expect(
        registered.execute({ value: 'hello' }, {
          thread: {},
          workspacePath: '/tmp',
          executionId: 'mcp-execution',
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow('remote tool error [redacted] [redacted]');

      transports[0]?.stderr.write('startup failed while using env-secret-value and xy');
      transports[0]?.onclose?.();
      expect(manager.list()[0]).toMatchObject({
        status: 'failed',
        lastError: 'startup failed while using [redacted] and [redacted]',
        tools: [],
      });
      expect(catalog.listBySource('mcp')).toHaveLength(0);

      const nextManager = managerFor(store);
      await nextManager.manager.startAutoStarted();
      expect(nextManager.stdioInputs).toHaveLength(1);
      expect(nextManager.manager.list()[0]?.status).toBe('ready');
      await nextManager.manager.shutdown();
      expect(nextManager.manager.list()[0]?.status).toBe('stopped');
      expect(transports).toHaveLength(1);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('keeps bearer tokens out of views and settings, preserves omitted tokens, and clears only explicit empty tokens', async () => {
    const store = new PicoStore(':memory:');
    const { manager, httpInputs } = managerFor(store);
    try {
      const created = await manager.create({
        name: 'Remote tools',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp?tenant=acme',
        bearerToken: 'remote-token-value',
      });
      expect(created).toMatchObject({
        status: 'stopped',
        hasToken: true,
        url: 'https://mcp.example.test/mcp?tenant=%5Bredacted%5D',
      });
      expect(JSON.stringify(created)).not.toContain('remote-token-value');
      expect(JSON.stringify(store.getSetting('mcp-servers', []))).not.toContain('remote-token-value');
      expect(store.getPrivateSecret('pico.mcp', created.id, {})).toEqual({ bearerToken: 'remote-token-value' });

      const updated = await manager.update(created.id, {
        name: 'Remote tools',
        transport: 'streamable-http',
        url: created.url!,
      });
      expect(updated.hasToken).toBe(true);
      expect(updated.url).toBe('https://mcp.example.test/mcp?tenant=%5Bredacted%5D');
      const started = await manager.start(created.id);
      expect(started.status).toBe('ready');
      expect(httpInputs[0]?.bearerToken).toBe('remote-token-value');

      const cleared = await manager.update(created.id, {
        name: 'Remote tools',
        transport: 'streamable-http',
        url: created.url!,
        bearerToken: '',
      });
      expect(cleared.hasToken).toBe(false);
      expect(store.getPrivateSecret('pico.mcp', created.id, {})).toEqual({});
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('rolls back MCP config and secret changes together when any persistence step fails', async () => {
    const store = new PicoStore(':memory:');
    const { manager, events } = managerFor(store);
    const originalSetPrivateSecret = store.setPrivateSecret.bind(store);
    const originalSetSetting = store.setSetting.bind(store);
    const originalDeletePrivateSecret = store.deletePrivateSecret.bind(store);
    let failedCreateSecretKey: string | undefined;
    try {
      vi.spyOn(store, 'setPrivateSecret').mockImplementation(((owner: string, key: string, value: unknown) => {
        failedCreateSecretKey = key;
        originalSetPrivateSecret(owner, key, value);
        throw new Error('injected private secret write failure');
      }) as typeof store.setPrivateSecret);
      await expect(
        manager.create({
          name: 'Create rollback',
          transport: 'streamable-http',
          url: 'https://mcp.example.test/create',
          bearerToken: 'create-secret',
        }),
      ).rejects.toThrow('injected private secret write failure');
      expect(store.getSetting('mcp-servers', [])).toEqual([]);
      expect(failedCreateSecretKey).toEqual(expect.any(String));
      expect(store.getPrivateSecret('pico.mcp', failedCreateSecretKey!, {})).toEqual({});
      expect(events).toEqual([]);

      vi.restoreAllMocks();
      const existing = await manager.create({
        name: 'Update rollback',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/update',
        bearerToken: 'old-secret',
      });
      vi.spyOn(store, 'setSetting').mockImplementation(((key: string, value: unknown) => {
        originalSetSetting(key, value);
        throw new Error('injected config write failure');
      }) as typeof store.setSetting);
      await expect(
        manager.update(existing.id, {
          name: 'Updated name',
          transport: 'streamable-http',
          url: existing.url!,
          bearerToken: 'new-secret',
        }),
      ).rejects.toThrow('injected config write failure');
      expect(store.getSetting('mcp-servers', [])).toMatchObject([{ id: existing.id, name: 'Update rollback' }]);
      expect(store.getPrivateSecret('pico.mcp', existing.id, {})).toEqual({ bearerToken: 'old-secret' });

      vi.restoreAllMocks();
      vi.spyOn(store, 'deletePrivateSecret').mockImplementation(((owner: string, key: string) => {
        originalDeletePrivateSecret(owner, key);
        throw new Error('injected private secret delete failure');
      }) as typeof store.deletePrivateSecret);
      await expect(manager.delete(existing.id)).rejects.toThrow('injected private secret delete failure');
      expect(store.getSetting('mcp-servers', [])).toMatchObject([{ id: existing.id, name: 'Update rollback' }]);
      expect(store.getPrivateSecret('pico.mcp', existing.id, {})).toEqual({ bearerToken: 'old-secret' });
    } finally {
      vi.restoreAllMocks();
      await manager.shutdown();
      store.close();
    }
  });

  it('rejects credentials in URLs and removes tools when a managed connection closes', async () => {
    const store = new PicoStore(':memory:');
    const { manager, catalog, transports } = managerFor(store);
    try {
      await expect(
        manager.create({
          name: 'Bad URL',
          transport: 'streamable-http',
          url: 'https://user:password@mcp.example.test/mcp',
        }),
      ).rejects.toThrow(/embedded credentials/);
      await expect(
        manager.create({
          name: 'Bad query',
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp?access_token=secret',
        }),
      ).rejects.toThrow(/not in the URL query/);

      const server = await manager.create({
        name: 'Remote tools',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      });
      await manager.start(server.id);
      expect(catalog.listBySource('mcp')).toHaveLength(1);
      transports[0]?.onclose?.();
      expect(manager.list()[0]).toMatchObject({
        status: 'failed',
        lastError: 'MCP server connection closed unexpectedly.',
        tools: [],
      });
      expect(catalog.listBySource('mcp')).toHaveLength(0);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('blocks private/reserved IPs by default while allowing public addresses', () => {
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
    for (const address of [
      '127.0.0.1',
      '10.20.30.40',
      '169.254.1.2',
      '100.64.0.1',
      '192.0.2.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicNetworkAddress(address), address).toBe(false);
    }
  });

  it('requires private-network opt-in and HTTPS for bearer authentication', async () => {
    await expect(resolveMcpTarget(new URL('http://127.0.0.1:3030/mcp'), false)).rejects.toThrow(
      /Enable private-network access/,
    );
    await expect(resolveMcpTarget(new URL('http://127.0.0.1:3030/mcp'), true)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ]);

    const store = new PicoStore(':memory:');
    const { manager, httpInputs } = managerFor(store);
    try {
      await expect(
        manager.create({
          name: 'Insecure token endpoint',
          transport: 'streamable-http',
          url: 'http://mcp.example.test/mcp',
          bearerToken: 'cleartext-token',
        }),
      ).rejects.toThrow(/require HTTPS/);
      const server = await manager.create({
        name: 'Local HTTP MCP',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:3030/mcp',
        confirmPrivateNetworkAccess: true,
      });
      expect(server).toMatchObject({ privateNetworkConfirmed: true });
      await manager.start(server.id);
      expect(httpInputs[0]).toMatchObject({ allowPrivate: true });
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('redacts URL query values, rejects key credentials, and binds private access to the server origin', async () => {
    const store = new PicoStore(':memory:');
    const { manager } = managerFor(store);
    try {
      await expect(
        manager.create({
          name: 'Query credential',
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp?key=short',
        }),
      ).rejects.toThrow(/Bearer token field/);
      for (const argument of ['--token=short', '--access-token=short', '--api-token=short', '--private-key=short']) {
        await expect(
          manager.create({
            name: 'Argument credential',
            transport: 'stdio',
            command: 'node',
            args: [argument],
          }),
        ).rejects.toThrow(/environment variables/);
      }

      const publicServer = await manager.create({
        name: 'Query parameters',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp?tenant=private-value&region=west',
      });
      expect(publicServer.url).toBe('https://mcp.example.test/mcp?tenant=%5Bredacted%5D&region=%5Bredacted%5D');
      expect(publicServer.url).not.toContain('private-value');

      const localServer = await manager.create({
        name: 'Local server',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:3000/mcp',
        confirmPrivateNetworkAccess: true,
      });
      expect(localServer.privateNetworkConfirmed).toBe(true);
      const sameOrigin = await manager.update(localServer.id, {
        name: localServer.name,
        transport: 'streamable-http',
        url: 'http://127.0.0.1:3000/mcp/v2',
      });
      expect(sameOrigin.privateNetworkConfirmed).toBe(true);
      const changedOrigin = await manager.update(localServer.id, {
        name: localServer.name,
        transport: 'streamable-http',
        url: 'http://10.0.0.2:3000/mcp',
      });
      expect(changedOrigin.privateNetworkConfirmed).toBe(false);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('binds stdio execution consent to its current configuration and rejects startup failures', async () => {
    const store = new PicoStore(':memory:');
    const { manager, lifecycle } = managerFor(store);
    try {
      const server = await manager.create({
        name: 'Local runner',
        transport: 'stdio',
        command: 'node',
        args: ['one.js'],
        env: { SHORT_SECRET: 'xy' },
      });
      const edited = await manager.update(server.id, {
        name: 'Local runner',
        transport: 'stdio',
        command: 'node',
        args: ['two.js'],
      });
      await expect(
        manager.start(server.id, {
          confirmLocalExecution: true,
          executionFingerprint: server.executionFingerprint!,
        }),
      ).rejects.toThrow(/changed after confirmation/);
      await expect(
        manager.start(server.id, {
          confirmLocalExecution: true,
          executionFingerprint: edited.executionFingerprint!,
        }),
      ).resolves.toMatchObject({ status: 'ready' });
      await manager.stop(server.id);
      lifecycle.nextListToolsError = new Error('remote list failure xy');
      await expect(
        manager.start(server.id, {
          confirmLocalExecution: true,
          executionFingerprint: edited.executionFingerprint!,
        }),
      ).rejects.toThrow('remote list failure [redacted]');
      expect(manager.list()[0]).toMatchObject({ status: 'failed', lastError: 'remote list failure [redacted]' });
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('invalidates stdio consent when the inherited executable search path changes', async () => {
    const store = new PicoStore(':memory:');
    const { manager } = managerFor(store);
    const originalPath = process.env.PATH;
    try {
      const server = await manager.create({ name: 'Local runner', transport: 'stdio', command: 'node' });
      process.env.PATH = '/tmp/pico-empty-mcp-path';
      expect(manager.list()[0]?.executionFingerprint).not.toBe(server.executionFingerprint);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await manager.shutdown();
      store.close();
    }
  });

  it('serializes stop and restart while connection setup is pending', async () => {
    const store = new PicoStore(':memory:');
    const { manager, lifecycle, clients, stdioInputs } = managerFor(store);
    try {
      const server = await manager.create({ name: 'Local runner', transport: 'stdio', command: 'node' });
      const queuedStart = manager.start(server.id, {
        confirmLocalExecution: true,
        executionFingerprint: server.executionFingerprint!,
      });
      const queuedStop = manager.stop(server.id);
      await expect(queuedStart).rejects.toThrow(/start was stopped/);
      await expect(queuedStop).resolves.toMatchObject({ status: 'stopped' });
      expect(stdioInputs).toHaveLength(0);

      lifecycle.blockNextConnect = true;
      const start = manager.start(server.id, {
        confirmLocalExecution: true,
        executionFingerprint: server.executionFingerprint!,
      });
      await vi.waitFor(() => expect(lifecycle.cancelConnect).toBeTypeOf('function'));
      const stop = manager.stop(server.id);
      const restart = manager.start(server.id, {
        confirmLocalExecution: true,
        executionFingerprint: server.executionFingerprint!,
      });
      await expect(start).rejects.toThrow(/start was stopped/);
      await expect(stop).resolves.toMatchObject({ status: 'stopped' });
      await expect(restart).resolves.toMatchObject({ status: 'ready' });
      expect(clients).toHaveLength(2);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('aborts timed tool discovery when stop arrives after connect', async () => {
    const store = new PicoStore(':memory:');
    const { manager, lifecycle, clients } = managerFor(store);
    try {
      const server = await manager.create({ name: 'Local runner', transport: 'stdio', command: 'node' });
      lifecycle.blockNextListTools = true;
      const start = manager.start(server.id, {
        confirmLocalExecution: true,
        executionFingerprint: server.executionFingerprint!,
      });
      await vi.waitFor(() => expect(clients[0]?.listTools).toHaveBeenCalled());
      const stop = manager.stop(server.id);
      await expect(start).rejects.toThrow(/start was stopped/);
      await expect(stop).resolves.toMatchObject({ status: 'stopped' });
      const discoveryOptions = clients[0]?.listTools.mock.calls[0]?.[1] as
        { signal?: AbortSignal; timeout?: number } | undefined;
      expect(discoveryOptions?.timeout).toEqual(expect.any(Number));
      expect(discoveryOptions?.signal?.aborted).toBe(true);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });

  it('aborts and awaits active tool calls before stopping a server', async () => {
    const store = new PicoStore(':memory:');
    const { manager, catalog, clients } = managerFor(store);
    try {
      const server = await manager.create({ name: 'Local runner', transport: 'stdio', command: 'node' });
      await manager.start(server.id, {
        confirmLocalExecution: true,
        executionFingerprint: server.executionFingerprint!,
      });
      const tool = catalog.listBySource('mcp')[0]!;
      clients[0]?.callTool.mockImplementationOnce(
        (_params, options) =>
          new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (!signal || signal.aborted) reject(new DOMException('aborted', 'AbortError'));
            else
              signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          }),
      );
      const call = tool.execute({ value: 'wait' }, {
        thread: {},
        workspacePath: '/tmp',
        executionId: 'mcp-execution',
        signal: new AbortController().signal,
      } as never);
      await vi.waitFor(() => expect(clients[0]?.callTool).toHaveBeenCalled());
      await expect(manager.stop(server.id)).resolves.toMatchObject({ status: 'stopped' });
      await expect(call).rejects.toThrow();
      expect(catalog.listBySource('mcp')).toHaveLength(0);
    } finally {
      await manager.shutdown();
      store.close();
    }
  });
});
