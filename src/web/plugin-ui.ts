import type { ComponentType } from 'react';
import type { ModelSettings, PublicSettings } from '../core/types.js';

export interface PluginUiProps {
  api<T>(path: string, init?: RequestInit): Promise<T>;
  settings: PublicSettings;
  updateModelSettings(update: Partial<ModelSettings>): Promise<void>;
  openPage(pluginId: string, pageId: string): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

export interface PluginWebUiEntry {
  pages?: Record<string, ComponentType<PluginUiProps>>;
  components?: Record<string, ComponentType<PluginUiProps>>;
}

export interface PluginWebUiModule {
  pluginId: string;
  entries: Record<string, PluginWebUiEntry>;
}

const pluginModules = Object.values(
  import.meta.glob<{ default?: PluginWebUiModule }>('../plugins/**/webui.tsx', { eager: true }),
).flatMap((module) => (module.default ? [module.default] : []));

function entryFor(pluginId: string, entryId: string): PluginWebUiEntry | undefined {
  return pluginModules.find((module) => module.pluginId === pluginId)?.entries[entryId];
}

export function pluginPageComponent(
  pluginId: string,
  entryId: string,
  pageId: string,
): ComponentType<PluginUiProps> | undefined {
  return entryFor(pluginId, entryId)?.pages?.[pageId];
}

export function pluginComponent(
  pluginId: string,
  entryId: string,
  componentId: string,
): ComponentType<PluginUiProps> | undefined {
  return entryFor(pluginId, entryId)?.components?.[componentId];
}
