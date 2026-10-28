export interface LegacyPluginStorageMigrationPort {
  setPrivateSecret(owner: string, key: string, value: unknown): void;
  setPluginCache(pluginId: string, key: string, value: unknown): void;
  deleteLegacyState(pluginId: string, key: string): void;
}

/** Move old secret/cache rows out of Plugin State before general workflow facts are imported. */
export function migrateLegacyPluginStorage(
  pluginId: string,
  key: string,
  value: unknown,
  port: LegacyPluginStorageMigrationPort,
): boolean {
  if (pluginId === 'pico.chatgpt-plan' && key === 'oauth') {
    port.setPrivateSecret(pluginId, key, value);
    port.deleteLegacyState(pluginId, key);
    return true;
  }
  if (
    (pluginId === 'pico.chatgpt-plan' && key === 'modelCatalog') ||
    (pluginId === 'pico.permissions' && key === 'availableTools')
  ) {
    port.setPluginCache(pluginId, key, value);
    port.deleteLegacyState(pluginId, key);
    return true;
  }
  return false;
}

/** Refuse the historical OAuth-in-Plugin-State API and direct callers to secret storage. */
export function assertPluginStateWriteAllowed(pluginId: string, key: string): void {
  if (pluginId === 'pico.chatgpt-plan' && key === 'oauth') {
    throw new Error('OAuth credentials must be written through Plugin Secrets, not Plugin State.');
  }
}
