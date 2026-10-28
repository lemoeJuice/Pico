import { build } from 'esbuild';
import { build as buildWebUi } from 'vite';

const target = process.argv[2] ?? 'all';
if (!['all', 'runtime', 'ui', 'chatgpt'].includes(target)) {
  throw new Error(`Unknown plugin build target: ${target}`);
}

const plugins = [
  ['pico.auto-thread-title', 'src/plugins/auto-thread-title.ts', 'autoThreadTitlePlugin'],
  ['pico.collaboration', 'src/plugins/collaboration.ts', 'collaborationPlugin'],
  ['pico.global-memory', 'src/plugins/global-memory.ts', 'globalMemoryPlugin'],
  ['pico.goal', 'src/plugins/goal.ts', 'goalPlugin'],
  ['pico.openai-provider', 'src/plugins/openai-provider.ts', 'openAiProviderPlugin'],
  ['pico.model-parameters', 'src/plugins/model-parameters/index.ts', 'modelParametersPlugin'],
  ['pico.permissions', 'src/plugins/permissions.ts', 'permissionPlugin'],
  ['pico.project-context', 'src/plugins/project-context.ts', 'projectContextPlugin'],
  ['pico.qq-adapter', 'src/plugins/qq-adapter.ts', 'qqAdapterPlugin'],
  ['pico.rolling-context', 'src/plugins/rolling-context.ts', 'rollingContextPlugin'],
  ['pico.todo', 'src/plugins/todo.ts', 'todoPlugin'],
  ['pico.usage', 'src/plugins/usage.ts', 'usagePlugin'],
  ['pico.vision', 'src/plugins/vision.ts', 'visionPlugin'],
];

async function buildPluginRuntime(pluginId, source, exportName) {
  await build({
    entryPoints: [source],
    outfile: `plugins/${pluginId}/runtime.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Keep ws external because its CommonJS internals use EventEmitter.
    external: ['node:*', ...(pluginId === 'pico.qq-adapter' ? ['ws'] : [])],
    minify: false,
    footer: { js: `export { ${exportName} as default };` },
  });
}

async function buildChatgptRuntime() {
  await build({
    entryPoints: ['src/plugins/chatgpt-plan.ts'],
    outfile: 'plugins/pico.chatgpt-plan/runtime.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    minify: false,
    footer: { js: 'export default createChatGptPlanPlugin();' },
  });
}

if (target === 'chatgpt') {
  await buildChatgptRuntime();
}

if (target === 'all' || target === 'runtime') {
  for (const [pluginId, source, exportName] of plugins) {
    await buildPluginRuntime(pluginId, source, exportName);
  }
  await buildChatgptRuntime();
}

if (target === 'all' || target === 'ui' || target === 'chatgpt') {
  await buildWebUi({ configFile: 'plugins/pico.chatgpt-plan/vite.config.ts' });
}

if (target === 'all' || target === 'ui') {
  await buildWebUi({ configFile: 'plugins/pico.openai-provider/vite.config.ts' });
}
