import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from './helpers.js';

describe('Runtime test fixtures', () => {
  it('loads only the core plugins unless the test explicitly supplies others', async () => {
    const env = await setupRuntime(new FakeModel(() => response()));
    try {
      expect(
        env.runtime.plugins
          .list()
          .map((plugin) => plugin.id)
          .sort(),
      ).toEqual(['pico.commands', 'pico.workspace']);
    } finally {
      await env.cleanup();
    }
  });
});
