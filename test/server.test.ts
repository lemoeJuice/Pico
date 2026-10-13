import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import type { ThreadSnapshot } from '../src/runtime/runtime.js';
import { assistantPayload } from './helpers.js';

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
      expect(await modelInputResponse.json()).toMatchObject({
        attempts: [{ id: 'approval-step-request', status: 'completed', prompt: { model: 'test-model' } }],
      });
      const otherThread = server.runtime.createThread(project.id, 'host');
      expect(
        await fetch(
          `${base}/api/threads/${otherThread.id}/executions/${encodeURIComponent(modelExecution.id)}/model-input`,
          { headers: cookieHeaders },
        ).then((response) => response.status),
      ).toBe(404);
      server.runtime.store.createApproval(toolExecutionId);
      const rememberResponse = await fetch(`${base}/api/approvals/${encodeURIComponent(toolExecutionId)}`, {
        method: 'POST',
        headers: { ...cookieHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ allow: true, rememberForThread: true }),
      });
      expect(rememberResponse.status).toBe(200);
      expect(
        await server.runtime.store.getSetting<Record<string, string>>(`permissions:${thread.id}`, {}),
      ).toMatchObject({ read_file: 'allow' });

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

  it('serves canonical Thread history in bounded pages with a stable sequence cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-history-pages-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      delete process.env.PICO_ACCESS_TOKEN;
      server = await startServer();
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
      expect(latest.records).toHaveLength(100);
      expect(latest.records[0]?.id).toBe('api-history-135');
      expect(latest.hasEarlierRecords).toBe(true);

      const olderResponse = await fetch(`${base}/api/threads/${thread.id}?beforeSeq=${latest.records[0]!.seq}`);
      const older = (await olderResponse.json()) as ThreadSnapshot;
      expect(older.records).toHaveLength(100);
      expect(older.records.at(-1)?.id).toBe('api-history-134');
      expect(older.hasEarlierRecords).toBe(true);

      const invalidCursor = await fetch(`${base}/api/threads/${thread.id}?beforeSeq=not-a-number`);
      expect(invalidCursor.status).toBe(400);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
