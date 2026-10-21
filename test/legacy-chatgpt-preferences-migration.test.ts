import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('legacy ChatGPT preference ownership migration', () => {
  it('copies supported preferences before workflow snapshot import and preserves the source idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-model-preferences-'));
    directories.push(directory);
    const path = join(directory, 'pico.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE plugin_state (
      plugin_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(plugin_id, key)
    );`);
    legacy.prepare('INSERT INTO plugin_state VALUES (?, ?, ?, ?)').run(
      'pico.chatgpt-plan',
      'preferences',
      JSON.stringify({ reasoningEffort: 'high', fastMode: true, ignored: 'value' }),
      new Date().toISOString(),
    );
    legacy.close();

    let store = new PicoStore(path);
    expect(store.getPluginState('pico.model-parameters', 'legacyChatGptPreferences', null)).toEqual({
      reasoningEffort: 'high',
      fastMode: true,
    });
    expect(store.getPluginState('pico.chatgpt-plan', 'preferences', null)).toEqual({
      reasoningEffort: 'high',
      fastMode: true,
      ignored: 'value',
    });
    store.close();

    store = new PicoStore(path);
    expect(store.getPluginState('pico.model-parameters', 'legacyChatGptPreferences', null)).toEqual({
      reasoningEffort: 'high',
      fastMode: true,
    });
    store.close();
  });
});
