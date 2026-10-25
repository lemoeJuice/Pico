import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('MCP management API', () => {
  it('authenticates server management, redacts credentials, and requires local-process confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-mcp-api-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      const accessToken = 'pico-mcp-api-test-token-'.repeat(2);
      process.env.PICO_ACCESS_TOKEN = accessToken;
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;

      expect((await fetch(`${base}/api/mcp/servers`)).status).toBe(401);
      const login = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: accessToken }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
      const headers = { cookie, 'content-type': 'application/json' };

      const empty = await fetch(`${base}/api/mcp/servers`, { headers }).then((response) => response.json());
      expect(empty).toEqual({ servers: [] });

      const localSecret = 'local-env-secret-do-not-return';
      const localCreate = await fetch(`${base}/api/mcp/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Local test server',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: directory,
          env: { MCP_TEST_SECRET: localSecret },
          autoStart: false,
        }),
      });
      expect(localCreate.status).toBe(201);
      const localCreated = (await localCreate.json()) as {
        server: { id: string; status: string; envKeys?: string[]; executionFingerprint?: string };
      };
      expect(localCreated.server).toMatchObject({
        status: 'stopped',
        envKeys: ['MCP_TEST_SECRET'],
        executionFingerprint: expect.any(String),
      });
      expect(JSON.stringify(localCreated)).not.toContain(localSecret);

      const localUpdate = await fetch(`${base}/api/mcp/servers/${localCreated.server.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name: 'Local test server',
          transport: 'stdio',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: directory,
          autoStart: false,
        }),
      });
      expect(localUpdate.status).toBe(200);
      expect(await localUpdate.json()).toMatchObject({ server: { envKeys: ['MCP_TEST_SECRET'] } });

      const unconfirmedStart = await fetch(`${base}/api/mcp/servers/${localCreated.server.id}/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      expect(unconfirmedStart.status).toBe(400);
      expect(await unconfirmedStart.json()).toMatchObject({
        error: expect.stringContaining('confirmLocalExecution'),
      });
      const unboundConfirmation = await fetch(`${base}/api/mcp/servers/${localCreated.server.id}/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ confirmLocalExecution: true }),
      });
      expect(unboundConfirmation.status).toBe(400);
      expect(await unboundConfirmation.json()).toMatchObject({
        error: expect.stringContaining('configuration changed'),
      });
      const staleConfirmation = await fetch(`${base}/api/mcp/servers/${localCreated.server.id}/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ confirmLocalExecution: true, executionFingerprint: 'stale-fingerprint' }),
      });
      expect(staleConfirmation.status).toBe(400);
      expect(await staleConfirmation.json()).toMatchObject({
        error: expect.stringContaining('configuration changed'),
      });
      const unchangedLocal = await fetch(`${base}/api/mcp/servers`, { headers }).then((response) => response.json());
      expect(unchangedLocal.servers[0]).toMatchObject({ status: 'stopped' });
      expect(JSON.stringify(unchangedLocal)).not.toContain(localSecret);

      const httpSecret = 'http-bearer-secret-do-not-return';
      const httpCreate = await fetch(`${base}/api/mcp/servers`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Remote test server',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          bearerToken: httpSecret,
          confirmPrivateNetworkAccess: false,
          autoStart: false,
        }),
      });
      expect(httpCreate.status).toBe(201);
      const httpCreated = (await httpCreate.json()) as {
        server: { id: string; hasToken: boolean; privateNetworkConfirmed: boolean };
      };
      expect(httpCreated.server).toMatchObject({ hasToken: true, privateNetworkConfirmed: false });
      expect(JSON.stringify(httpCreated)).not.toContain(httpSecret);

      const httpUpdate = await fetch(`${base}/api/mcp/servers/${httpCreated.server.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name: 'Remote test server renamed',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          confirmPrivateNetworkAccess: true,
          autoStart: true,
        }),
      });
      expect(httpUpdate.status).toBe(200);
      const httpUpdated = await httpUpdate.json();
      expect(httpUpdated.server).toMatchObject({
        name: 'Remote test server renamed',
        hasToken: true,
        autoStart: true,
        privateNetworkConfirmed: true,
      });
      expect(JSON.stringify(httpUpdated)).not.toContain(httpSecret);

      const clearToken = await fetch(`${base}/api/mcp/servers/${httpCreated.server.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name: 'Remote test server renamed',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          autoStart: true,
          confirmPrivateNetworkAccess: true,
          clearBearerToken: true,
        }),
      });
      expect(clearToken.status).toBe(200);
      expect(await clearToken.json()).toMatchObject({
        server: { hasToken: false, privateNetworkConfirmed: true },
      });

      for (const id of [localCreated.server.id, httpCreated.server.id]) {
        const deleted = await fetch(`${base}/api/mcp/servers/${id}`, { method: 'DELETE', headers });
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ ok: true });
      }
      expect(await fetch(`${base}/api/mcp/servers`, { headers }).then((response) => response.json())).toEqual({
        servers: [],
      });
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
