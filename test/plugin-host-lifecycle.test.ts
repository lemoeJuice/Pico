import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { ExecutionPipelines } from '../src/core/pipeline.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { CommandRegistry, PluginHost, type PicoPlugin } from '../src/plugins/host.js';
import { unavailablePluginServices } from '../src/plugins/services.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

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

function mcpCardPluginSource(): string {
  return `export default {
    id: 'pico.mcp-card-test',
    name: 'MCP card test',
    version: '1.0.0',
    activate({ ui }) {
      ui.contribute({
        slot: 'mcp.server.card',
        id: 'server-policy',
        label: 'Server policy',
        entry: 'webui',
        component: 'ServerPolicy',
      });
    },
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
  it('registers MCP server card components as plugin UI contributions', async () => {
    const store = new PicoStore(':memory:');
    const commands = new CommandRegistry();
    const directory = mkdtempSync(join(tmpdir(), 'pico-mcp-card-plugin-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'pico.mcp-card-test.mjs'), mcpCardPluginSource());
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
      expect(host.uiContributions()).toContainEqual(
        expect.objectContaining({
          pluginId: 'pico.mcp-card-test',
          slot: 'mcp.server.card',
          entry: 'webui',
          component: 'ServerPolicy',
        }),
      );
    } finally {
      await host.shutdown();
      store.close();
    }
  });

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

  it('loads only standard plugin exports and ignores legacy factory-only exports', async () => {
    const store = new PicoStore(':memory:');
    const directory = pluginDirectory();
    writeFileSync(
      join(directory, 'pico.factory-only.mjs'),
      `export function createChatGptPlanPlugin() { throw new Error('legacy factory was called'); }\n`,
    );
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      directory,
      unavailablePluginServices,
    );
    try {
      await host.load();
      expect(host.errors()).toContain('pico.factory-only.mjs: Plugin pico.factory-only.mjs must export a default PicoPlugin');
      expect(host.catalog()).toContainEqual(
        expect.objectContaining({
          id: 'pico.factory-only',
          loaded: false,
          error: 'Plugin pico.factory-only.mjs must export a default PicoPlugin',
        }),
      );
      expect(host.catalog()).toContainEqual(expect.objectContaining({ id: 'pico.dynamic-test', loaded: true }));
    } finally {
      await host.shutdown();
      store.close();
    }
  });

  it('reloads a packaged Runtime bundle after the bundle file changes', async () => {
    const store = new PicoStore(':memory:');
    const directory = pluginDirectory();
    const packageDirectory = join(directory, 'pico.dynamic-test');
    mkdirSync(packageDirectory);
    writeFileSync(join(directory, 'pico.dynamic-test.mjs'), `export { default } from './pico.dynamic-test/runtime.mjs';\n`);
    writeFileSync(join(packageDirectory, 'runtime.mjs'), pluginSource('1.0.0'));
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      directory,
      unavailablePluginServices,
    );
    try {
      await host.load();
      expect(host.catalog()).toContainEqual(expect.objectContaining({ id: 'pico.dynamic-test', version: '1.0.0' }));
      writeFileSync(join(packageDirectory, 'runtime.mjs'), pluginSource('2.0.0'));
      await host.reload('pico.dynamic-test');
      expect(host.catalog()).toContainEqual(expect.objectContaining({ id: 'pico.dynamic-test', version: '2.0.0' }));
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

  it('propagates required Thread creation initialization failures', async () => {
    const store = new PicoStore(':memory:');
    const host = new PluginHost(
      store,
      new ToolCatalog(),
      new ExecutionPipelines(),
      new CommandRegistry(),
      pluginDirectory(),
      unavailablePluginServices,
    );
    const plugin: PicoPlugin = {
      id: 'pico.thread-created-test',
      name: 'Thread created test',
      version: '1.0.0',
      activate({ threads }) {
        threads.onCreated(() => {
          throw new Error('required initialization failed');
        });
      },
    };
    try {
      await host.load([plugin]);
      const thread = { id: 'thread-1' } as import('../src/core/types.js').Thread;
      expect(() => host.initializeThread(thread)).toThrow('required initialization failed');
    } finally {
      await host.shutdown();
      store.close();
    }
  });

  it.each([false, true])('initializes an idempotent plugin Thread once (initial failure: %s)', async (initialFailure) => {
    let fail = initialFailure;
    let create: import('../src/plugins/host.js').PluginContext['threads']['create'] | undefined;
    let readIds: (() => string[]) | undefined;
    const plugin: PicoPlugin = {
      id: 'pico.idempotent-thread-test', name: 'Idempotent Thread test', version: '1.0.0',
      activate({ threads, state }) {
        create = threads.create;
        readIds = () => state.get<string[]>('ids', []);
        threads.onCreated((thread) => {
          state.set('ids', [...state.get<string[]>('ids', []), thread.id]);
          if (fail) throw new Error('initialization failed');
        });
      },
    };
    const env = await setupRuntime(new FakeModel(() => response()), { plugins: [plugin] });
    let createdEvents = 0;
    const unsubscribe = env.runtime.subscribe((event) => {
      if (event.type === 'thread.created') createdEvents++;
    });
    try {
      const request = () => create!(env.project.id, 'runtime', 'Child', { idempotencyKey: 'same-request' });
      if (initialFailure) {
        expect(request).toThrow('initialization failed');
        expect(env.store.listThreads(env.project.id)).toHaveLength(0);
        expect(readIds!()).toEqual([]);
        expect(createdEvents).toBe(0);
        fail = false;
      }
      const first = request();
      const replay = request();
      expect(replay.id).toBe(first.id);
      expect(readIds!()).toEqual([first.id]);
      expect(createdEvents).toBe(1);
      expect(env.store.listThreads(env.project.id)).toHaveLength(1);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('rolls back a failed required initializer and publishes only committed Threads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pico-plugin-runtime-'));
    temporaryDirectories.push(directory);
    let failInitialization = true;
    let readInitializedIds: (() => string[]) | undefined;
    const plugin: PicoPlugin = {
      id: 'pico.thread-transaction-test',
      name: 'Thread transaction test',
      version: '1.0.0',
      activate({ threads, state }) {
        threads.onCreated((thread) => {
          const ids = state.get<string[]>('initializedIds', []);
          state.set('initializedIds', [...ids, thread.id]);
          if (failInitialization) throw new Error('required initialization failed');
        });
        readInitializedIds = () => state.get<string[]>('initializedIds', []);
      },
    };
    const env = await setupRuntime(new FakeModel(() => response()), {
      plugins: [plugin],
      pluginDirectory: directory,
    });
    let eventThreadVisible: boolean | undefined;
    const unsubscribe = env.runtime.subscribe((event) => {
      const thread = event.thread;
      if (
        event.type === 'thread.created' &&
        thread &&
        typeof thread === 'object' &&
        'id' in thread &&
        typeof thread.id === 'string'
      ) {
        eventThreadVisible = env.runtime.getThread(thread.id) !== null;
      }
    });
    try {
      expect(() => env.runtime.createThread(env.project.id, 'runtime')).toThrow('required initialization failed');
      expect(env.store.listThreads(env.project.id)).toHaveLength(0);
      expect(readInitializedIds?.()).toEqual([]);

      failInitialization = false;
      const thread = env.runtime.createThread(env.project.id, 'runtime');
      expect(env.store.getThread(thread.id)).not.toBeNull();
      expect(readInitializedIds?.()).toEqual([thread.id]);
      expect(eventThreadVisible).toBe(true);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });
});
