import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { ModelCatalog } from '../src/runtime/model-catalog.js';
import type { AdapterContribution, ProviderModel } from '../src/contracts/model-catalog.js';

describe('model catalog', () => {
  it('revokes an instance before external disposal and rejects credentials in public configuration', async () => {
    const store = new PicoStore(':memory:');
    try {
      const catalog = new ModelCatalog(store);
      let disposed = false;
      catalog.registerProviderType(
        'plugin',
        { id: 'type', label: 'Type', addPage: { pluginId: 'plugin', pageId: 'add' } },
        {
          listModels: async () => [],
          authorize: async () => ({}),
          disposeInstance: async (instance) => {
            expect(catalog.listInstances().some((item) => item.id === instance.id)).toBe(false);
            expect(() => catalog.getInstanceSecrets('plugin', instance.id)).toThrow();
            disposed = true;
          },
        },
      );
      for (const key of ['token', 'key', 'headers', 'cookie', 'accessToken']) {
        expect(() =>
          catalog.addInstance('plugin', 'type', { label: 'Invalid', config: { [key]: 'synthetic-private' } }),
        ).toThrow();
      }
      expect(catalog.listInstances()).toHaveLength(0);
      const instance = catalog.addInstance('plugin', 'type', { label: 'Instance', config: {} });
      await catalog.removeInstance('plugin', instance.id);
      expect(disposed).toBe(true);
    } finally {
      store.close();
    }
  });

  it('isolates instances, caches failures, confirms removal, and resolves an explicit adapter', async () => {
    const store = new PicoStore(':memory:');
    try {
      const catalog = new ModelCatalog(store);
      let models: ProviderModel[] = [
        {
          id: 'raw',
          name: 'family-a',
          label: 'A',
          protocol: 'responses',
          supportsImages: true,
          endpoint: 'https://example.test/v1?api_key=hidden',
        },
      ];
      let fail = false;
      catalog.registerProviderType(
        'plugin',
        { id: 'type', label: 'Type', addPage: { pluginId: 'plugin', pageId: 'add' } },
        {
          listModels: async () => {
            if (fail) throw new Error('private failure');
            return models;
          },
          authorize: async () => ({}),
        },
      );
      const a = catalog.addInstance('plugin', 'type', { label: 'A', config: {} });
      const b = catalog.addInstance('plugin', 'type', { label: 'B', config: {} });
      expect(() => catalog.getInstanceSecrets('other', a.id)).toThrow();
      catalog.getInstanceSecrets('plugin', a.id).set('credential', 'private');
      expect(catalog.getInstanceSecrets('plugin', b.id).get('credential', null)).toBeNull();
      await catalog.refreshInstance(a.id);
      await catalog.refreshInstance(b.id);
      const [first, second] = catalog.listModels();
      expect(first!.modelId).not.toEqual(second!.modelId);
      expect(first!.endpoint).toBe('https://example.test/v1');
      const adapter: AdapterContribution = {
        id: 'adapter',
        label: 'Adapter',
        match: { familyPrefixes: ['family-'], protocols: ['responses'] },
        controls: [{ id: 'effort', label: 'Effort', type: 'string', choices: ['high', 'low'] }],
        temperature: { supported: true, min: 0, max: 2 },
      };
      catalog.registerAdapter('adapter-plugin', adapter);
      catalog.registerAdapter('adapter-plugin', { ...adapter, id: 'other-adapter' });
      expect(catalog.matchingAdapters(first!.modelId)).toHaveLength(2);
      const selection = {
        modelId: first!.modelId,
        adapterId: 'adapter',
        parameters: { temperature: 1, options: { effort: 'high' } },
      };
      expect(catalog.resolveSelection(selection).requestParameters).toEqual({
        fields: { effort: 'high' },
        temperature: 1,
      });
      expect(() =>
        catalog.resolveSelection({ ...selection, parameters: { options: { effort: 'invalid' } } }),
      ).toThrow();
      fail = true;
      await expect(catalog.refreshInstance(a.id)).rejects.toThrow('Unable to refresh provider models.');
      expect(catalog.listModels().find((model) => model.instanceId === a.id)?.availability).toBe('unknown');
      fail = false;
      models = [];
      await catalog.refreshInstance(a.id);
      expect(catalog.listModels().find((model) => model.instanceId === a.id)?.availability).toBe('unavailable');
      expect(() => catalog.resolveSelection(selection)).toThrow('unavailable');
      catalog.removeOwner('plugin');
      expect(catalog.listInstances()).toHaveLength(2);
      await catalog.removeInstance('plugin', a.id);
      expect(store.getPrivateSecret('plugin', `model-catalog-instance:${a.id}`, null)).toBeNull();
      expect(catalog.listModels().some((model) => model.instanceId === a.id)).toBe(false);
    } finally {
      store.close();
    }
  });
});
