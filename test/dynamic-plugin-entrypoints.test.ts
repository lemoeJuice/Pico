import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';

describe('dynamic first-party plugin entries', () => {
  it('loads independent packages and applies the declared projection order', async () => {
    const store = new PicoStore(':memory:');
    const runtime = new PicoRuntime(store, { pluginDirectory: resolve(process.cwd(), 'plugins') });
    try {
      await runtime.initialize();
      const catalog = runtime.pluginInfo().catalog;
      for (const id of [
        'pico.permissions',
        'pico.goal',
        'pico.todo',
        'pico.rolling-context',
        'pico.project-context',
        'pico.global-memory',
        'pico.collaboration',
        'pico.usage',
      ]) {
        expect(catalog).toContainEqual(expect.objectContaining({ id, enabled: true, loaded: true }));
      }
      expect(runtime.plugins.errors()).toEqual([]);
      expect(
        runtime
          .pluginInfo()
          .pipelines.filter((item) => item.stage === 'projection')
          .map((item) => item.pluginId),
      ).toEqual([
        'pico.workspace',
        'pico.rolling-context',
        'pico.goal',
        'pico.todo',
        'pico.project-context',
        'pico.global-memory',
        'pico.collaboration',
        'pico.permissions',
      ]);
    } finally {
      await runtime.shutdown();
      store.close();
    }
  });
});
