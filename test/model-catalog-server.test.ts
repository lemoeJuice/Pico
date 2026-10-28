import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';
import type { CatalogModel, ProviderInstance } from '../src/contracts/model-catalog.js';

describe('model catalog API', () => {
  it('adds multiple instances, saves explicit Thread/plugin choices and invalidates deleted models', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-catalog-server-'));
    vi.stubEnv('PICO_DB_PATH', join(directory, 'pico.sqlite'));
    vi.stubEnv('PICO_HOST', '127.0.0.1');
    vi.stubEnv('PICO_PORT', '0');
    vi.stubEnv('PICO_ACCESS_TOKEN', undefined);
    vi.stubEnv('PICO_CHATGPT_OAUTH_DB_PATH', '');
    vi.stubEnv('NODE_ENV', 'test');
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer();
      const base = `http://127.0.0.1:${server.port}`;
      const request = async (path: string, method = 'GET', body?: unknown) =>
        fetch(base + path, {
          method,
          headers: { 'content-type': 'application/json', origin: base },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const add = async (label: string) => {
        const result = await request('/api/plugins/pico.openai-provider/instances', 'POST', {
          label,
          baseUrl: 'https://models.invalid/v1',
          protocol: 'openai-chat-completions',
          models: ['same'],
          apiKey: 'synthetic-only-api-key',
        });
        expect(result.status).toBe(200);
        return result.json() as Promise<ProviderInstance>;
      };
      const first = await add('First');
      const second = await add('Second');
      const catalog = (await (await request('/api/model-catalog')).json()) as {
        models: CatalogModel[];
        instances: ProviderInstance[];
      };
      expect(catalog.instances).toHaveLength(2);
      expect(JSON.stringify(catalog)).not.toContain('synthetic-only-api-key');
      const renamedResponse = await request(`/api/provider-instances/${first.id}`, 'PATCH', { label: 'Renamed' });
      expect(renamedResponse.status).toBe(200);
      const renamed = (await renamedResponse.json()) as { instances: ProviderInstance[] };
      expect(renamed.instances.find((item) => item.id === first.id)).toEqual({
        ...first,
        label: 'Renamed',
        config: {},
      });
      expect(server.runtime.modelCatalog.listInstances().find((item) => item.id === first.id)).toEqual({
        ...first,
        label: 'Renamed',
      });
      expect(
        server.runtime.store.getPrivateSecret('pico.openai-provider', `model-catalog-instance:${first.id}`, null),
      ).toEqual({ apiKey: 'synthetic-only-api-key' });
      expect((await request(`/api/provider-instances/${first.id}`, 'PATCH', { label: 'Bad', config: {} })).status).toBe(
        400,
      );
      expect((await request('/api/provider-instances/missing', 'PATCH', { label: 'Bad' })).status).toBe(404);
      const a = catalog.models.find((model) => model.instanceId === first.id)!;
      const b = catalog.models.find((model) => model.instanceId === second.id)!;
      expect(a.modelId).not.toBe(b.modelId);
      const adapters = (await (await request(`/api/model-catalog/adapters?modelId=${a.modelId}`)).json()) as {
        adapters: Array<{ id: string }>;
      };
      expect(adapters.adapters.length).toBeGreaterThan(0);
      const selection = { modelId: a.modelId, adapterId: adapters.adapters[0]!.id, parameters: { options: {} } };
      const project = await server.runtime.createProject('Test', directory);
      const thread = server.runtime.createThread(project.id, 'runtime');
      expect(server.runtime.threadModelSelection(thread.id).modelId).toBe('');
      expect((await request(`/api/threads/${thread.id}/model-selection`, 'PUT', selection)).status).toBe(200);
      expect(
        (await request('/api/plugins/pico.auto-thread-title/model-selection', 'PUT', { mode: 'fixed', selection }))
          .status,
      ).toBe(200);
      const settings = (await (await request('/api/plugins/model-selections')).json()) as Record<
        string,
        { mode: string; selection: { modelId: string; unavailableReason?: string } }
      >;
      expect(settings['pico.auto-thread-title']?.selection.modelId).toBe(a.modelId);
      expect(
        (await request('/api/settings/model', 'PUT', { provider: 'openai-compatible', model: 'other' })).status,
      ).toBe(404);
      expect((await request(`/api/provider-instances/${first.id}`, 'DELETE')).status).toBe(200);
      expect(server.runtime.threadModelSelection(thread.id).modelId).toBe('');
      expect(server.runtime.modelCatalog.listModels().some((model) => model.instanceId === second.id)).toBe(true);
      const after = (await (await request('/api/plugins/model-selections')).json()) as typeof settings;
      expect(after['pico.auto-thread-title']?.selection.unavailableReason).toBeTruthy();
      expect(
        server.runtime.store.getPrivateSecret('pico.openai-provider', `model-catalog-instance:${first.id}`, null),
      ).toBeNull();
    } finally {
      await server?.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
