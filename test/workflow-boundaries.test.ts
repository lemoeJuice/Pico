import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PicoPlugin } from '../src/plugins/host.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

const remoteToken = 'pico-workflow-boundary-remote-token-0123456789';
const remoteTool = {
  name: 'remote_custom',
  description: 'A tool defined only by the Remote Executor.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string', enum: ['from-remote'] } },
    required: ['value'],
    additionalProperties: false,
  },
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeExecutorPlugin(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.mjs`), body, 'utf8');
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function startRemoteSchemaServer() {
  const executions: Array<{ toolName: string; arguments: Record<string, unknown>; workspacePath: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${remoteToken}`)
      return json(response, { error: 'unauthorized' }, 401);
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/api/info') {
      return json(response, {
        protocolVersion: 1,
        name: 'Custom schema endpoint',
        kind: 'host',
        workspaceRoot: '/remote-workspaces',
        tools: [remoteTool],
      });
    }
    if (request.method === 'POST' && path === '/api/workspaces/validate') {
      const body = await readRequest(request);
      return json(response, { path: body.path });
    }
    const execution = /^\/api\/executions\/([^/]+)$/.exec(path);
    if (request.method === 'POST' && execution) {
      const body = await readRequest(request);
      const record = {
        toolName: String(body.toolName),
        arguments: body.arguments as Record<string, unknown>,
        workspacePath: String(body.workspacePath),
      };
      executions.push(record);
      return json(response, {
        id: decodeURIComponent(execution[1]!),
        status: 'completed',
        result: { ...record, serverDefined: true },
      });
    }
    return json(response, { error: `unexpected ${request.method} ${path}` }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Remote schema server did not bind a TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    executions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('workflow plugin boundaries', () => {
  it('replaces disabled built-ins with same-ID plugins without loading their UI, routes, command, or hook', async () => {
    const legacyContext = 'This stale Project Context must not be projected.';
    const replacementPermissions: PicoPlugin = {
      id: 'pico.permissions',
      name: 'Replacement permissions plugin',
      version: '1',
      activate({ http, ui }) {
        http.register('GET', '/replacement', () => ({ replacement: true }));
        ui.contribute({
          slot: 'thread.toolbar',
          id: 'replacement-permissions',
          label: 'Replacement permissions',
          entry: 'webui',
          component: 'ReplacementPermissions',
        });
      },
    };
    const replacementProjectContext: PicoPlugin = {
      id: 'pico.project-context',
      name: 'Replacement project context plugin',
      version: '1',
      activate() {},
    };
    const model = new FakeModel(() => response('No legacy hook ran.'));
    const env = await setupRuntime(model, {
      disabledBuiltinPlugins: ['pico.permissions', 'pico.project-context'],
      plugins: [replacementPermissions, replacementProjectContext],
    });
    const thread = env.runtime.createThread(env.project.id, 'runtime', 'Boundary thread');
    env.store.setPluginState('pico.project-context', 'byProject', {
      [env.project.id]: { text: legacyContext, revision: 1 },
    });
    try {
      const info = env.runtime.pluginInfo();
      expect(info.plugins.map((plugin) => plugin.id)).toContain('pico.permissions');
      expect(info.plugins.map((plugin) => plugin.id)).toContain('pico.project-context');
      expect(info.ui.map((contribution) => contribution.id)).toContain('pico.permissions:replacement-permissions');
      expect(info.ui.map((contribution) => contribution.id)).not.toContain('pico.permissions:permissions');
      expect(info.ui.map((contribution) => contribution.id)).not.toContain('pico.project-context:project-context');
      expect(env.runtime.availableCommands().map((command) => command.name)).not.toContain('permissions');
      expect(env.runtime.availableCommands().map((command) => command.name)).not.toContain('project-context');
      expect(env.runtime.pluginHttpRoute('pico.permissions', 'GET', '/threads')).toBeUndefined();
      expect(env.runtime.pluginHttpRoute('pico.permissions', 'GET', '/replacement')).toBeDefined();

      await env.runtime.submit(thread.id, 'replacement-plugin-message', 'Check plugin replacement.');
      await env.runtime.drain();
      expect(model.prompts[0]?.system).not.toContain(legacyContext);
      expect(model.prompts[0]?.system).not.toContain('User-maintained Project Context');
    } finally {
      await env.cleanup();
    }
  });

  it('exposes and executes tools from any Runtime plugin in Chat mode', async () => {
    const customRuntimeTool: PicoPlugin = {
      id: 'test.runtime-tools',
      name: 'Runtime tool fixture',
      version: '1',
      activate({ tools }) {
        tools.register(
          {
            name: 'runtime_echo',
            description: 'Return the supplied value from a Runtime plugin.',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string', enum: ['chat-value'] } },
              required: ['value'],
              additionalProperties: false,
            },
          },
          async (args) => ({ echoed: args.value, source: 'runtime-plugin' }),
        );
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'chat-runtime-tool', name: 'runtime_echo', arguments: { value: 'chat-value' } }])
        : response('The Runtime plugin tool ran in Chat mode.'),
    );
    const env = await setupRuntime(model, { plugins: [customRuntimeTool] });
    const thread = env.runtime.createThread(env.project.id, 'runtime', 'Chat tools');
    try {
      await env.runtime.submit(thread.id, 'chat-runtime-plugin-message', 'Run the Runtime plugin tool.');
      await env.runtime.drain();

      expect(model.prompts[0]?.tools.map((tool) => tool.name)).toContain('runtime_echo');
      expect(
        env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'runtime_echo'),
      ).toMatchObject({
        status: 'completed',
        result: { echoed: 'chat-value', source: 'runtime-plugin' },
      });
      expect(
        model.prompts[1]?.turns.some((turn) => turn.kind === 'tool_result' && turn.content.includes('runtime-plugin')),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('discovers and executes Host executor plugin tools that are absent from the Runtime catalog', async () => {
    const executorPluginDirectory = await temporaryDirectory('pico-host-plugin-boundary-');
    await writeExecutorPlugin(
      executorPluginDirectory,
      'executor-echo',
      `export default {
        id: 'test.executor-echo', name: 'Executor echo', version: '1',
        activateExecutor({ tools }) {
          tools.register({
            name: 'executor_echo',
            description: 'Echo through a Host Executor plugin.',
            parameters: { type: 'object', properties: { value: { type: 'string', enum: ['host-value'] } }, required: ['value'], additionalProperties: false }
          }, async (args, context) => ({ echoed: args.value, workspacePath: context.workspacePath }));
        }
      };`,
    );
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'host-executor-plugin', name: 'executor_echo', arguments: { value: 'host-value' } }])
        : response('The Host Executor plugin tool ran.'),
    );
    const env = await setupRuntime(model, { executorPluginDirectory });
    const thread = env.createThread('host');
    env.store.setPluginState('pico.permissions', 'rules', { [thread.id]: { executor_echo: 'allow' } });
    try {
      await env.runtime.submit(thread.id, 'host-executor-plugin-message', 'Run the Host Executor plugin tool.');
      await env.runtime.drain();

      const offered = model.prompts[0]?.tools.find((tool) => tool.name === 'executor_echo');
      expect(offered?.parameters).toMatchObject({
        properties: { value: { type: 'string', enum: ['host-value'] } },
      });
      expect(env.runtime.tools.get('executor_echo')).toBeUndefined();
      expect(
        env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'executor_echo'),
      ).toMatchObject({
        status: 'completed',
        result: { echoed: 'host-value', workspacePath: env.workspace },
      });
    } finally {
      await env.cleanup();
    }
  });

  it('discovers and executes Remote Executor schemas without a local Tool definition', async () => {
    const remote = await startRemoteSchemaServer();
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'remote-custom-tool', name: 'remote_custom', arguments: { value: 'from-remote' } }])
        : response('The Remote Executor custom tool ran.'),
    );
    const env = await setupRuntime(model);
    try {
      const connection = await env.runtime.addRemoteExecutorConnection('Custom remote', remote.url, remoteToken);
      const thread = await env.runtime.createRemoteThread(env.project.id, connection.id, '/remote-workspaces/project');
      env.store.setPluginState('pico.permissions', 'rules', { [thread.id]: { remote_custom: 'allow' } });

      await env.runtime.submit(thread.id, 'remote-custom-tool-message', 'Run the remote custom tool.');
      await env.runtime.drain();

      expect(model.prompts[0]?.tools.find((tool) => tool.name === 'remote_custom')?.parameters).toMatchObject(
        remoteTool.parameters,
      );
      expect(env.runtime.tools.get('remote_custom')).toBeUndefined();
      expect(remote.executions).toEqual([
        {
          toolName: 'remote_custom',
          arguments: { value: 'from-remote' },
          workspacePath: '/remote-workspaces/project',
        },
      ]);
      expect(
        env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'remote_custom'),
      ).toMatchObject({
        status: 'completed',
        result: expect.objectContaining({ serverDefined: true, toolName: 'remote_custom' }),
      });
    } finally {
      await env.cleanup();
      await remote.close();
    }
  });

  it('does not emit plugin.updated when the permissions Tool list is read', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.createThread('host');
    const events: Array<{ type: string; pluginId?: string }> = [];
    const unsubscribe = env.runtime.subscribe((event) => {
      if (event.type === 'plugin.updated') events.push(event);
    });
    try {
      const route = env.runtime.pluginHttpRoute('pico.permissions', 'GET', '/threads');
      expect(route).toBeDefined();
      const result = (await route!.handler({
        body: undefined,
        query: new URLSearchParams({ threadId: thread.id }),
        origin: null,
      })) as { threadId: string; tools: Array<{ name: string; policy: string }> };
      expect(result.threadId).toBe(thread.id);
      expect(result.tools.map((tool) => tool.name)).toContain('read_file');
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });
});
