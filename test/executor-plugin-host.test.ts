import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExecutorPlugins } from '../src/executor/plugin-host.js';
import { ToolCatalog } from '../src/executor/tools.js';

describe('Executor tool plugins', () => {
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
      expect(
        await tool?.execute(
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
