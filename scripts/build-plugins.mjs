import { build } from 'esbuild';
import { build as buildWebUi } from 'vite';

const plugins = [
  ['pico.collaboration', 'src/plugins/collaboration.ts', 'collaborationPlugin'],
  ['pico.global-memory', 'src/plugins/global-memory.ts', 'globalMemoryPlugin'],
  ['pico.goal', 'src/plugins/goal.ts', 'goalPlugin'],
  ['pico.permissions', 'src/plugins/permissions.ts', 'permissionPlugin'],
  ['pico.project-context', 'src/plugins/project-context.ts', 'projectContextPlugin'],
  ['pico.rolling-context', 'src/plugins/rolling-context.ts', 'rollingContextPlugin'],
  ['pico.todo', 'src/plugins/todo.ts', 'todoPlugin'],
  ['pico.usage', 'src/plugins/usage.ts', 'usagePlugin'],
];

await Promise.all(
  plugins.map(([pluginId, source, exportName]) =>
    build({
      entryPoints: [source],
      outfile: `plugins/${pluginId}/runtime.mjs`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['node:*'],
      minify: false,
      footer: { js: `export { ${exportName} as default };` },
    }),
  ),
);

await buildWebUi({ configFile: 'plugins/pico.model-parameters/vite.config.ts' });
