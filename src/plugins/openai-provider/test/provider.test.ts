import { describe, expect, it, vi } from 'vitest';
import { PicoStore } from '../../../core/store.js';
import { ModelCatalog } from '../../../runtime/model-catalog.js';
import type { ProviderTypeDriver } from '../../../contracts/model-catalog.js';
import type { PluginContext, PluginHttpRequest } from '../../host.js';
import { openAiProviderPlugin } from '../../openai-provider.js';

function setup() {
  const store = new PicoStore(':memory:');
  const catalog = new ModelCatalog(store);
  const owner = 'pico.openai-provider';
  let driver: ProviderTypeDriver;
  let failSecret = false;
  let failRefresh = false;
  const routes = new Map<string, (request: PluginHttpRequest) => unknown>();
  const context = {
    providers: {
      registerType: (type: Parameters<ModelCatalog['registerProviderType']>[1], implementation: ProviderTypeDriver) => {
        driver = implementation;
        catalog.registerProviderType(owner, type, implementation);
      },
      list: () => catalog.listInstances().filter((item) => item.owner === owner),
      get: (id: string) => catalog.listInstances().find((item) => item.owner === owner && item.id === id) ?? null,
      add: (typeId: string, input: Parameters<ModelCatalog['addInstance']>[2]) =>
        catalog.addInstance(owner, typeId, input),
      update: (id: string, input: { config: Record<string, unknown> }) =>
        catalog.updateInstance(owner, id, {
          label: catalog.listInstances().find((item) => item.id === id)!.label,
          config: input.config,
        }),
      remove: (id: string) => catalog.removeInstance(owner, id),
      refresh: (id: string) =>
        failRefresh ? Promise.reject(new Error('refresh failed')) : catalog.refreshInstance(id),
      secrets: (id: string) => {
        const secrets = catalog.getInstanceSecrets(owner, id);
        return failSecret
          ? {
              ...secrets,
              set: () => {
                throw new Error('fake store failure');
              },
            }
          : secrets;
      },
    },
    state: { transaction: <T>(run: () => T) => store.transaction(run) },
    ui: { registerPage() {} },
    http: {
      register: (method: string, path: string, handler: (request: PluginHttpRequest) => unknown) =>
        routes.set(`${method} ${path}`, handler),
    },
  };
  openAiProviderPlugin.activate!(context as unknown as PluginContext);
  const call = (method: string, id?: string, body: unknown = {}) =>
    routes.get(`${method} /instances`)!({
      body,
      query: new URLSearchParams(id ? { instanceId: id } : {}),
      origin: null,
    });
  return {
    store,
    catalog,
    call,
    driver: () => driver!,
    setRefreshFailure: (value: boolean) => {
      failRefresh = value;
    },
    setFailure: (value: boolean) => {
      failSecret = value;
    },
  };
}
const config = {
  label: 'A',
  baseUrl: 'https://example.test/v1',
  protocol: 'openai-chat-completions',
  models: ['same-model'],
};

describe('OpenAI-compatible provider', () => {
  it('isolates same-model instances, credentials, and publishes no secrets', async () => {
    const env = setup();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const first = (await env.call('POST', undefined, { ...config, apiKey: 'fake-one' })) as any;
      const second = (await env.call('POST', undefined, { ...config, label: 'B', apiKey: 'fake-two' })) as any;
      expect(await env.driver().authorize(first, false)).toEqual({ authorization: 'Bearer fake-one' });
      expect(await env.driver().authorize(second, false)).toEqual({ authorization: 'Bearer fake-two' });
      expect(env.catalog.listModels().map((model) => model.endpoint)).toEqual([
        'https://example.test/v1/chat/completions',
        'https://example.test/v1/chat/completions',
      ]);
      expect(env.catalog.listModels()[0]!.modelId).not.toBe(env.catalog.listModels()[1]!.modelId);
      expect(JSON.stringify(env.call('GET'))).not.toContain('fake-one');
      expect(JSON.stringify(env.catalog.listModels())).not.toContain('fake-two');
      expect(fetcher).not.toHaveBeenCalled();
      await expect(env.call('DELETE', 'foreign-id')).rejects.toThrow();
      await env.call('DELETE', first.id);
      expect(env.catalog.listInstances()).toHaveLength(1);
    } finally {
      fetcher.mockRestore();
      env.store.close();
    }
  });
  it('does not expose models or make requests for an empty instance', async () => {
    const env = setup();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const instance = env.catalog.createEmptyInstance('openai-compatible');
      expect(await env.driver().listModels(instance)).toEqual([]);
      expect(env.catalog.listModels()).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      env.store.close();
    }
  });
  it('updates one instance while preserving an omitted API key', async () => {
    const env = setup();
    try {
      const first = (await env.call('POST', undefined, { ...config, apiKey: 'fake-one' })) as any;
      const second = (await env.call('POST', undefined, { ...config, label: 'B', apiKey: 'fake-two' })) as any;
      const updated = (await env.call('PUT', first.id, { ...config, label: 'Renamed', models: ['new-model'] })) as any;
      expect(updated.id).toBe(first.id);
      expect(updated.label).toBe('A');
      expect(await env.driver().authorize(updated, false)).toEqual({ authorization: 'Bearer fake-one' });
      expect(await env.driver().authorize(second, false)).toEqual({ authorization: 'Bearer fake-two' });
      expect(
        env.catalog
          .listModels()
          .filter((model) => model.instanceId === first.id && model.availability === 'available')
          .map((model) => model.name),
      ).toEqual(['new-model']);
      expect(JSON.stringify(env.call('GET'))).not.toContain('fake-one');
    } finally {
      env.store.close();
    }
  });
  it('reports a refresh failure separately after saving settings', async () => {
    const env = setup();
    try {
      const instance = (await env.call('POST', undefined, { ...config, apiKey: 'fake-one' })) as any;
      env.setRefreshFailure(true);
      const result = (await env.call('PUT', instance.id, { ...config, label: 'Saved' })) as any;
      expect(result.refreshFailed).toBe(true);
      expect(env.catalog.listInstances()[0]?.label).toBe('A');
      expect(await env.driver().authorize(instance, false)).toEqual({ authorization: 'Bearer fake-one' });
    } finally {
      env.store.close();
    }
  });
  it('supports anonymous Responses endpoints without duplicating the path', async () => {
    const env = setup();
    try {
      const instance = (await env.call('POST', undefined, {
        ...config,
        baseUrl: 'http://localhost:11434/v1/responses',
        protocol: 'openai-responses',
      })) as any;
      expect(await env.driver().authorize(instance, false)).toEqual({});
      expect(env.catalog.listModels()[0]).toMatchObject({
        endpoint: 'http://localhost:11434/v1/responses',
        protocol: 'openai-responses',
      });
    } finally {
      env.store.close();
    }
  });
  it('rejects invalid inputs and rolls back the instance if secret storage fails', async () => {
    const env = setup();
    try {
      for (const baseUrl of [
        'https://name:secret@example.test/v1',
        'https://example.test/v1?key=x',
        'https://example.test/v1#secret',
        'https://example.test/v1?',
        'https://example.test/v1#',
        'file:///tmp/foo',
      ]) {
        await expect(env.call('POST', undefined, { ...config, baseUrl })).rejects.toThrow();
      }
      await expect(env.call('POST', undefined, { ...config, protocol: 'bad' })).rejects.toThrow();
      expect(env.catalog.listInstances()).toEqual([]);
      env.setFailure(true);
      await expect(env.call('POST', undefined, { ...config, apiKey: 'fake' })).rejects.toThrow('fake store failure');
      expect(env.catalog.listInstances()).toEqual([]);
    } finally {
      env.store.close();
    }
  });
});
