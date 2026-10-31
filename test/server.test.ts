import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';
import type { ThreadSnapshot } from '../src/runtime/runtime.js';
import { assistantPayload, setupTestCatalog } from './helpers.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket upgrade timed out'));
    }, 3000);
    let settled = false;
    socket.once('unexpected-response', (_request, response) => {
      settled = true;
      clearTimeout(timeout);
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    socket.once('open', () => {
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(101);
    });
    socket.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

async function waitForConnected(url: string, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 3000);
    socket.once('message', (message) => {
      clearTimeout(timeout);
      try {
        expect(JSON.parse(String(message))).toEqual({ type: 'connected' });
        socket.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe('Pico server access boundary', () => {
  it('requires a token off-loopback and gates HTTP and WebSocket access with a revocable session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-server-auth-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '0.0.0.0';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      await expect(startServer()).rejects.toThrow('PICO_ACCESS_TOKEN is required');
      process.env.PICO_ACCESS_TOKEN = 'too-short';
      await expect(startServer()).rejects.toThrow('at least 32 bytes');

      const token = 'pico-test-token-'.repeat(3);
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_ACCESS_TOKEN = token;
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const wsUrl = `ws://127.0.0.1:${server.port}/api/events`;
      const origin = base;

      expect((await fetch(`${base}/_pico/plugin-ui/unknown.plugin/webui/index.html`)).status).toBe(404);
      expect((await fetch(`${base}/_pico/plugin-ui/pico.example/runtime.mjs/index.html`)).status).toBe(404);

      const status = await fetch(`${base}/api/auth/status`).then((response) => response.json());
      expect(status).toEqual({ authRequired: true, authenticated: false });
      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(401);
      expect(health.headers.get('cache-control')).toBe('no-store');
      expect((await fetch(`${base}/api/projects`)).status).toBe(401);
      expect(await upgradeStatus(wsUrl, { origin })).toBe(401);

      const rejected = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong' }),
      });
      expect(rejected.status).toBe(401);

      const login = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(200);
      const setCookie = login.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      const cookie = setCookie.split(';', 1)[0] ?? '';
      expect(cookie).toMatch(/^pico_session=/);

      const cookieHeaders = { cookie, origin };
      expect(
        await fetch(`${base}/api/auth/status`, { headers: cookieHeaders }).then((response) => response.json()),
      ).toEqual({
        authRequired: true,
        authenticated: true,
      });
      expect(await fetch(`${base}/api/projects`, { headers: cookieHeaders }).then((response) => response.status)).toBe(
        200,
      );
      const defaultContextManagement = await fetch(`${base}/api/settings/context-management`, {
        headers: cookieHeaders,
      }).then((response) => response.json());
      expect(defaultContextManagement).toEqual({
        contextWindowTokens: 272_000,
        compactionThresholdTokens: 256_000,
        keepRecentTokens: 16_000,
      });
      const contextManagementUpdate = await fetch(`${base}/api/settings/context-management`, {
        method: 'PUT',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ contextWindowTokens: 4_000, compactionThresholdTokens: 3_000, keepRecentTokens: 2_500 }),
      });
      expect(contextManagementUpdate.status).toBe(200);
      expect(await contextManagementUpdate.json()).toEqual({
        contextWindowTokens: 4_000,
        compactionThresholdTokens: 3_000,
        keepRecentTokens: 2_500,
      });
      const defaultMiscellaneousSettings = await fetch(`${base}/api/settings/miscellaneous`, {
        headers: cookieHeaders,
      }).then((response) => response.json());
      expect(defaultMiscellaneousSettings).toEqual({ toolCardsExpandedByDefault: false, convenientModelParameters: false });
      const miscellaneousSettingsUpdate = await fetch(`${base}/api/settings/miscellaneous`, {
        method: 'PUT',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ toolCardsExpandedByDefault: true }),
      });
      expect(miscellaneousSettingsUpdate.status).toBe(200);
      expect(await miscellaneousSettingsUpdate.json()).toEqual({ toolCardsExpandedByDefault: true, convenientModelParameters: false });
      const convenientUpdate = await fetch(`${base}/api/settings/miscellaneous`, {
        method: 'PUT',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ convenientModelParameters: true }),
      });
      expect(await convenientUpdate.json()).toEqual({ toolCardsExpandedByDefault: true, convenientModelParameters: true });
      expect(await upgradeStatus(wsUrl, { cookie })).toBe(101);
      expect(await upgradeStatus(wsUrl, { cookie, origin: 'https://attacker.example' })).toBe(403);
      await waitForConnected(wsUrl, cookieHeaders);

      const project = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Permission API', workspacePath: directory }),
      }).then((response) => response.json());
      const thread = server.runtime.createThread(project.id, 'host');
      const toolExecutionId = `${thread.id}:approval-step:read-call`;
      const call = { id: 'read-call', name: 'read_file', arguments: { path: 'facts.txt' } };
      const modelExecution = server.runtime.store.createModelExecution('approval-step', thread.id, 0);
      server.runtime.store.transitionExecution(modelExecution.id, 'running');
      server.runtime.store.commitModelStep({
        assistantRecordId: 'approval-step:assistant',
        modelExecutionId: modelExecution.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'approval-step:batch', toolCalls: [call] }),
        toolCalls: [{ call, executionId: toolExecutionId }],
      });
      server.runtime.store.appendExecutionLog(modelExecution.id, 'model-input-requested', {
        requestId: 'approval-step-request',
        prompt: {
          system: 'Pico test system prompt',
          turns: [{ kind: 'message', role: 'user', content: 'Hello' }],
          tools: [],
          model: 'test-model',
          temperature: 0.2,
        },
      });
      server.runtime.store.appendExecutionLog(modelExecution.id, 'model-input-settled', {
        requestId: 'approval-step-request',
        status: 'completed',
      });
      const modelInputUrl = `${base}/api/threads/${thread.id}/executions/${encodeURIComponent(modelExecution.id)}/model-input`;
      const modelInputResponse = await fetch(modelInputUrl, { headers: cookieHeaders });
      expect(modelInputResponse.status).toBe(200);
      const modelInputPayload = await modelInputResponse.json();
      expect(JSON.stringify(modelInputPayload)).toContain('Pico test system prompt');
      expect(JSON.stringify(modelInputPayload)).toContain('Hello');
      expect(modelInputPayload).toMatchObject({
        attempts: [
          {
            id: 'approval-step-request',
            status: 'completed',
            prompt: {
              version: 1,
              system: 'Pico test system prompt',
              turns: [{ kind: 'message', role: 'user', content: 'Hello' }],
            },
            promptSummary: { model: 'test-model', turns: [{ kind: 'message', role: 'user', characters: 5 }] },
          },
        ],
      });
      const otherThread = server.runtime.createThread(project.id, 'host');
      const handoffUrl = `${base}/api/threads/${thread.id}/draft-handoff-state`;
      const handoffResponse = await fetch(handoffUrl, {
        method: 'POST',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ executionIds: [modelExecution.id, `${thread.id}:unknown`] }),
      });
      expect(handoffResponse.status).toBe(200);
      const handoff = await handoffResponse.json();
      expect(handoff).toEqual({
        executions: [
          {
            executionId: modelExecution.id,
            status: 'completed',
            assistantSeq: server.runtime.store.getCanonicalRecordById('approval-step:assistant')?.seq,
          },
          { executionId: `${thread.id}:unknown`, status: null, assistantSeq: null },
        ],
      });
      expect(JSON.stringify(handoff)).not.toContain('Pico test system prompt');
      expect(
        (
          await fetch(`${base}/api/threads/${otherThread.id}/draft-handoff-state`, {
            method: 'POST',
            headers: { ...cookieHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ executionIds: [modelExecution.id] }),
          }).then((response) => response.json())
        ).executions[0],
      ).toEqual({ executionId: modelExecution.id, status: null, assistantSeq: null });
      expect(
        await fetch(handoffUrl, {
          method: 'POST',
          headers: { ...cookieHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ executionIds: Array.from({ length: 51 }, (_, index) => String(index)) }),
        }).then((response) => response.status),
      ).toBe(400);
      expect(
        await fetch(
          `${base}/api/threads/${otherThread.id}/executions/${encodeURIComponent(modelExecution.id)}/model-input`,
          { headers: cookieHeaders },
        ).then((response) => response.status),
      ).toBe(404);
      const commandRequest = {
        pluginId: 'pico.workspace',
        threadId: thread.id,
        id: 'plugin-command-1',
        command: '/workspace',
      };
      const executeCommand = (body: object) =>
        fetch(`${base}/api/commands/execute`, {
          method: 'POST',
          headers: { ...cookieHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await executeCommand(commandRequest)).status).toBe(200);
      expect(await (await executeCommand(commandRequest)).json()).toMatchObject({ duplicate: true });
      expect((await executeCommand({ ...commandRequest, pluginId: 'pico.other', id: 'wrong-owner' })).status).toBe(403);

      const logout = await fetch(`${base}/api/auth/session`, { method: 'DELETE', headers: { cookie } });
      expect(logout.status).toBe(200);
      expect(await fetch(`${base}/api/projects`, { headers: cookieHeaders }).then((response) => response.status)).toBe(
        401,
      );
      expect(await upgradeStatus(wsUrl, cookieHeaders)).toBe(401);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('classifies API failures without leaking internal details', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-api-errors-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
      const project = await server.runtime.createProject('API errors', directory);
      const thread = server.runtime.createThread(project.id, 'host');
      const base = `http://127.0.0.1:${server.port}`;
      const malformed = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"secret":',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: 'Invalid JSON request body.', code: 'invalid_request' });
      const invalid = await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(invalid.status).toBe(400);
      const invalidMcp = await fetch(`${base}/api/mcp/servers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'bad', transport: 'streamable-http', url: 'not-a-url' }),
      });
      expect(invalidMcp.status).toBe(400);
      expect((await invalidMcp.json()).code).toBe('invalid_request');
      const missingPlugin = await fetch(`${base}/api/plugins/missing/reload`, { method: 'POST' });
      expect(missingPlugin.status).toBe(404);
      expect((await missingPlugin.json()).code).toBe('not_found');
      const invalidSettings = await fetch(`${base}/api/settings/context-management`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contextWindowTokens: -1 }),
      });
      expect(invalidSettings.status).toBe(400);
      expect((await invalidSettings.json()).code).toBe('invalid_request');
      const missing = await fetch(`${base}/api/threads/missing`);
      expect(missing.status).toBe(404);
      const missingArchive = await fetch(`${base}/api/threads/missing/archive`, { method: 'POST' });
      expect(missingArchive.status).toBe(404);
      const conflict = await fetch(`${base}/api/threads/${thread.id}`, { method: 'DELETE' });
      expect(conflict.status).toBe(409);
      const spy = vi.spyOn(server.runtime, 'getSnapshot').mockImplementationOnce(() => {
        throw new Error('database secret not found');
      });
      const failed = await fetch(`${base}/api/threads/${thread.id}`);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'Internal server error.', code: 'internal_error' });
      spy.mockRestore();
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves canonical Thread history in bounded pages with a stable sequence cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-history-pages-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
      const catalog = await setupTestCatalog(server.runtime, ['thread-pinned-model', 'other-model']);
      const project = await server.runtime.createProject('History pages', directory);
      const thread = server.runtime.createThread(project.id, 'host');
      for (let index = 0; index < 235; index += 1) {
        server.runtime.store.appendMessage(thread.id, `api-history-${index}`, {
          role: 'user',
          content: `Message ${index}`,
          source: 'user',
        });
      }

      const base = `http://127.0.0.1:${server.port}`;
      const latestResponse = await fetch(`${base}/api/threads/${thread.id}`);
      expect(latestResponse.status).toBe(200);
      const latest = (await latestResponse.json()) as ThreadSnapshot;
      expect(latest.modelSelection).toMatchObject({ modelId: '', adapterId: '', parameters: { options: {} } });
      expect(latest.records).toHaveLength(20);
      expect(latest.records[0]?.id).toBe('api-history-215');
      expect(latest.hasEarlierRecords).toBe(true);

      const olderResponse = await fetch(`${base}/api/threads/${thread.id}?beforeSeq=${latest.records[0]!.seq}`);
      const older = (await olderResponse.json()) as ThreadSnapshot;
      expect(older.records).toHaveLength(20);
      expect(older.records.at(-1)?.id).toBe('api-history-214');

      const initialResponse = await fetch(`${base}/api/threads/${thread.id}/initial-snapshot`);
      expect(initialResponse.status).toBe(200);
      const initial = await initialResponse.json();
      expect(initial).toMatchObject({ mode: 'initial', snapshot: { projectionStatus: 'not_loaded', contextUsage: null } });
      expect(initial.snapshot.records).toHaveLength(20);
      expect(initial.snapshot.records[0]?.id).toBe('api-history-215');

      const initialEarlierResponse = await fetch(
        `${base}/api/threads/${thread.id}/initial-snapshot?beforeSeq=${initial.snapshot.records[0].seq}`,
      );
      const initialEarlier = await initialEarlierResponse.json();
      expect(initialEarlier.mode).toBe('initial');
      expect(initialEarlier.snapshot.records).toHaveLength(20);
      expect(initialEarlier.snapshot.records.at(-1)?.id).toBe('api-history-214');
      expect(older.hasEarlierRecords).toBe(true);

      const invalidCursor = await fetch(`${base}/api/threads/${thread.id}?beforeSeq=not-a-number`);
      expect(invalidCursor.status).toBe(400);

      const selectionResponse = await fetch(`${base}/api/threads/${thread.id}/model-selection`);
      expect(selectionResponse.status).toBe(200);
      const selection = (await selectionResponse.json()) as ThreadSnapshot['modelSelection'];
      expect(selection).toMatchObject({ modelId: '', adapterId: '' });
      const updatedSelection = catalog.select('thread-pinned-model');
      const savedSelectionResponse = await fetch(`${base}/api/threads/${thread.id}/model-selection`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatedSelection),
      });
      expect(savedSelectionResponse.status).toBe(200);
      expect(await savedSelectionResponse.json()).toMatchObject({ model: 'thread-pinned-model' });
      const another = server.runtime.createThread(project.id, 'host');
      expect(server.runtime.threadModelSelection(another.id)).toMatchObject({ modelId: '', adapterId: '' });
      server.runtime.updateThreadModelSelection(another.id, catalog.select('other-model'));
      expect(server.runtime.threadModelSelection(thread.id)).toMatchObject({
        modelId: updatedSelection.modelId,
        adapterId: updatedSelection.adapterId,
        model: 'thread-pinned-model',
      });
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves model input diagnostics in full by default and omits them from timeline snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-timeline-snapshot-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
      await setupTestCatalog(server.runtime, ['timeline-test-model']);
      const project = await server.runtime.createProject('Timeline snapshots', directory);
      const thread = server.runtime.createThread(project.id, 'host');
      const largePrompt = 'private-prompt-canary-'.repeat(12_000);
      server.runtime.store.appendMessage(thread.id, 'timeline-user', {
        role: 'user',
        content: 'Continue from here',
        source: 'user',
      });
      server.runtime.store.appendPluginRecord(thread.id, 'pico.runtime', {
        action: 'model-input-recorded',
        executionId: 'model-execution-1',
        requestId: 'model-request-1',
        prompt: { system: largePrompt, turns: [{ content: largePrompt }] },
        promptSummary: { model: 'timeline-test-model', characters: largePrompt.length },
        projectionProvenance: [{ source: 'private-provenance-canary' }],
      });

      const base = `http://127.0.0.1:${server.port}/api/threads/${thread.id}`;
      const initialFullResponse = await fetch(`${base}/initial-snapshot`);
      const initialFull = await initialFullResponse.json();
      expect(initialFull.snapshot.records.find((record: { kind: string; payload: { action?: string } }) =>
        record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      ).payload.prompt.system).toBe(largePrompt);
      const initialTimelineResponse = await fetch(`${base}/initial-snapshot?view=timeline`);
      const initialTimeline = await initialTimelineResponse.json();
      expect(initialTimeline.mode).toBe('initial');
      const initialCompact = initialTimeline.snapshot.records.find(
        (record: { kind: string; payload: { action?: string } }) =>
          record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      );
      expect(Object.keys(initialCompact.payload).sort()).toEqual(['action', 'executionId', 'pluginId', 'requestId']);
      expect(JSON.stringify(initialTimeline)).not.toContain('private-prompt-canary');

      server.runtime.rewindContextToMessage(thread.id, 'timeline-user');

      const fullResponse = await fetch(`${base}/initial-snapshot`);
      const full = await fullResponse.json();
      const fullInputRecord = full.snapshot.records.find(
        (record: { kind: string; payload: { action?: string } }) =>
          record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      );
      expect(fullInputRecord.payload.prompt.system).toBe(largePrompt);
      expect(fullInputRecord.payload.projectionProvenance).toEqual([{ source: 'private-provenance-canary' }]);

      const timelineResponse = await fetch(`${base}/initial-snapshot?view=timeline`);
      const timeline = await timelineResponse.json();
      expect(timeline.mode).toBe('complete');
      const compact = timeline.snapshot.records.find(
        (record: { kind: string; payload: { action?: string } }) =>
          record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      );
      expect(compact).toMatchObject({
        id: expect.any(String),
        seq: 2,
        kind: 'plugin',
        payload: {
          pluginId: 'pico.runtime',
          action: 'model-input-recorded',
          executionId: 'model-execution-1',
          requestId: 'model-request-1',
        },
      });
      expect(Object.keys(compact.payload).sort()).toEqual(['action', 'executionId', 'pluginId', 'requestId']);
      expect(JSON.stringify(timeline)).not.toContain('private-prompt-canary');
      expect(JSON.stringify(timeline)).not.toContain('private-provenance-canary');

      const fullSnapshotResponse = await fetch(`${base}`);
      const fullSnapshot = await fullSnapshotResponse.json();
      expect(fullSnapshot.records.find((record: { kind: string; payload: { action?: string } }) =>
        record.kind === 'plugin' && record.payload.action === 'model-input-recorded',
      ).payload.prompt.system).toBe(largePrompt);
      const compactSnapshotResponse = await fetch(`${base}?view=timeline`);
      const compactSnapshot = await compactSnapshotResponse.json();
      expect(compactSnapshot.hasInactiveHistory).toBe(true);
      expect(JSON.stringify(compactSnapshot)).not.toContain('private-prompt-canary');
      expect(JSON.stringify(compactSnapshot)).not.toContain('private-provenance-canary');
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('independent Thread Project API', () => {
  it('rejects non-empty workspaces for conversion and later assignment, but accepts empty ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-independent-workspace-validation-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { 'content-type': 'application/json' };
      const nonEmpty = join(directory, 'non-empty');
      const hiddenNonEmpty = join(directory, 'hidden-non-empty');
      const empty = join(directory, 'empty');
      const laterNonEmpty = join(directory, 'later-non-empty');
      const laterEmpty = join(directory, 'later-empty');
      await Promise.all([nonEmpty, hiddenNonEmpty, empty, laterNonEmpty, laterEmpty].map((path) => mkdir(path)));
      await writeFile(join(nonEmpty, 'note.txt'), 'keep');
      await writeFile(join(hiddenNonEmpty, '.hidden'), 'keep hidden');
      await writeFile(join(laterNonEmpty, '.hidden'), 'keep later hidden');

      const createThread = async (title: string) => {
        const response = await fetch(`${base}/api/threads`, {
          method: 'POST', headers, body: JSON.stringify({ executorKind: 'host', title }),
        });
        expect(response.status).toBe(201);
        return response.json() as Promise<{ id: string; projectId: string | null }>;
      };

      for (const [title, workspacePath, filename] of [
        ['Non-empty conversion', nonEmpty, 'note.txt'],
        ['Hidden conversion', hiddenNonEmpty, '.hidden'],
      ] as const) {
        const thread = await createThread(title);
        const rejected = await fetch(`${base}/api/threads/${thread.id}/project`, {
          method: 'POST', headers, body: JSON.stringify({ name: title, workspacePath }),
        });
        expect(rejected.status).toBe(409);
        expect(server.runtime.store.getThread(thread.id)?.projectId).toBeNull();
        expect(server.runtime.store.listProjects().some((project) => project.name === title)).toBe(false);
        expect(await readdir(workspacePath)).toContain(filename);
      }

      const emptyThread = await createThread('Empty conversion');
      const converted = await fetch(`${base}/api/threads/${emptyThread.id}/project`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Empty conversion', workspacePath: empty }),
      });
      expect(converted.status).toBe(201);
      const convertedResult = await converted.json();
      expect(convertedResult.project.workspacePath).toBe(empty);

      const laterThread = await createThread('Later assignment');
      const projectResponse = await fetch(`${base}/api/threads/${laterThread.id}/project`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Later assignment' }),
      });
      expect(projectResponse.status).toBe(201);
      const project = await projectResponse.json();
      const laterRejected = await fetch(`${base}/api/projects/${project.project.id}/workspace`, {
        method: 'POST', headers, body: JSON.stringify({ workspacePath: laterNonEmpty }),
      });
      expect(laterRejected.status).toBe(409);
      expect(server.runtime.store.getProject(project.project.id)?.workspacePath).toBe('');
      expect(server.runtime.store.getThread(laterThread.id)?.projectId).toBe(project.project.id);
      expect(await readdir(laterNonEmpty)).toContain('.hidden');
      const laterAccepted = await fetch(`${base}/api/projects/${project.project.id}/workspace`, {
        method: 'POST', headers, body: JSON.stringify({ workspacePath: laterEmpty }),
      });
      expect(laterAccepted.status).toBe(200);
      expect((await laterAccepted.json()).workspacePath).toBe(laterEmpty);

      // Ordinary project creation remains unrestricted by the empty-directory rule.
      const ordinary = await fetch(`${base}/api/projects`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Ordinary project', workspacePath: nonEmpty }),
      });
      expect(ordinary.status).toBe(201);
      expect((await ordinary.json()).workspacePath).toBe(nonEmpty);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates an independent Thread, assigns its full tree, and sets workspace once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-independent-project-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { 'content-type': 'application/json' };
      const created = await fetch(`${base}/api/threads`, {
        method: 'POST', headers, body: JSON.stringify({ executorKind: 'host', title: 'Independent' }),
      });
      expect(created.status).toBe(201);
      const root = await created.json();
      expect(root.projectId).toBeNull();
      const child = server.runtime.store.createThread(null, 'runtime', 'Child', { parentThreadId: root.id });
      const unassigned = await fetch(`${base}/api/threads?unassigned=true`).then((response) => response.json());
      expect(unassigned.map((thread: { id: string }) => thread.id)).toEqual(expect.arrayContaining([root.id, child.id]));

      const assigned = await fetch(`${base}/api/threads/${root.id}/project`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'Assigned Project' }),
      });
      expect(assigned.status).toBe(201);
      const result = await assigned.json();
      expect(result.project.workspacePath).toBe('');
      expect(result.threads.map((thread: { projectId: string }) => thread.projectId)).toEqual([
        result.project.id,
        result.project.id,
      ]);

      const emptyWorkspace = join(directory, 'workspace');
      await mkdir(emptyWorkspace);
      const workspace = await fetch(`${base}/api/projects/${result.project.id}/workspace`, {
        method: 'POST', headers, body: JSON.stringify({ workspacePath: emptyWorkspace }),
      });
      expect(workspace.status).toBe(200);
      expect((await workspace.json()).workspacePath).toBe(emptyWorkspace);
      const repeated = await fetch(`${base}/api/projects/${result.project.id}/workspace`, {
        method: 'POST', headers, body: JSON.stringify({ workspacePath: directory }),
      });
      expect(repeated.status).toBe(409);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
