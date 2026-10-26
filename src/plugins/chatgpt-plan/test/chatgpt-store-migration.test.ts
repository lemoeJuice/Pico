import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../../../core/store.js';

describe('ChatGPT Plan store migration', () => {
  it('imports legacy OAuth state into private storage before idempotent fact import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-workflow-legacy-'));
    const databasePath = join(directory, 'legacy.sqlite');
    let store: PicoStore | null = new PicoStore(databasePath);
    try {
      store.db
        .prepare('INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(
          'pico.chatgpt-plan',
          'oauth',
          JSON.stringify({ refreshToken: 'oauth-secret-sentinel' }),
          new Date().toISOString(),
        );
      store.db
        .prepare('INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run('example.plugin', 'legacy', JSON.stringify({ value: 9 }), new Date().toISOString());
      store.db
        .prepare('INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(
          'pico.chatgpt-plan',
          'modelCatalog',
          JSON.stringify({ models: [{ slug: 'cached-model' }], refreshedAt: 1 }),
          new Date().toISOString(),
        );
      store.close();
      store = new PicoStore(databasePath);

      expect(store.getPrivateSecret('pico.chatgpt-plan', 'oauth', null)).toEqual({
        refreshToken: 'oauth-secret-sentinel',
      });
      expect(store.getPluginCache('pico.chatgpt-plan', 'modelCatalog', null)).toEqual({
        models: [{ slug: 'cached-model' }],
        refreshedAt: 1,
      });
      expect(
        store.db.prepare("SELECT 1 FROM plugin_state WHERE plugin_id = 'pico.chatgpt-plan' AND key = 'oauth'").get(),
      ).toBeUndefined();
      expect(
        store
          .listScopedCanonical('workflow:global')
          .some((record) => JSON.stringify(record).includes('oauth-secret-sentinel')),
      ).toBe(false);
      const legacyFacts = store
        .listScopedCanonical('workflow:global')
        .filter((record) => record.id.startsWith('legacy-import:'));
      store.close();
      store = new PicoStore(databasePath);
      expect(
        store.listScopedCanonical('workflow:global').filter((record) => record.id.startsWith('legacy-import:')),
      ).toHaveLength(legacyFacts.length);
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
