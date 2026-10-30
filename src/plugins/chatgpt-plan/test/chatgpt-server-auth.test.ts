import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../../../server.js';

const envKeys = ['PICO_HOST', 'PICO_PORT', 'PICO_DB_PATH', 'PICO_ACCESS_TOKEN'] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ChatGPT plugin server authorization', () => {
  it('serves the ChatGPT plugin UI assets with a restrictive content policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-chatgpt-ui-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      process.env.PICO_ACCESS_TOKEN = 'pico-test-token-'.repeat(3);
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const pluginPage = await fetch(`${base}/_pico/plugin-ui/pico.chatgpt-plan/webui/index.html`, {
        headers: { connection: 'close' },
      });
      expect(pluginPage.status).toBe(200);
      const pluginCsp = pluginPage.headers.get('content-security-policy') ?? '';
      expect(pluginCsp).toContain(`script-src 'self' ${base}`);
      expect(pluginCsp).toContain(`style-src 'self' ${base} 'unsafe-inline'`);
      expect(pluginCsp).toContain("connect-src 'none'");
      expect(pluginCsp).toContain("frame-ancestors 'self'");
      const page = await pluginPage.text();
      const bundlePath = page.match(/<script\s+src="([^"]*\/build\/webui\.js)"/i)?.[1];
      expect(bundlePath).toBeDefined();
      const bundleUrl = new URL(bundlePath!, pluginPage.url);
      expect(bundleUrl.origin).toBe(base);
      expect(bundleUrl.pathname).toMatch(
        /^\/_pico\/plugin-ui\/pico\.chatgpt-plan\/webui\/(?:releases\/[^/]+\/)?build\/webui\.js$/,
      );
      const pluginBundle = await fetch(bundleUrl, {
        headers: { connection: 'close' },
      });
      expect(pluginBundle.status).toBe(200);
      expect(pluginBundle.headers.get('content-type')).toContain('javascript');
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('only starts ChatGPT authorization for an authenticated same-origin UI and returns to a loopback callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-chatgpt-oauth-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      process.env.PICO_HOST = '127.0.0.1';
      process.env.PICO_PORT = '0';
      process.env.PICO_DB_PATH = join(directory, 'pico.sqlite');
      process.env.PICO_ACCESS_TOKEN = 'pico-test-token-'.repeat(3);
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const origin = base;
      const login = await fetch(`${base}/api/auth/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: process.env.PICO_ACCESS_TOKEN }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
      const create = await fetch(`${base}/api/plugins/pico.chatgpt-plan/instances`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Test account' }),
      });
      expect(create.status).toBe(200);
      const instance = (await create.json()) as { id: string };
      const signInUrl = `${base}/api/plugins/pico.chatgpt-plan/sign-in?instanceId=${encodeURIComponent(instance.id)}`;
      const unauthorized = await fetch(signInUrl, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthorized.status).toBe(401);

      const crossOrigin = await fetch(signInUrl, {
        method: 'POST',
        headers: { origin: 'https://evil.invalid', cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(crossOrigin.status).toBe(400);
      const start = await fetch(signInUrl, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(start.status).toBe(200);
      const result = (await start.json()) as {
        authorizationUrl: string;
        callbackOrigin: string;
        operationId: string;
      };
      const authorization = new URL(result.authorizationUrl);
      const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
      expect(authorization.origin).toBe('https://auth.openai.com');
      expect(redirect.origin).toBe(result.callbackOrigin);
      expect(redirect.hostname).toBe('127.0.0.1');
      expect(redirect.pathname).toBe('/auth/callback');
      expect(result.operationId).toBeTruthy();

      const callback = await fetch(
        `${redirect.origin}${redirect.pathname}?state=not-the-issued-state&error=access_denied`,
      );
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain('expired or did not match');
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
