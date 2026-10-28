import type { PicoStore } from '../../core/store.js';
import type { ModelAdapter } from '../../runtime/model.js';
import type { RuntimeOptions } from '../../runtime/runtime.js';
import { setupRuntime } from '../../../test/helpers.js';
import { autoThreadTitlePlugin } from '../auto-thread-title.js';
import { collaborationPlugin } from '../collaboration.js';
import { modelParametersPlugin } from '../model-parameters/index.js';
import { permissionPlugin } from '../permissions.js';
import { projectContextPlugin } from '../project-context.js';
import { visionPlugin } from '../vision.js';

/** Integration fixture for tests that exercise the standard business plugin set. */
export function setupRuntimeWithStandardPlugins(model: ModelAdapter, options: RuntimeOptions = {}) {
  const providedPlugins = options.plugins ?? [];
  const standardPlugins = options.pluginDirectory
    ? []
    : [
        permissionPlugin,
        projectContextPlugin,
        collaborationPlugin,
        modelParametersPlugin,
        autoThreadTitlePlugin,
        visionPlugin,
      ].filter(
        (plugin) =>
          !providedPlugins.some((provided) => provided.id === plugin.id) &&
          !options.disabledBuiltinPlugins?.includes(plugin.id),
      );
  return setupRuntime(model, { ...options, plugins: [...standardPlugins, ...providedPlugins] });
}

export function setToolPolicy(store: PicoStore, threadId: string, toolName: string, policy: 'allow' | 'ask' | 'deny') {
  const rules = store.getPluginState<Record<string, Record<string, 'allow' | 'ask' | 'deny'>>>(
    'pico.permissions',
    'rules',
    {},
  );
  store.setPluginState('pico.permissions', 'rules', {
    ...rules,
    [threadId]: { ...(rules[threadId] ?? {}), [toolName]: policy },
  });
}
