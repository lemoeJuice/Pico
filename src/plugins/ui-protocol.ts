import type {
  Execution,
  ModelSettings,
  PublicSettings,
  Thread,
  ToolCall,
  ToolResultPayload,
  UiContribution,
  ExecutionStatus,
} from '../core/types.js';

export const PLUGIN_UI_PROTOCOL_VERSION = 1;
export const PLUGIN_COMPOSER_CONTROL_HEIGHT_PX = 32;
export type PluginUiSlot = UiContribution['slot'];
export type PluginUiEvent = { type: string; [key: string]: unknown };
export interface PluginUiPopoverMessage {
  type: 'pico:plugin-ui:popover';
  open: boolean;
  width: number;
  height: number;
}

export interface PluginUiToolbarStateMessage {
  type: 'pico:plugin-ui:toolbar-state';
  badgeCount: number;
}

export interface PluginUiVisibilityMessage {
  type: 'pico:plugin-ui:visibility';
  visible: boolean;
  width?: number;
}

export function isPluginUiVisibilityMessage(value: unknown): value is PluginUiVisibilityMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.type === 'pico:plugin-ui:visibility' && typeof message.visible === 'boolean' &&
    (message.width === undefined || (typeof message.width === 'number' && Number.isFinite(message.width) && message.width >= 0));
}

export function isPluginUiPopoverMessage(value: unknown): value is PluginUiPopoverMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'pico:plugin-ui:popover' &&
    typeof message.open === 'boolean' &&
    typeof message.width === 'number' &&
    Number.isFinite(message.width) &&
    typeof message.height === 'number' &&
    Number.isFinite(message.height)
  );
}

export function isPluginUiToolbarStateMessage(value: unknown): value is PluginUiToolbarStateMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'pico:plugin-ui:toolbar-state' &&
    typeof message.badgeCount === 'number' &&
    Number.isInteger(message.badgeCount) &&
    message.badgeCount >= 0 &&
    message.badgeCount <= 999
  );
}

export interface PluginUiContext {
  thread: Thread | null;
  /** Narrow identity for a result-area action; does not expose the Thread object or Tool arguments. */
  threadId?: string;
  execution?: Execution;
  toolCall?: ToolCall;
  result?: ToolResultPayload;
  toolResult?: { executionId: string; status: ExecutionStatus };
}

export function samePluginUiContext(left: PluginUiContext, right: PluginUiContext): boolean {
  return (
    left.thread === right.thread &&
    left.execution === right.execution &&
    left.toolCall === right.toolCall &&
    left.result === right.result &&
    left.threadId === right.threadId &&
    left.toolResult?.executionId === right.toolResult?.executionId &&
    left.toolResult?.status === right.toolResult?.status
  );
}

export function pluginUiEventMatchesPlugin(event: PluginUiEvent, pluginId: string): boolean {
  return event.type === 'plugin.updated' && event.pluginId === pluginId;
}

export type PluginApiInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: string;
};

export interface PluginUiProps {
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  executeCommand(command: string): Promise<unknown>;
  settings: PublicSettings;
  context: PluginUiContext;
  updateModelSettings(update: PluginModelSettingsUpdate): Promise<void>;
  openPage(pluginId: string, pageId: string): void;
  openThread(threadId: string): Promise<void>;
  openMessage(seq: number): Promise<void>;
  onError(message: string): void;
  onNotice(message: string): void;
}

export type PluginModelSettingsUpdate = Partial<Pick<ModelSettings, 'baseUrl' | 'model' | 'provider' | 'temperature'>>;

export type PluginUiRequest =
  | { type: 'pico:plugin-ui:request'; id: string; action: 'api'; path: string; init?: PluginApiInit }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'command'; command: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'update-model-settings'; update: PluginModelSettingsUpdate }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-page'; pluginId: string; pageId: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-thread'; threadId: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-message'; seq: number }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'error' | 'notice'; message: string };

export type PluginUiRequestPayload =
  | { action: 'api'; path: string; init?: PluginApiInit }
  | { action: 'command'; command: string }
  | { action: 'update-model-settings'; update: PluginModelSettingsUpdate }
  | { action: 'open-page'; pluginId: string; pageId: string }
  | { action: 'open-thread'; threadId: string }
  | { action: 'open-message'; seq: number }
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
  uiSlot?: PluginUiSlot;
  controlHeightPx?: number;
  popover?: boolean;
  settings: PublicSettings;
  context: PluginUiContext;
}

export function pluginUiLayoutForSlot(
  uiSlot?: PluginUiSlot,
  popover = false,
): Pick<PluginUiInitMessage, 'uiSlot' | 'controlHeightPx' | 'popover'> {
  if (!uiSlot) return {};
  if (uiSlot === 'composer.model' && popover) return { uiSlot, popover: true };
  return uiSlot === 'composer.model' ? { uiSlot, controlHeightPx: PLUGIN_COMPOSER_CONTROL_HEIGHT_PX } : { uiSlot };
}

export interface PluginUiClient {
  props(settings: PublicSettings, context?: PluginUiContext): PluginUiProps;
  subscribeSettings(listener: (settings: PublicSettings) => void): () => void;
  subscribeContext(listener: (context: PluginUiContext) => void): () => void;
  subscribeEvents(listener: (event: PluginUiEvent) => void): () => void;
  resize(height: number): void;
  /** Pass preferred content width for inline composer.model controls. */
  reportVisibility(visible: boolean, width?: number): void;
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

export function createPluginUiClient(
  port: MessagePort,
  initialSettings: PublicSettings,
  initialContext: PluginUiContext = { thread: null },
): PluginUiClient {
  let sequence = 0;
  let settings = initialSettings;
  let context = initialContext;
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(value: PublicSettings) => void>();
  const contextListeners = new Set<(value: PluginUiContext) => void>();
  const eventListeners = new Set<(value: PluginUiEvent) => void>();

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
      | PluginUiResponse
      | { type: 'pico:plugin-ui:settings'; settings: PublicSettings }
      | { type: 'pico:plugin-ui:context'; context: PluginUiContext }
      | { type: 'pico:plugin-ui:event'; event: PluginUiEvent }
      | null;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pico:plugin-ui:settings') {
      settings = message.settings;
      for (const listener of listeners) listener(settings);
      return;
    }
    if (message.type === 'pico:plugin-ui:context') {
      context = message.context;
      for (const listener of contextListeners) listener(context);
      return;
    }
    if (message.type === 'pico:plugin-ui:event') {
      for (const listener of eventListeners) listener(message.event);
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
    props(currentSettings, currentContext = context) {
      settings = currentSettings;
      context = currentContext;
      return {
        api: (path, init) => request({ action: 'api', path, ...(init ? { init } : {}) }),
        executeCommand: (command) => request({ action: 'command', command }),
        settings: currentSettings,
        context: currentContext,
        updateModelSettings: async (update) => {
          await request({ action: 'update-model-settings', update });
        },
        openPage: (pluginId, pageId) => {
          void request({ action: 'open-page', pluginId, pageId }).catch(() => undefined);
        },
        openThread: async (threadId) => {
          await request({ action: 'open-thread', threadId });
        },
        openMessage: async (seq) => {
          await request({ action: 'open-message', seq });
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
    subscribeContext(listener) {
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    resize(height) {
      if (!closed && Number.isFinite(height)) port.postMessage({ type: 'pico:plugin-ui:resize', height });
    },
    reportVisibility(visible, width) {
      if (!closed) port.postMessage({ type: 'pico:plugin-ui:visibility', visible, ...(width === undefined ? {} : { width }) });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handler of pending.values()) handler.reject(new Error('Pico plugin UI connection closed.'));
      pending.clear();
      listeners.clear();
      contextListeners.clear();
      eventListeners.clear();
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
    case 'command':
      return typeof message.command === 'string' && message.command.length > 0 && message.command.length <= 200;
    case 'update-model-settings':
      return isPluginModelSettingsUpdate(message.update);
    case 'open-page':
      return typeof message.pluginId === 'string' && typeof message.pageId === 'string';
    case 'open-thread':
      return typeof message.threadId === 'string' && message.threadId.length > 0 && message.threadId.length <= 200;
    case 'open-message':
      return Number.isSafeInteger(message.seq) && (message.seq as number) >= 0;
    case 'error':
    case 'notice':
      return typeof message.message === 'string';
    default:
      return false;
  }
}
