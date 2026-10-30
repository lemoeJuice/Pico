import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../../../server.js';
import { assistantPayload } from '../../../../test/helpers.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Permissions plugin server API', () => {
  it('saves an allow rule when an approval is remembered for its Thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-permissions-server-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();

      const project = await server.runtime.createProject('Permission API', directory);
      const thread = server.runtime.createThread(project.id, 'host');
      const modelExecutionId = 'approval-step';
      const call = { id: 'read-call', name: 'read_file', arguments: { path: 'facts.txt' } };
      const executionId = `${thread.id}:${modelExecutionId}:${call.id}`;
      server.runtime.store.createModelExecution(modelExecutionId, thread.id, 0);
      server.runtime.store.transitionExecution(modelExecutionId, 'running');
      server.runtime.store.commitModelStep({
        assistantRecordId: `${modelExecutionId}:assistant`,
        modelExecutionId,
        threadId: thread.id,
        payload: assistantPayload({ toolCalls: [call], batchId: `${modelExecutionId}:batch` }),
        toolCalls: [{ call, executionId, source: 'executor' }],
      });
      server.runtime.store.setPluginState('pico.permissions', 'approvals', {
        [executionId]: {
          executionId,
          threadId: thread.id,
          toolName: 'read_file',
          arguments: { path: 'facts.txt' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      });

      const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/pico.permissions/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
        body: JSON.stringify({ executionId, allow: true, rememberForThread: true }),
      });
      expect(response.status, await response.text()).toBe(200);
      expect(
        server.runtime.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {})[
          thread.id
        ],
      ).toMatchObject({ read_file: 'allow' });
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
