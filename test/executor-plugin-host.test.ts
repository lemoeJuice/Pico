import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExecutorPlugins } from '../src/executor/plugin-host.js';
import { ToolCatalog } from '../src/executor/tool-catalog.js';
import { PicoStore } from '../src/core/store.js';
import { PicoRuntime } from '../src/runtime/runtime.js';

describe('Executor tool plugins', () => {
  it('keeps Executor plugin import and activation out of Runtime initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-runtime-executor-plugin-boundary-'));
    const pluginDirectory = join(directory, 'executor-plugins');
    const runtimePluginDirectory = join(directory, 'runtime-plugins');
    const marker = join(directory, 'activation.log');
    await Promise.all([mkdir(pluginDirectory), mkdir(runtimePluginDirectory)]);
    await writeFile(
      join(pluginDirectory, 'sentinel.mjs'),
      `import { appendFile } from 'node:fs/promises';
       await appendFile(${JSON.stringify(marker)}, 'import\\n');
       export default {
         id: 'test.executor-boundary', name: 'Executor boundary sentinel', version: '1',
         async activateExecutor({ tools }) {
           await appendFile(${JSON.stringify(marker)}, 'activate\\n');
           tools.register({ name: 'boundary_probe', description: 'Report the Executor context shape.', parameters: { type: 'object' } }, async (_args, context) => ({ executionId: context.executionId, hasThread: Object.hasOwn(context, 'thread') }));
         }
       };
      `,
    );
    const store = new PicoStore(join(directory, 'runtime.sqlite'));
    const runtime = new PicoRuntime(store, { pluginDirectory: runtimePluginDirectory, executorPluginDirectory: pluginDirectory });
    try {
      await runtime.initialize();
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });

      const catalog = new ToolCatalog();
      const loaded = await loadExecutorPlugins(catalog, { pluginDirectory });
      expect(loaded.loaded.map((item) => item.id)).toEqual(['test.executor-boundary']);
      expect((await readFile(marker, 'utf8')).split('\n').filter(Boolean)).toEqual(['import', 'activate']);
      const probe = catalog.get('boundary_probe');
      if (!probe || probe.source !== 'executor') throw new Error('Executor sentinel tool was not registered.');
      expect(
        await probe.execute({}, {
          workspacePath: directory,
          executionId: 'boundary-probe-execution',
          signal: new AbortController().signal,
        }),
      ).toEqual({ executionId: 'boundary-probe-execution', hasThread: false });
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads one manifest and registers executable tools in the Host/Remote registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-executor-plugin-host-'));
    const pluginDirectory = join(directory, 'plugins');
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, 'custom.mjs'),
      `export default {
        id: 'test.custom', name: 'Custom tools', version: '1',
        activateExecutor({ tools }) {
          tools.register({ name: 'workspace_marker', description: 'Write a marker into the executor workspace.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }, async (args, context) => ({ id: context.executionId, workspace: context.workspacePath, value: args.value }));
        }
      };
      `,
    );
    await writeFile(
      join(pluginDirectory, 'broken.mjs'),
      `export default {
        id: 'test.broken', name: 'Broken plugin', version: '1',
        activateExecutor({ tools }) {
          tools.register({ name: 'partial_tool', description: 'Must not be visible.', parameters: { type: 'object' } }, () => 'partial');
          throw new Error('activation failed after registration');
        }
      };
      `,
    );
    try {
      const catalog = new ToolCatalog();
      const result = await loadExecutorPlugins(catalog, { pluginDirectory });
      expect(result.loaded).toEqual([expect.objectContaining({ id: 'test.custom' })]);
      expect(result.errors).toEqual([expect.stringContaining('activation failed after registration')]);
      expect(catalog.listBySource('executor').map((tool) => tool.definition.name)).toEqual(['workspace_marker']);
      const tool = catalog.get('workspace_marker');
      if (!tool || tool.source !== 'executor') throw new Error('workspace_marker Executor tool was not registered.');
      expect(
        await tool.execute(
          { value: 'works' },
          {
            workspacePath: directory,
            executionId: 'stable-123',
            signal: new AbortController().signal,
          },
        ),
      ).toEqual({ id: 'stable-123', workspace: directory, value: 'works' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
