import type { ModelSettings, PublicSettings } from '../core/types.js';

export const PLUGIN_UI_PROTOCOL_VERSION = 1;

export type PluginApiInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: string;
};

export interface PluginUiProps {
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  settings: PublicSettings;
  updateModelSettings(update: PluginModelSettingsUpdate): Promise<void>;
  openPage(pluginId: string, pageId: string): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

export type PluginModelSettingsUpdate = Partial<Pick<ModelSettings, 'baseUrl' | 'model' | 'provider' | 'temperature'>>;

export type PluginUiRequest =
  | { type: 'pico:plugin-ui:request'; id: string; action: 'api'; path: string; init?: PluginApiInit }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'update-model-settings'; update: PluginModelSettingsUpdate }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-page'; pluginId: string; pageId: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'error' | 'notice'; message: string };

export type PluginUiRequestPayload =
  | { action: 'api'; path: string; init?: PluginApiInit }
  | { action: 'update-model-settings'; update: PluginModelSettingsUpdate }
  | { action: 'open-page'; pluginId: string; pageId: string }
  | { action: 'error' | 'notice'; message: string };

export type PluginUiResponse =
  | { type: 'pico:plugin-ui:response'; id: string; ok: true; value?: unknown }
  | { type: 'pico:plugin-ui:response'; id: string; ok: false; error: string };

export interface PluginUiInitMessage {
  type: 'pico:plugin-ui:init';
  protocolVersion: number;
  pluginId: string;
  entry: string;
  viewType: 'page' | 'component';
  viewId: string;
  settings: PublicSettings;
}

export interface PluginUiClient {
  props(settings: PublicSettings): PluginUiProps;
  subscribeSettings(listener: (settings: PublicSettings) => void): () => void;
  resize(height: number): void;
  close(): void;
}

export function pluginUiUrl(
  pluginId: string,
  entry: string,
  viewType: PluginUiInitMessage['viewType'],
  viewId: string,
): string {
  const path = [pluginId, entry].map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ viewType, viewId });
  return `/_pico/plugin-ui/${path}/index.html?${query.toString()}`;
}

export function isPluginApiPath(path: string, pluginId: string): boolean {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) return false;
  if (!path.startsWith('/api/plugins/') || path.startsWith('//') || path.includes('\\')) return false;
  let url: URL;
  try {
    url = new URL(path, 'http://pico.invalid');
  } catch {
    return false;
  }
  return url.origin === 'http://pico.invalid' && url.pathname.startsWith(`/api/plugins/${pluginId}/`);
}

export function isPluginModelSettingsUpdate(value: unknown): value is PluginModelSettingsUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const update = value as Record<string, unknown>;
  const keys = Object.keys(update);
  if (keys.length === 0 || keys.some((key) => !['baseUrl', 'model', 'provider', 'temperature'].includes(key))) {
    return false;
  }
  return keys.every((key) => {
    const field = update[key];
    if (key === 'temperature') return typeof field === 'number' && Number.isFinite(field);
    if (key === 'provider') return typeof field === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(field);
    return typeof field === 'string';
  });
}

export function createPluginUiClient(port: MessagePort, initialSettings: PublicSettings): PluginUiClient {
  let sequence = 0;
  let settings = initialSettings;
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(value: PublicSettings) => void>();

  const request = <T>(payload: PluginUiRequestPayload): Promise<T> => {
    if (closed) return Promise.reject(new Error('Pico plugin UI connection is closed.'));
    const id = `plugin-ui-${++sequence}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      port.postMessage({ type: 'pico:plugin-ui:request', id, ...payload });
    });
  };

  port.onmessage = (event: MessageEvent<unknown>): void => {
    const message = event.data as
      PluginUiResponse | { type: 'pico:plugin-ui:settings'; settings: PublicSettings } | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:settings') {
      settings = message.settings;
      for (const listener of listeners) listener(settings);
      return;
    }
    if (message.type !== 'pico:plugin-ui:response' || typeof message.id !== 'string') return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.ok) handler.resolve(message.value);
    else handler.reject(new Error(message.error));
  };
  port.start();

  return {
    props(currentSettings) {
      settings = currentSettings;
      return {
        api: (path, init) => request({ action: 'api', path, ...(init ? { init } : {}) }),
        settings: currentSettings,
        updateModelSettings: async (update) => {
          await request({ action: 'update-model-settings', update });
        },
        openPage: (pluginId, pageId) => {
          void request({ action: 'open-page', pluginId, pageId }).catch(() => undefined);
        },
        onError: (message) => {
          void request({ action: 'error', message }).catch(() => undefined);
        },
        onNotice: (message) => {
          void request({ action: 'notice', message }).catch(() => undefined);
        },
      };
    },
    subscribeSettings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resize(height) {
      if (!closed && Number.isFinite(height)) port.postMessage({ type: 'pico:plugin-ui:resize', height });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handler of pending.values()) handler.reject(new Error('Pico plugin UI connection closed.'));
      pending.clear();
      listeners.clear();
      port.close();
    },
  };
}

export function isPluginUiRequest(value: unknown): value is PluginUiRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== 'pico:plugin-ui:request' || typeof message.id !== 'string') return false;
  switch (message.action) {
    case 'api':
      return (
        typeof message.path === 'string' &&
        (message.init === undefined ||
          (Boolean(message.init) && typeof message.init === 'object' && !Array.isArray(message.init)))
      );
    case 'update-model-settings':
      return isPluginModelSettingsUpdate(message.update);
    case 'open-page':
      return typeof message.pluginId === 'string' && typeof message.pageId === 'string';
    case 'error':
    case 'notice':
      return typeof message.message === 'string';
    default:
      return false;
  }
}
