import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedChatGptOAuthSecrets } from '../oauth-store.js';
import type { PluginContext, PluginHttpRequest } from '../../host.js';
import type { ProviderInstance, ProviderTypeDriver } from '../../../contracts/model-catalog.js';

const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));

vi.mock('node:http', () => ({
  createServer: () => ({
    listening: false,
    once() {},
    removeListener() {},
    listen(_port: number, _host: string, cb: () => void) {
      cb();
    },
    address: () => ({ port: 12345 }),
    close(cb: () => void) {
      cb();
    },
  }),
}));
vi.mock('../auth.js', () => ({
  RetryableChatGptAuthorizationExchange: class extends Error {},
  ChatGptPlanAuth: class {
    constructor(
      _state: unknown,
      _fetch: unknown,
      _now: unknown,
      private secrets: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void },
    ) {}
    status() {
      return { connected: Boolean(this.secrets.get('oauth', null)), accountLabel: null };
    }
    async beginSignIn() {
      return { authorizationUrl: 'https://auth.openai.com/' };
    }
    parseCallbackUrl(value: string) {
      return new URL(value).searchParams;
    }
    hasPendingAuthorization() {
      return true;
    }
    async completeSignIn() {
      if (gate.wait) await gate.wait;
      this.secrets.set('oauth', { mock: true });
    }
    async refreshModels() {
      return [];
    }
    async listModels() {
      return [];
    }
    async signOut() {
      this.secrets.set('oauth', null);
      return { remoteRevoked: true };
    }
    async accessToken() {
      return 'fake';
    }
  },
}));
import { createChatGptPlanPlugin } from '../../chatgpt-plan.js';

function setup(legacy: unknown = null) {
  const state = new Map<string, unknown>();
  const cache = new Map<string, unknown>();
  const instanceSecrets = new Map<string, Map<string, unknown>>();
  const instances: ProviderInstance[] = [];
  const routes = new Map<string, (request: PluginHttpRequest) => unknown>();
  let driver: ProviderTypeDriver | undefined;
  const store = (map: Map<string, unknown>) => ({
    get: <T>(key: string, fallback: T): T => (map.has(key) ? (map.get(key) as T) : fallback),
    set: (key: string, value: unknown) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
  });
  const secretStore = (id: string) => {
    if (!instanceSecrets.has(id)) instanceSecrets.set(id, new Map());
    return store(instanceSecrets.get(id)!);
  };
  const context = {
    providers: {
      registerType: (_type: unknown, value: ProviderTypeDriver) => {
        driver = value;
      },
      list: () => instances,
      get: (id: string) => instances.find((instance) => instance.id === id),
      add: (typeId: string, data: { label: string; config: Record<string, unknown> }) => {
        const instance = {
          id: `instance-${instances.length + 1}`,
          typeId,
          owner: 'pico.chatgpt-plan',
          ...data,
          createdAt: '',
        };
        instances.push(instance);
        return instance;
      },
      secrets: secretStore,
      refresh: vi.fn(async () => {}),
    },
    state: store(state),
    cache: store(cache),
    secrets: store(new Map(legacy ? [['oauth', legacy]] : [])),
    commands: { register() {} },
    ui: { registerPage() {} },
    http: {
      register: (method: string, path: string, handler: (request: PluginHttpRequest) => unknown) =>
        routes.set(`${method} ${path}`, handler),
    },
  };
  const plugin = createChatGptPlanPlugin();
  plugin.activate!(context as unknown as PluginContext);
  const call = (route: string, id?: string, body: unknown = {}) =>
    routes.get(route)!({ body, query: new URLSearchParams(id ? { instanceId: id } : {}), origin: 'http://localhost' });
  return { plugin, instances, instanceSecrets, call, driver: () => driver! };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
});
describe('ChatGPT provider instances', () => {
  it('declares the transport defaults for newly created instances', () => {
    const env = setup();
    expect(env.driver().defaultConfig).toEqual({
      chatgpt: true,
      fetchRetries: 5,
      retryDelayMs: 2000,
      refreshOnUnauthorized: true,
    });
  });
  it('isolates credentials and prevents completing another instance operation', async () => {
    const env = setup();
    const a = env.call('POST /instances', undefined, { label: 'A' }) as ProviderInstance;
    const b = env.call('POST /instances', undefined, { label: 'B' }) as ProviderInstance;
    const operation = (await env.call('POST /sign-in', a.id)) as { operationId: string };
    await expect(
      env.call('POST /sign-in/complete', b.id, {
        operationId: operation.operationId,
        callbackUrl: 'http://127.0.0.1:12345/auth/callback?state=x&code=y',
      }),
    ).rejects.toThrow();
    await env.call('POST /sign-in/complete', a.id, {
      operationId: operation.operationId,
      callbackUrl: 'http://127.0.0.1:12345/auth/callback?state=x&code=y',
    });
    expect(env.call('GET /status', a.id)).toMatchObject({ connected: true });
    expect(env.call('GET /status', b.id)).toMatchObject({ connected: false });
    expect(() => env.call('GET /status', 'unknown')).toThrow();
    expect(await env.driver().authorize(a, false)).toEqual({ authorization: 'Bearer fake' });
    await env.plugin.deactivate?.();
  });
  it('migrates only when legacy credentials exist', async () => {
    const empty = setup();
    expect(empty.instances).toHaveLength(0);
    await empty.plugin.deactivate?.();
    const legacy = setup({ credential: 'fake' });
    expect(legacy.instances).toHaveLength(1);
    expect(legacy.instanceSecrets.get(legacy.instances[0]!.id)?.get('oauth')).toEqual({ credential: 'fake' });
    await legacy.plugin.deactivate?.();
  });
  it('keeps legacy shared credentials authoritative and isolates new shared namespaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-provider-test-'));
    const path = join(dir, 'oauth.sqlite');
    vi.stubEnv('PICO_CHATGPT_OAUTH_DB_PATH', path);
    const original = createSharedChatGptOAuthSecrets(path, 'pico.chatgpt-plan');
    original.set('oauth', { legacy: true });
    original.close();
    try {
      const env = setup();
      const legacy = env.instances[0]!;
      expect(legacy.config.legacyShared).toBe(true);
      expect(env.call('GET /status', legacy.id)).toMatchObject({ connected: true });
      const other = env.call('POST /instances', undefined, { label: 'B' }) as ProviderInstance;
      expect(env.call('GET /status', other.id)).toMatchObject({ connected: false });
      const operation = (await env.call('POST /sign-in', other.id)) as { operationId: string };
      await env.call('POST /sign-in/complete', other.id, {
        operationId: operation.operationId,
        callbackUrl: 'http://127.0.0.1:12345/auth/callback?state=x&code=y',
      });
      expect(env.call('GET /status', other.id)).toMatchObject({ connected: true });
      expect(env.instanceSecrets.size).toBe(0);
      await env.plugin.deactivate?.();
      const legacyStore = createSharedChatGptOAuthSecrets(path, 'pico.chatgpt-plan');
      const otherStore = createSharedChatGptOAuthSecrets(path, `pico.chatgpt-plan:instance:${other.id}`);
      expect(legacyStore.get('oauth', null)).toEqual({ legacy: true });
      expect(otherStore.get('oauth', null)).toEqual({ mock: true });
      legacyStore.close();
      otherStore.close();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('serializes asynchronous refreshes across local shared-store connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-provider-lock-'));
    const path = join(dir, 'oauth.sqlite');
    const first = createSharedChatGptOAuthSecrets(path, 'first');
    const second = createSharedChatGptOAuthSecrets(path, 'second');
    const order: string[] = [];
    try {
      await Promise.all([
        first.withLock(async () => {
          order.push('first-start');
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push('first-end');
        }),
        second.withLock(async () => {
          order.push('second-start');
          order.push('second-end');
        }),
      ]);
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('deletes the external credential and prevents an in-flight callback from restoring it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-provider-delete-'));
    const path = join(dir, 'oauth.sqlite');
    vi.stubEnv('PICO_CHATGPT_OAUTH_DB_PATH', path);
    try {
      const env = setup();
      const instance = env.call('POST /instances', undefined, { label: 'A' }) as ProviderInstance;
      const operation = (await env.call('POST /sign-in', instance.id)) as { operationId: string };
      const store = createSharedChatGptOAuthSecrets(path, `pico.chatgpt-plan:instance:${instance.id}`);
      store.set('oauth', { old: true });
      store.set('extra', { old: true });
      let release!: () => void;
      gate.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completion = env.call('POST /sign-in/complete', instance.id, {
        operationId: operation.operationId,
        callbackUrl: 'http://127.0.0.1:12345/auth/callback?state=x&code=y',
      }) as Promise<unknown>;
      env.instances.splice(env.instances.indexOf(instance), 1);
      await env.driver().disposeInstance!(instance);
      release();
      expect(await completion).toMatchObject({ status: 'failed' });
      expect(store.get('oauth', null)).toBeNull();
      expect(store.get('extra', null)).toBeNull();
      store.close();
      await env.plugin.deactivate?.();
    } finally {
      gate.wait = null;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('clears legacy shared credentials when the migrated account is deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-provider-legacy-delete-'));
    const path = join(dir, 'oauth.sqlite');
    vi.stubEnv('PICO_CHATGPT_OAUTH_DB_PATH', path);
    const legacyStore = createSharedChatGptOAuthSecrets(path, 'pico.chatgpt-plan');
    legacyStore.set('oauth', { fake: true });
    try {
      const env = setup();
      const instance = env.instances[0]!;
      env.instances.splice(0, 1);
      await env.driver().disposeInstance!(instance);
      expect(legacyStore.get('oauth', null)).toBeNull();
      await env.plugin.deactivate?.();
    } finally {
      legacyStore.close();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
