import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
        'pico.auto-thread-title',
        'pico.permissions',
        'pico.goal',
        'pico.todo',
        'pico.rolling-context',
        'pico.project-context',
        'pico.global-memory',
        'pico.collaboration',
        'pico.usage',
        'pico.model-parameters',
        'pico.vision',
        'pico.chatgpt-plan',
      ]) {
        expect(catalog).toContainEqual(expect.objectContaining({ id, enabled: true, loaded: true }));
      }
      expect(runtime.plugins.errors()).toEqual([]);
      expect(runtime.pluginInfo().pages).toContainEqual(
        expect.objectContaining({ pluginId: 'pico.global-memory', id: 'memory', group: 'memory' }),
      );
      expect(runtime.pluginInfo().pages).not.toContainEqual(
        expect.objectContaining({ pluginId: 'pico.project-context', group: 'memory' }),
      );
      expect(runtime.pluginInfo().ui).toContainEqual(
        expect.objectContaining({ pluginId: 'pico.project-context', slot: 'thread.toolbar' }),
      );
      expect(runtime.pluginInfo().ui).not.toContainEqual(expect.objectContaining({ pluginId: 'pico.todo' }));
      expect(runtime.pluginInfo().ui).toContainEqual(
        expect.objectContaining({ pluginId: 'pico.chatgpt-plan', externalAuthOrigins: ['https://auth.openai.com'] }),
      );
      expect(runtime.pluginInfo().pages).toContainEqual(
        expect.objectContaining({
          pluginId: 'pico.chatgpt-plan',
          id: 'account',
          externalAuthOrigins: ['https://auth.openai.com'],
        }),
      );
      expect(runtime.pluginInfo().pages).not.toContainEqual(expect.objectContaining({ pluginId: 'pico.todo' }));
      expect(existsSync(resolve(process.cwd(), 'plugins/pico.todo/webui/index.html'))).toBe(false);
      expect(catalog).toContainEqual(
        expect.objectContaining({ id: 'pico.model-parameters', required: false, enabled: true, loaded: true }),
      );
      const builtinSource = readFileSync(resolve(process.cwd(), 'src/plugins/builtin.ts'), 'utf8');
      const runtimeSource = readFileSync(resolve(process.cwd(), 'src/runtime/runtime.ts'), 'utf8');
      const webSource = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
      expect(builtinSource).not.toMatch(/from ['"].*\/(?:model-parameters|auto-thread-title|vision)(?:\/index)?\.js/);
      expect(runtimeSource).not.toContain("'pico.model-parameters'");
      expect(runtimeSource).not.toContain("pluginId: 'pico.usage'");
      expect(webSource).not.toContain('pico.usage');
      await runtime.plugins.setEnabled('pico.model-parameters', false);
      expect(runtime.pluginInfo().catalog).toContainEqual(
        expect.objectContaining({ id: 'pico.model-parameters', enabled: false, loaded: false }),
      );
      await runtime.plugins.setEnabled('pico.model-parameters', true);
      await runtime.plugins.reload('pico.model-parameters');
      expect(runtime.pluginInfo().catalog).toContainEqual(
        expect.objectContaining({ id: 'pico.model-parameters', enabled: true, loaded: true }),
      );
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
        'pico.vision',
      ]);
    } finally {
      await runtime.shutdown();
      store.close();
    }
  });
});
