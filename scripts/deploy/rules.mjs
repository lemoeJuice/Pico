import path from 'node:path';

const PLUGIN_SOURCE_TO_ID = new Map([
  ['auto-thread-title', 'pico.auto-thread-title'],
  ['chatgpt-plan', 'pico.chatgpt-plan'],
  ['collaboration', 'pico.collaboration'],
  ['deepsea-theme', 'pico.deepsea-theme'],
  ['global-memory', 'pico.global-memory'],
  ['goal', 'pico.goal'],
  ['model-parameters', 'pico.model-parameters'],
  ['openai-provider', 'pico.openai-provider'],
  ['permissions', 'pico.permissions'],
  ['project-context', 'pico.project-context'],
  ['qq-adapter', 'pico.qq-adapter'],
  ['rolling-context', 'pico.rolling-context'],
  ['todo', 'pico.todo'],
  ['usage', 'pico.usage'],
  ['vision', 'pico.vision'],
]);

const ALL_TARGETS = ['runtime', 'web', ...[...PLUGIN_SOURCE_TO_ID.values()].map((id) => `plugin-ui:${id}`)];
const PUBLIC_UI_TARGETS = [
  'web',
  ...[
    'pico.chatgpt-plan',
    'pico.collaboration',
    'pico.global-memory',
    'pico.goal',
    'pico.openai-provider',
    'pico.permissions',
    'pico.project-context',
    'pico.qq-adapter',
    'pico.rolling-context',
    'pico.todo',
    'pico.usage',
  ].map((id) => `plugin-ui:${id}`),
];
const KNOWN_PLUGIN_SOURCE_SEGMENTS = new Set([
  ...PLUGIN_SOURCE_TO_ID.keys(),
  ...[...PLUGIN_SOURCE_TO_ID.keys()].map((name) => `${name}.ts`),
  'builtin.ts',
  'host.ts',
  'services.ts',
  'ui-protocol.ts',
  'test',
]);
const SHARED_BUILD_CONFIG = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vite.config.ts',
]);

function result(kind, details = {}) {
  return { kind, ...details };
}

/** Classify a repository-relative path into a release target or an explicit non-release disposition. */
export function classifyPath(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return result('block', { reason: 'Path is empty or invalid.' });
  }
  const normalized = inputPath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return result('block', { reason: 'Path must stay inside the repository.' });
  }

  if (
    /(^|\/)(?:dist|node_modules|data)(?:\/|$)/.test(normalized) ||
    /^plugins\/[^/]+\/runtime\.mjs(?:\.map)?$/.test(normalized) ||
    /^plugins\/[^/]+\/webui\/build(?:\/|$)/.test(normalized) ||
    normalized.startsWith('.pico-deploy-')
  ) {
    return result('ignore', { reason: 'Generated output or local runtime data.' });
  }

  if (
    normalized === 'LICENSE' ||
    normalized.startsWith('docs/') ||
    normalized.startsWith('design-docs/') ||
    /(^|\/)(?:README|CHANGELOG)(?:\.[^/]*)?$/.test(normalized) ||
    normalized.startsWith('.github/')
  ) {
    return result('ignore', { reason: 'Documentation changes do not require deployment or product checks.' });
  }

  if (
    normalized.startsWith('test/') ||
    /(^|\/)(?:__tests__|test|tests)\//.test(normalized) ||
    normalized === 'eslint.config.js' ||
    /^vitest\.config\.[^/]+$/.test(normalized)
  ) {
    return result('check', {
      action: normalized === 'eslint.config.js' ? 'run-lint' : 'run-tests',
      reason: 'Validation input changes require checks but do not change the release payload.',
    });
  }

  if (normalized === 'scripts/deploy-production.mjs') {
    return result('ignore', {
      reason: 'Deployment orchestration changes require operator review; they do not define release payload.',
    });
  }

  if (SHARED_BUILD_CONFIG.has(normalized) || /^tsconfig\.[^/]+\.json$/.test(normalized)) {
    return result('deploy', {
      targets: ALL_TARGETS,
      action: 'full',
      reason: 'Shared dependency or build configuration can affect every release target.',
    });
  }

  if (normalized.startsWith('src/contracts/')) {
    return result('deploy', {
      targets: ALL_TARGETS,
      action: 'full',
      reason: 'Shared protocol contracts can change compatibility across Runtime, WebUI, and plugin UIs.',
    });
  }

  if (normalized === 'src/plugins/ui-protocol.ts') {
    return result('deploy', {
      targets: ALL_TARGETS,
      action: 'full',
      reason: 'Shared plugin UI protocol can affect every runtime and UI release target.',
    });
  }

  if (normalized.startsWith('public/')) {
    return result('deploy', {
      targets: PUBLIC_UI_TARGETS,
      action: 'web-build',
      reason: 'Shared public assets are referenced by the main UI and plugin pages.',
    });
  }

  if (normalized === 'index.html' || normalized.startsWith('src/web/')) {
    return result('deploy', { targets: ['web'], action: 'web-build', reason: 'Main WebUI source or static asset.' });
  }

  if (normalized.startsWith('src/plugins/')) {
    const sourceSegment = normalized.slice('src/plugins/'.length).split('/')[0];
    if (!KNOWN_PLUGIN_SOURCE_SEGMENTS.has(sourceSegment)) {
      return result('block', { reason: 'Plugin source path has no reviewed Runtime or WebUI mapping.' });
    }
    if (normalized.startsWith('src/plugins/test/')) {
      return result('ignore', { reason: 'Plugin tests do not require deployment.' });
    }
    const pureUiEntries = new Map([
      ['src/plugins/chatgpt-plan/webui-entry.tsx', 'pico.chatgpt-plan'],
      ['src/plugins/openai-provider/webui.tsx', 'pico.openai-provider'],
    ]);
    const pluginId = pureUiEntries.get(normalized);
    if (pluginId) {
      return result('deploy', {
        targets: [`plugin-ui:${pluginId}`],
        action: 'plugin-ui-build',
        reason: `Reviewed pure WebUI entry for ${pluginId}.`,
      });
    }
    return result('deploy', {
      targets: ['runtime'],
      action: 'full',
      reason: 'Plugin host or plugin implementation changes require a Runtime rebuild and restart.',
    });
  }

  if (normalized.startsWith('plugins/')) {
    const [, pluginId, ...parts] = normalized.split('/');
    if (pluginId === 'README.md') {
      return result('ignore', { reason: 'Plugin documentation does not affect the release payload.' });
    }
    if (pluginId === 'example-plugin.mjs') {
      return result('deploy', {
        targets: ['runtime'],
        action: 'full',
        reason: 'Root-level plugin module loaded by PluginHost requires Runtime replacement.',
      });
    }
    if (!PLUGIN_SOURCE_TO_ID.has(pluginId.replace(/^pico\./, '').replace(/\.mjs$/, ''))) {
      return result('block', { reason: 'Plugin directory has no reviewed release mapping.' });
    }
    if (parts[0] === 'webui') {
      return result('deploy', {
        targets: [`plugin-ui:${pluginId}`],
        action: 'plugin-ui-build',
        reason: `WebUI source or assets for ${pluginId}.`,
      });
    }
    if (/^pico\.[a-z0-9-]+\.mjs$/.test(pluginId) || parts[0] === 'runtime.ts') {
      return result('deploy', {
        targets: ['runtime'],
        action: 'full',
        reason: 'Plugin runtime source requires Runtime replacement.',
      });
    }
    if (parts[0] === 'vite.config.ts' || parts[0] === 'vite.config.mts') {
      return result('deploy', {
        targets: [`plugin-ui:${pluginId}`],
        action: 'plugin-ui-build',
        reason: `Build configuration for ${pluginId} WebUI.`,
      });
    }
    if (parts[0] === 'README.md' || parts[0] === 'package.json') {
      return result('ignore', {
        reason: 'Plugin documentation or package metadata is not shipped as a release artifact.',
      });
    }
    return result('block', { reason: 'Plugin path has no explicit release mapping.' });
  }

  if (
    normalized.startsWith('src/') ||
    normalized.startsWith('scripts/') ||
    normalized.startsWith('config/') ||
    normalized.startsWith('migrations/') ||
    normalized === 'eslint.config.js'
  ) {
    if (normalized.startsWith('scripts/deploy/')) {
      return result('ignore', { reason: 'Deployment planner source is operational tooling, not application payload.' });
    }
    if (normalized.startsWith('scripts/')) {
      return result('deploy', {
        targets: ['runtime'],
        action: 'full',
        reason: 'Build or runtime launcher changes require Runtime replacement.',
      });
    }
    if (/\.(?:ts|mts|tsx|js|mjs|cjs|json|sql|css|html)$/.test(normalized)) {
      return result('deploy', {
        targets: ['runtime'],
        action: 'full',
        reason: 'Runtime, Core, or Executor implementation change.',
      });
    }
  }

  if (normalized.startsWith('.') || normalized.endsWith('.md') || normalized.endsWith('.map')) {
    return result('ignore', { reason: 'Repository metadata, documentation, or source map.' });
  }
  return result('block', { reason: 'Path has no explicit release classification.' });
}

export function releaseTargets() {
  return [...ALL_TARGETS];
}

export function normalizeRelativePath(rootDir, relativePath) {
  return path.relative(rootDir, path.resolve(rootDir, relativePath)).split(path.sep).join('/');
}
