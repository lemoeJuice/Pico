import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTAINER_RUNNER } from '../src/executor/container-runner.js';
import type { ToolDefinition } from '../src/core/types.js';
import { createToolCatalog } from '../src/executor/tools.js';
import { EXECUTOR_PROTOCOL_VERSION } from '../src/executor/remote-protocol.js';
import { ContainerExecutor } from '../src/executor/container-executor.js';
import { PicoStore } from '../src/core/store.js';

describe('Container Executor plugin runner', () => {
  it('registers the same default tool definitions through its default executor plugin', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', CONTAINER_RUNNER, 'tools', 'catalog-key', '', join(tmpdir(), 'pico-unused'), '/workspace', '/missing'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const runnerTools = JSON.parse(result.stdout).tools;
    const hostTools = createToolCatalog()
      .listBySource('executor')
      .map(({ definition }) => definition);
    expect(runnerTools).toEqual(hostTools);
  });

  it('mounts executor bundles into the controlled container path and discovers that loaded catalog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-container-adapter-tools-'));
    const workspace = join(directory, 'workspace');
    const pluginDirectory = join(directory, 'executor-plugins');
    const executions = join(directory, 'executions');
    await Promise.all([mkdir(workspace), mkdir(pluginDirectory)]);
    await writeFile(
      join(pluginDirectory, 'custom.mjs'),
      `import { writeFile } from 'node:fs/promises';
       export default {
         id: 'test.container-discovery', name: 'Container discovery', version: '1',
         activateExecutor({ tools }) {
           tools.register({ name: 'container_custom', description: 'Container-only tool.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }, async (args, context) => {
             await writeFile(context.workspacePath + '/container-plugin-result.txt', String(args.value));
             return { executionId: context.executionId, value: args.value };
           });
         }
       };
      `,
    );
    const store = new PicoStore(':memory:');
    const project = store.createProject('Container discovery', workspace);
    const thread = store.createThread(project.id, 'container');
    const binding = store.executorForThread(thread.id)!;
    let containerCreated = false;
    let runSubmissions = 0;
    let hostPort: number | undefined;
    let remoteServer: ReturnType<typeof createServer> | undefined;
    let remoteToken: string | undefined;
    let remoteTools: ToolDefinition[] = [];
    const remoteStates = new Map<string, { id: string; status: string; result?: unknown; error?: string }>();
    const mountedPlugins: string[] = [];
    const podman = async (args: string[]) => {
      if (args[0] === 'info') return { stdout: '5.0.0', stderr: '' };
      if (args.includes('inspect')) {
        if (containerCreated) return { stdout: 'true', stderr: '' };
        throw new Error('no such container');
      }
      if (args[0] === 'run') {
        containerCreated = true;
        const pluginVolume = args.find((argument) =>
          argument.startsWith(`${pluginDirectory}:/opt/pico/executor-plugins:`),
        );
        if (pluginVolume) mountedPlugins.push(pluginVolume);
        const portMapping = args[args.indexOf('-p') + 1];
        const match = /^127\.0\.0\.1:(\d+):/.exec(portMapping ?? '');
        if (!match) throw new Error(`Unexpected Container Executor port mapping: ${portMapping ?? 'missing'}`);
        hostPort = Number(match[1]);
        return { stdout: 'container-id', stderr: '' };
      }
      if (args[0] === 'exec' && args.includes('PICO_EXECUTOR_HOST=0.0.0.0')) {
        const tokenEntry = args.find((argument) => argument.startsWith('PICO_EXECUTOR_TOKEN='));
        const token = tokenEntry?.slice('PICO_EXECUTOR_TOKEN='.length);
        if (!hostPort || !token) throw new Error('Container Executor server fixture is missing its port or token.');

        const discovery = spawnSync(
          process.execPath,
          ['-e', CONTAINER_RUNNER, 'tools', 'catalog-key', '', executions, workspace, pluginDirectory],
          { encoding: 'utf8', timeout: 10_000 },
        );
        if (discovery.error) throw discovery.error;
        if (discovery.status !== 0) throw new Error(discovery.stderr);
        const customTool = (JSON.parse(discovery.stdout) as { tools: ToolDefinition[] }).tools.find(
          (tool) => tool.name === 'container_custom',
        );
        if (!customTool) throw new Error('Container runner did not discover the custom plugin tool.');

        remoteTools = createToolCatalog()
          .listBySource('executor')
          .map(({ definition }) => definition)
          .concat(customTool);
        remoteToken = token;
        remoteServer = createServer((request, response) => {
          void (async () => {
            response.setHeader('content-type', 'application/json');
            if (request.headers.authorization !== `Bearer ${remoteToken}`) {
              response.statusCode = 401;
              response.end(JSON.stringify({ error: 'Remote Executor bearer token required.' }));
              return;
            }
            if (request.method === 'GET' && request.url === '/api/info') {
              response.end(
                JSON.stringify({
                  protocolVersion: EXECUTOR_PROTOCOL_VERSION,
                  name: 'Container test fixture',
                  kind: 'executor',
                  workspaceRoot: '/workspace',
                  tools: remoteTools,
                }),
              );
              return;
            }
            const executionPath = /^\/api\/executions\/([^/]+)$/.exec(request.url ?? '');
            if (request.method === 'GET' && executionPath) {
              const state = remoteStates.get(decodeURIComponent(executionPath[1]!));
              if (state) response.end(JSON.stringify(state));
              else {
                response.statusCode = 404;
                response.end(JSON.stringify({ error: 'Execution not found.' }));
              }
              return;
            }
            if (request.method === 'POST' && executionPath) {
              const body = await new Promise<string>((resolve, reject) => {
                let content = '';
                request.setEncoding('utf8');
                request.on('data', (chunk: string) => (content += chunk));
                request.on('end', () => resolve(content));
                request.on('error', reject);
              }).then((content) => JSON.parse(content) as { toolName: string; arguments: Record<string, unknown> });
              const id = decodeURIComponent(executionPath[1]!);
              if (!remoteTools.some((tool) => tool.name === body.toolName)) {
                const state = {
                  id,
                  status: 'failed',
                  error: `Unknown Remote Executor tool: ${body.toolName}`,
                };
                remoteStates.set(id, state);
                response.end(JSON.stringify(state));
                return;
              }
              runSubmissions += 1;
              const result = spawnSync(
                process.execPath,
                ['-e', CONTAINER_RUNNER, 'run', id, body.toolName, executions, workspace, pluginDirectory, id],
                { encoding: 'utf8', timeout: 10_000, input: JSON.stringify(body.arguments) },
              );
              if (result.error) throw result.error;
              if (result.status !== 0) throw new Error(result.stderr);
              const runnerResponse = JSON.parse(result.stdout) as {
                status: string;
                result?: unknown;
                error?: string;
              };
              const state = {
                id,
                status: runnerResponse.status,
                ...(Object.hasOwn(runnerResponse, 'result') ? { result: runnerResponse.result } : {}),
                ...(runnerResponse.error ? { error: runnerResponse.error } : {}),
              };
              remoteStates.set(id, state);
              response.end(JSON.stringify(state));
              return;
            }
            response.statusCode = 404;
            response.end(JSON.stringify({ error: 'Not found.' }));
          })().catch((error: unknown) => {
            response.statusCode = 500;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          });
        });
        await new Promise<void>((resolve, reject) => {
          remoteServer!.once('error', reject);
          remoteServer!.listen(hostPort, '127.0.0.1', () => resolve());
        });
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'exec') return { stdout: '', stderr: '' };
      throw new Error(`Unexpected Podman command: ${args[0] ?? 'empty'}`);
    };
    const executor = new ContainerExecutor(
      store,
      createToolCatalog(),
      undefined,
      undefined,
      podman,
      '',
      undefined,
      pluginDirectory,
    );
    try {
      const tools = await executor.listTools(binding);
      expect(tools.map((tool) => tool.name)).toContain('container_custom');
      expect(tools.map((tool) => tool.name)).toContain('read_file');
      expect(mountedPlugins).toEqual([`${pluginDirectory}:/opt/pico/executor-plugins:ro`]);

      const modelExecution = store.createModelExecution('container-plugin-model', thread.id, 0);
      store.transitionExecution(modelExecution.id, 'running');
      const call = { id: 'container-plugin-call', name: 'container_custom', arguments: { value: 'ran in container' } };
      store.commitModelStep({
        assistantRecordId: 'container-plugin-model:assistant',
        modelExecutionId: modelExecution.id,
        threadId: thread.id,
        payload: {
          content: '',
          toolCalls: [call],
          batchId: 'container-plugin-model:batch',
          projectionThrough: 0,
          usage: null,
          model: 'test-model',
        },
        toolCalls: [{ call, executionId: 'container-plugin-execution' }],
      });
      const execution = await executor.execute('container-plugin-execution', binding);
      expect(execution).toMatchObject({
        status: 'completed',
        result: { executionId: 'container-plugin-execution', value: 'ran in container' },
      });
      expect(await readFile(join(workspace, 'container-plugin-result.txt'), 'utf8')).toBe('ran in container');

      const unknownModelExecution = store.createModelExecution('unknown-container-tool-model', thread.id, 0);
      store.transitionExecution(unknownModelExecution.id, 'running');
      const unknownCall = { id: 'unknown-container-tool-call', name: 'not_discovered', arguments: {} };
      store.commitModelStep({
        assistantRecordId: 'unknown-container-tool-model:assistant',
        modelExecutionId: unknownModelExecution.id,
        threadId: thread.id,
        payload: {
          content: '',
          toolCalls: [unknownCall],
          batchId: 'unknown-container-tool-model:batch',
          projectionThrough: 0,
          usage: null,
          model: 'test-model',
        },
        toolCalls: [{ call: unknownCall, executionId: 'unknown-container-execution' }],
      });
      const unknownExecution = await executor.execute('unknown-container-execution', binding);
      expect(unknownExecution.status).toBe('failed');
      expect(unknownExecution.error).toMatch(/Unknown Remote Executor tool/);
      expect(runSubmissions).toBe(1);
    } finally {
      await executor.shutdown();
      if (remoteServer?.listening) {
        await new Promise<void>((resolve) => remoteServer!.close(() => resolve()));
      }
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads a bundled manifest from its controlled directory and executes its registered tool', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-executor-plugin-runner-'));
    const workspace = join(directory, 'workspace');
    const pluginDirectory = join(directory, 'executor-plugins');
    const executions = join(directory, 'executions');
    await Promise.all([mkdir(workspace), mkdir(pluginDirectory)]);
    const executionId = 'plugin-integration-42';
    const key = '8a5393a6f3288951';
    await writeFile(
      join(pluginDirectory, 'workspace-marker.mjs'),
      `import { writeFile } from 'node:fs/promises';
       export default {
         id: 'test.workspace-marker', name: 'Workspace marker', version: '1',
         activateExecutor({ tools }) {
           tools.register({ name: 'workspace_marker', description: 'Write a marker.', parameters: { type: 'object' } }, async (args, context) => {
             await writeFile(context.workspacePath + '/plugin-marker.txt', String(args.value));
             return { executionId: context.executionId, workspacePath: context.workspacePath };
           });
         }
       };
      `,
    );
    await writeFile(
      join(pluginDirectory, 'broken.mjs'),
      `export default {
         id: 'test.broken', name: 'Broken plugin', version: '1',
         activateExecutor({ tools }) {
           tools.register({ name: 'partial_tool', description: 'Must not be visible.', parameters: { type: 'object' } }, () => 'partial');
           throw new Error('activation failed after registration');
         }
       };
      `,
    );
    try {
      const discovered = spawnSync(
        process.execPath,
        ['-e', CONTAINER_RUNNER, 'tools', 'catalog-key', '', executions, workspace, pluginDirectory, executionId],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(discovered.status).toBe(0);
      const names = JSON.parse(discovered.stdout).tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain('workspace_marker');
      expect(names).not.toContain('partial_tool');

      const result = spawnSync(
        process.execPath,
        ['-e', CONTAINER_RUNNER, 'run', key, 'workspace_marker', executions, workspace, pluginDirectory, executionId],
        { encoding: 'utf8', input: JSON.stringify({ value: 'container plugin ran' }), timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'completed',
        result: { executionId, workspacePath: workspace },
      });
      expect(await readFile(join(workspace, 'plugin-marker.txt'), 'utf8')).toBe('container plugin ran');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
