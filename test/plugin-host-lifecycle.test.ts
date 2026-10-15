import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import { ToolCatalog } from '../src/executor/tools.js';
import { CommandRegistry, PluginHost, type PicoPlugin } from '../src/plugins/host.js';
import { unavailablePluginServices } from '../src/plugins/services.js';

const temporaryDirectories: string[] = [];

function pluginSource(version: string): string {
  return `export default {
    id: 'pico.dynamic-test',
    name: 'Dynamic test',
    version: '${version}',
    activate({ commands, ui, http }) {
      commands.register({ name: 'dynamic-test', description: 'test', execute() { return { text: 'active' }; } });
      ui.contribute({ slot: 'sidebar.panel', id: 'test', label: 'Dynamic test' });
      http.register('GET', '/status', () => ({ version: '${version}' }));
    },
    deactivate() {},
  };
`;
}

function pluginDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pico-plugin-lifecycle-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'pico.dynamic-test.mjs'), pluginSource('1.0.0'));
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PluginHost lifecycle', () => {
  it('loads independent entries and cleans registrations when disabled or reloaded', async () => {
    const store = new PicoStore(':memory:');
    const commands = new CommandRegistry();
    const directory = pluginDirectory();
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      commands,
      directory,
      unavailablePluginServices,
    );
    try {
      await host.load();
      expect(host.catalog()).toContainEqual(
        expect.objectContaining({ id: 'pico.dynamic-test', enabled: true, loaded: true }),
      );
      expect(host.uiContributions()).toHaveLength(1);
      expect(host.httpRoutes()).toHaveLength(1);
      await expect(commands.execute('/dynamic-test', { thread: null, projectId: null })).resolves.toEqual({
        text: 'active',
      });

      await host.setEnabled('pico.dynamic-test', false);
      expect(host.catalog()).toContainEqual(
        expect.objectContaining({ id: 'pico.dynamic-test', enabled: false, loaded: false }),
      );
      expect(host.uiContributions()).toHaveLength(0);
      expect(host.httpRoutes()).toHaveLength(0);
      expect(host.commands.list()).not.toContainEqual(expect.objectContaining({ name: 'dynamic-test' }));

      await host.setEnabled('pico.dynamic-test', true);
      writeFileSync(join(directory, 'pico.dynamic-test.mjs'), pluginSource('2.0.0'));
      await host.reload('pico.dynamic-test');
      expect(host.catalog()).toContainEqual(
        expect.objectContaining({ id: 'pico.dynamic-test', version: '2.0.0', loaded: true }),
      );
      expect(host.httpRoutes()).toHaveLength(1);
      expect(store.getSetting<Record<string, boolean>>('plugin-enablement', {})['pico.dynamic-test']).toBe(true);
    } finally {
      await host.shutdown();
      store.close();
    }
  });

  it('refuses lifecycle changes while Runtime reports an active execution', async () => {
    const store = new PicoStore(':memory:');
    let allowed = false;
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      pluginDirectory(),
      unavailablePluginServices,
      { canReload: () => ({ allowed, reason: 'An execution is active.' }) },
    );
    try {
      await host.load();
      await expect(host.setEnabled('pico.dynamic-test', false)).rejects.toThrow('An execution is active.');
      allowed = true;
      await expect(host.setEnabled('pico.dynamic-test', false)).resolves.toHaveLength(1);
    } finally {
      await host.shutdown();
      store.close();
    }
  });

  it('serializes concurrent activation and fully unregisters plugins during shutdown', async () => {
    const store = new PicoStore(':memory:');
    const commands = new CommandRegistry();
    const activationStarted = deferred<void>();
    const finishActivation = deferred<void>();
    let activations = 0;
    let deactivations = 0;
    const plugin: PicoPlugin = {
      id: 'pico.concurrent-test',
      name: 'Concurrent test',
      version: '1.0.0',
      async activate({ commands: registry, ui, http }) {
        activations += 1;
        registry.register({ name: 'concurrent-test', description: 'test', execute: () => ({ text: 'active' }) });
        ui.contribute({ slot: 'sidebar.panel', id: 'test', label: 'Concurrent test' });
        http.register('GET', '/status', () => ({ active: true }));
        activationStarted.resolve();
        await finishActivation.promise;
      },
      deactivate() {
        deactivations += 1;
      },
    };
    store.setSetting('plugin-enablement', { [plugin.id]: false });
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      commands,
      pluginDirectory(),
      unavailablePluginServices,
    );
    try {
      await host.load([plugin]);
      const first = host.setEnabled(plugin.id, true);
      await activationStarted.promise;
      const second = host.setEnabled(plugin.id, true);
      await Promise.resolve();
      expect(activations).toBe(1);
      finishActivation.resolve();
      await Promise.all([first, second]);
      expect(activations).toBe(1);
      expect(host.list()).toContainEqual(expect.objectContaining({ id: plugin.id }));

      await host.shutdown();
      expect(deactivations).toBe(1);
      expect(host.list()).not.toContainEqual(expect.objectContaining({ id: plugin.id }));
      expect(host.uiContributions()).toEqual([]);
      expect(host.httpRoutes()).toEqual([]);
      expect(commands.list()).toEqual([]);
    } finally {
      await host.shutdown();
      store.close();
    }
  });
});
