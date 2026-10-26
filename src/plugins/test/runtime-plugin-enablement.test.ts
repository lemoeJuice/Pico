import { describe, expect, it } from 'vitest';
import { FakeModel, response, setupRuntime } from '../../../test/helpers.js';

describe('First-party plugin enablement', () => {
  it('can disable built-in workflow plugins through RuntimeOptions and the environment', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')), {
      disabledBuiltinPlugins: ['pico.collaboration'],
    });
    const disabledByOption = env.runtime.pluginInfo().plugins.map((plugin) => plugin.id);
    expect(disabledByOption).not.toContain('pico.collaboration');
    expect(env.runtime.tools.list().map((tool) => tool.name)).not.toContain('spawn_thread');
    await env.cleanup();

    const previous = process.env.PICO_DISABLED_PLUGINS;
    process.env.PICO_DISABLED_PLUGINS = ' pico.collaboration , pico.permissions ';
    const envDisabled = await setupRuntime(new FakeModel(() => response('unused')));
    try {
      const pluginIds = envDisabled.runtime.pluginInfo().plugins.map((plugin) => plugin.id);
      expect(pluginIds).not.toContain('pico.collaboration');
      expect(pluginIds).not.toContain('pico.permissions');
      expect(envDisabled.runtime.tools.list().map((tool) => tool.name)).not.toContain('spawn_thread');
    } finally {
      await envDisabled.cleanup();
      if (previous === undefined) delete process.env.PICO_DISABLED_PLUGINS;
      else process.env.PICO_DISABLED_PLUGINS = previous;
    }
  });
});
