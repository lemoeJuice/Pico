import type {
  Execution,
  ModelSettings,
  PublicSettings,
  Thread,
  ThreadModelSelection,
  ToolCall,
  ToolResultPayload,
  UiContribution,
  ExecutionStatus,
} from '../core/types.js';

export const PLUGIN_UI_PROTOCOL_VERSION = 1;
export const PLUGIN_COMPOSER_CONTROL_HEIGHT_PX = 32;
export type PluginUiSlot = UiContribution['slot'];
export type PluginUiGroupLayout =
  'row' | 'spread' | 'form-row' | 'grid-2' | 'grid-compact' | 'grid-standard' | 'masonry' | 'stack-compact';
/** Serializable, host-rendered UI vocabulary. It intentionally has no HTML, CSS, URL or DOM escape hatch. */
export type PluginUiNode =
  | { type: 'text'; text: string }
  | { type: 'heading'; text: string; level?: 2 | 3 | 4 }
  | { type: 'paragraph'; text: string }
  | { type: 'group'; children: PluginUiNode[]; layout?: PluginUiGroupLayout }
  | { type: 'card' | 'actions'; children: PluginUiNode[] }
  | {
      type: 'button';
      label: string;
      actionId: string;
      tone?: 'primary' | 'soft' | 'danger' | 'quiet';
      disabled?: boolean;
      externalAuth?: true;
    }
  | {
      type: 'fieldButton';
      label: string;
      actionId: string;
      tone?: 'primary' | 'soft' | 'danger' | 'quiet';
      disabled?: boolean;
    }
  | {
      type: 'textInput';
      label: string;
      value?: string;
      placeholder?: string;
      actionId: string;
      inputType?: 'text' | 'date' | 'number' | 'password';
      min?: number;
      step?: number | 'any';
      maxLength?: number;
      disabled?: boolean;
    }
  | { type: 'checkbox'; label: string; checked: boolean; actionId: string; disabled?: boolean }
  | {
      type: 'switch';
      label: string;
      checked: boolean;
      actionId: string;
      disabled?: boolean;
      visuallyHidden?: boolean;
    }
  | { type: 'status'; text: string; tone?: 'success' | 'neutral' | 'danger' }
  | {
      type: 'range';
      label: string;
      value: number;
      min: number;
      max: number;
      step: number;
      valueLabel?: string;
      actionId: string;
      disabled?: boolean;
    }
  | {
      type: 'textArea';
      label: string;
      value?: string;
      placeholder?: string;
      actionId: string;
      rows?: 'compact' | 'standard' | 'large';
      maxLength?: number;
      disabled?: boolean;
    }
  | {
      type: 'select';
      label: string;
      value?: string;
      actionId: string;
      options: Array<{ label: string; value: string }>;
      disabled?: boolean;
    }
  | { type: 'disclosure'; label: string; open: boolean; actionId: string; children: PluginUiNode[] }
  | { type: 'list'; ordered: boolean; items: PluginUiNode[] }
  | { type: 'table'; columns: string[]; rows: string[][] };

export type PluginUiAction = { actionId: string; value?: string; event?: 'submit'; popupLeaseId?: string };
export type PluginUiNotice = { text: string };

const UI_LIMITS = {
  nodes: 2048,
  depth: 12,
  text: 20000,
  totalText: 200000,
  actions: 512,
  options: 80,
  tableRows: 300,
  tableCells: 2100,
} as const;
const uiNodeTypesBySlot: Record<PluginUiSlot, ReadonlySet<PluginUiNode['type']>> = {
  'thread.toolbar': new Set([
    'text',
    'status',
    'heading',
    'paragraph',
    'group',
    'card',
    'actions',
    'button',
    'fieldButton',
    'textInput',
    'checkbox',
    'switch',
    'range',
    'textArea',
    'select',
    'disclosure',
    'list',
    'table',
  ]),
  'composer.action': new Set(['text', 'button']),
  'composer.model': new Set(['text', 'group', 'button', 'select', 'switch', 'range', 'textInput']),
  'composer.status': new Set(['text']),
  'sidebar.panel': new Set([
    'text',
    'status',
    'heading',
    'paragraph',
    'group',
    'card',
    'actions',
    'button',
    'fieldButton',
    'textInput',
    'checkbox',
    'switch',
    'range',
    'textArea',
    'select',
    'disclosure',
    'list',
    'table',
  ]),
  'tool.result': new Set(['text', 'paragraph', 'group', 'actions', 'button']),
};

export function validatePluginUiTree(value: unknown, slot: PluginUiSlot | 'settings.page'): value is PluginUiNode[] {
  if (!Array.isArray(value) || value.length > UI_LIMITS.nodes) return false;
  let count = 0;
  const actions = new Set<string>();
  const allowed =
    slot === 'settings.page'
      ? new Set<PluginUiNode['type']>([
          'text',
          'status',
          'heading',
          'paragraph',
          'group',
          'card',
          'actions',
          'button',
          'fieldButton',
          'textInput',
          'checkbox',
          'switch',
          'range',
          'textArea',
          'select',
          'disclosure',
          'list',
          'table',
        ])
      : uiNodeTypesBySlot[slot];
  let totalText = 0;
  const textOk = (text: unknown): text is string => {
    if (typeof text !== 'string' || text.length > UI_LIMITS.text) return false;
    totalText += text.length;
    return totalText <= UI_LIMITS.totalText;
  };
  const walk = (node: unknown, depth: number): boolean => {
    if (
      ++count > UI_LIMITS.nodes ||
      depth > UI_LIMITS.depth ||
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node)
    )
      return false;
    const item = node as Record<string, unknown>;
    if (typeof item.type !== 'string' || !allowed.has(item.type as PluginUiNode['type'])) return false;
    const fields: Record<string, string[]> = {
      text: ['type', 'text'],
      heading: ['type', 'text', 'level'],
      paragraph: ['type', 'text'],
      group: ['type', 'children', 'layout'],
      card: ['type', 'children'],
      actions: ['type', 'children'],
      button: ['type', 'label', 'actionId', 'tone', 'disabled', 'externalAuth'],
      fieldButton: ['type', 'label', 'actionId', 'tone', 'disabled'],
      textInput: [
        'type',
        'label',
        'value',
        'placeholder',
        'actionId',
        'inputType',
        'min',
        'step',
        'maxLength',
        'disabled',
      ],
      checkbox: ['type', 'label', 'checked', 'actionId', 'disabled'],
      switch: ['type', 'label', 'checked', 'actionId', 'disabled', 'visuallyHidden'],
      status: ['type', 'text', 'tone'],
      range: ['type', 'label', 'value', 'min', 'max', 'step', 'valueLabel', 'actionId', 'disabled'],
      textArea: ['type', 'label', 'value', 'placeholder', 'actionId', 'rows', 'maxLength', 'disabled'],
      select: ['type', 'label', 'value', 'actionId', 'options', 'disabled'],
      disclosure: ['type', 'label', 'open', 'actionId', 'children'],
      list: ['type', 'ordered', 'items'],
      table: ['type', 'columns', 'rows'],
    };
    if (Object.keys(item).some((key) => !fields[item.type as string]?.includes(key))) return false;
    const action = (): boolean =>
      typeof item.actionId === 'string' &&
      /^[a-zA-Z0-9._:-]{1,80}$/.test(item.actionId) &&
      !actions.has(item.actionId) &&
      (actions.add(item.actionId), actions.size <= UI_LIMITS.actions);
    switch (item.type) {
      case 'text':
      case 'heading':
      case 'paragraph':
        return textOk(item.text) && (item.level === undefined || [2, 3, 4].includes(item.level as number));
      case 'status':
        return (
          textOk(item.text) && (item.tone === undefined || ['success', 'neutral', 'danger'].includes(String(item.tone)))
        );
      case 'group':
        if (
          item.layout !== undefined &&
          ![
            'row',
            'spread',
            'form-row',
            'grid-2',
            'grid-compact',
            'grid-standard',
            'masonry',
            'stack-compact',
          ].includes(String(item.layout))
        )
          return false;
        return (
          Array.isArray(item.children) &&
          item.children.length <= UI_LIMITS.nodes &&
          item.children.every((child) => walk(child, depth + 1))
        );
      case 'card':
      case 'actions':
        return (
          Array.isArray(item.children) &&
          item.children.length <= UI_LIMITS.nodes &&
          item.children.every((child) => walk(child, depth + 1))
        );
      case 'list':
        return (
          typeof item.ordered === 'boolean' &&
          Array.isArray(item.items) &&
          item.items.length <= UI_LIMITS.nodes &&
          item.items.every((child) => walk(child, depth + 1))
        );
      case 'disclosure':
        return (
          textOk(item.label) &&
          typeof item.open === 'boolean' &&
          action() &&
          Array.isArray(item.children) &&
          item.children.length <= UI_LIMITS.nodes &&
          item.children.every((child) => walk(child, depth + 1))
        );
      case 'table': {
        if (!Array.isArray(item.columns) || item.columns.length === 0 || item.columns.length > 12) return false;
        const columns = item.columns;
        if (!columns.every(textOk) || !Array.isArray(item.rows)) return false;
        const rows = item.rows;
        return (
          rows.length <= UI_LIMITS.tableRows &&
          rows.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : UI_LIMITS.tableCells + 1), 0) <=
            UI_LIMITS.tableCells &&
          rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every(textOk))
        );
      }
      case 'button':
        return (
          textOk(item.label) &&
          action() &&
          (item.tone === undefined || ['primary', 'soft', 'danger', 'quiet'].includes(String(item.tone))) &&
          (item.disabled === undefined || typeof item.disabled === 'boolean') &&
          (item.externalAuth === undefined || item.externalAuth === true)
        );
      case 'fieldButton':
        return (
          textOk(item.label) &&
          action() &&
          (item.tone === undefined || ['primary', 'soft', 'danger', 'quiet'].includes(String(item.tone))) &&
          (item.disabled === undefined || typeof item.disabled === 'boolean')
        );
      case 'checkbox':
      case 'switch':
        return (
          textOk(item.label) &&
          typeof item.checked === 'boolean' &&
          (item.disabled === undefined || typeof item.disabled === 'boolean') &&
          (item.type !== 'switch' || item.visuallyHidden === undefined || typeof item.visuallyHidden === 'boolean') &&
          action()
        );
      case 'range':
        return (
          textOk(item.label) &&
          Number.isFinite(item.value) &&
          Number.isFinite(item.min) &&
          Number.isFinite(item.max) &&
          Number.isFinite(item.step) &&
          (item.max as number) > (item.min as number) &&
          (item.step as number) > 0 &&
          (item.value as number) >= (item.min as number) &&
          (item.value as number) <= (item.max as number) &&
          (item.valueLabel === undefined || textOk(item.valueLabel)) &&
          (item.disabled === undefined || typeof item.disabled === 'boolean') &&
          action()
        );
      case 'textInput':
      case 'textArea':
        return (
          textOk(item.label) &&
          (item.value === undefined || textOk(item.value)) &&
          (item.placeholder === undefined || textOk(item.placeholder)) &&
          (item.type !== 'textInput' ||
            ((item.inputType === undefined ||
              ['text', 'date', 'number', 'password'].includes(String(item.inputType))) &&
              (item.min === undefined || (item.inputType === 'number' && Number.isFinite(item.min))) &&
              (item.step === undefined ||
                (item.inputType === 'number' &&
                  (item.step === 'any' || (Number.isFinite(item.step) && (item.step as number) > 0)))))) &&
          (item.disabled === undefined || typeof item.disabled === 'boolean') &&
          action() &&
          (item.maxLength === undefined ||
            (Number.isInteger(item.maxLength) &&
              (item.maxLength as number) >= 0 &&
              (item.maxLength as number) <= UI_LIMITS.text)) &&
          (item.type !== 'textArea' ||
            item.rows === undefined ||
            ['compact', 'standard', 'large'].includes(String(item.rows)))
        );
      case 'select':
        return (
          textOk(item.label) &&
          (item.value === undefined || textOk(item.value)) &&
          (item.disabled === undefined || typeof item.disabled === 'boolean') &&
          action() &&
          Array.isArray(item.options) &&
          item.options.length <= UI_LIMITS.options &&
          item.options.every((option) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
            const fields = option as Record<string, unknown>;
            return (
              Object.keys(fields).every((key) => key === 'label' || key === 'value') &&
              Object.keys(fields).length === 2 &&
              textOk(fields.label) &&
              textOk(fields.value)
            );
          })
        );
      default:
        return false;
    }
  };
  return value.every((node) => walk(node, 0));
}

export type PluginUiEvent = { type: string; [key: string]: unknown };
export interface PluginUiToolbarStateMessage {
  type: 'pico:plugin-ui:toolbar-state';
  badgeCount: number;
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
  providerInstanceId?: string;
  modelSelection?: ThreadModelSelection;
  /** Narrow identity for a result-area action; does not expose the Thread object or Tool arguments. */
  threadId?: string;
  execution?: Execution;
  toolCall?: ToolCall;
  result?: ToolResultPayload;
  toolResult?: { executionId: string; status: ExecutionStatus };
}

export function samePluginUiContext(left: PluginUiContext, right: PluginUiContext): boolean {
  return (
    (left.thread === right.thread ||
      (left.thread !== null &&
        right.thread !== null &&
        left.thread.id === right.thread.id &&
        JSON.stringify(left.thread) === JSON.stringify(right.thread))) &&
    JSON.stringify(left.modelSelection ?? null) === JSON.stringify(right.modelSelection ?? null) &&
    left.execution === right.execution &&
    left.toolCall === right.toolCall &&
    left.result === right.result &&
    left.threadId === right.threadId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.toolResult?.executionId === right.toolResult?.executionId &&
    left.toolResult?.status === right.toolResult?.status
  );
}

export function samePluginUiContextForSlot(
  left: PluginUiContext,
  right: PluginUiContext,
  slot: PluginUiSlot | undefined,
): boolean {
  if (slot !== 'composer.model') return samePluginUiContext(left, right);
  return (
    left.thread?.id === right.thread?.id &&
    JSON.stringify(left.modelSelection ?? null) === JSON.stringify(right.modelSelection ?? null)
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
  updateModelSettings(update: PluginModelSettingsUpdate, threadId?: string): Promise<void>;
  openPage(pluginId: string, pageId: string): void;
  openThread(threadId: string): Promise<void>;
  openMessage(seq: number): Promise<void>;
  onError(message: string): void;
  onNotice(message: string): void;
}

export type PluginModelSettingsUpdate = Partial<Pick<ModelSettings, 'baseUrl' | 'model' | 'provider' | 'temperature'>>;

export type PluginUiRequest =
  | { type: 'pico:plugin-ui:request'; id: string; action: 'api'; path: string; init?: PluginApiInit }
  | {
      type: 'pico:plugin-ui:request';
      id: string;
      action: 'auth-popup-navigate';
      leaseId: string;
      authorizationUrl: string;
      callbackOrigin: string;
      operationId: string;
    }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'command'; command: string }
  | {
      type: 'pico:plugin-ui:request';
      id: string;
      action: 'update-model-settings';
      update: PluginModelSettingsUpdate;
      threadId?: string;
    }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-page'; pluginId: string; pageId: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-thread'; threadId: string }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'open-message'; seq: number }
  | { type: 'pico:plugin-ui:request'; id: string; action: 'error' | 'notice'; message: string };

export type PluginUiRequestPayload =
  | { action: 'api'; path: string; init?: PluginApiInit }
  | {
      action: 'auth-popup-navigate';
      leaseId: string;
      authorizationUrl: string;
      callbackOrigin: string;
      operationId: string;
    }
  | { action: 'command'; command: string }
  | { action: 'update-model-settings'; update: PluginModelSettingsUpdate; threadId?: string }
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
  /** Correlates the iframe's ready response with the host's diagnostic record. */
  attemptId?: string;
  pluginId: string;
  entry: string;
  viewType: 'page' | 'component';
  viewId: string;
  uiSlot?: PluginUiSlot;
  popover?: boolean;
  externalAuthOrigins?: string[];
  settings: PublicSettings;
  context: PluginUiContext;
}

export function pluginUiLayoutForSlot(
  uiSlot?: PluginUiSlot,
  popover = false,
): Pick<PluginUiInitMessage, 'uiSlot' | 'popover'> {
  if (!uiSlot) return {};
  if (uiSlot === 'composer.model' && popover) return { uiSlot, popover: true };
  return { uiSlot };
}

export interface PluginUiClient {
  props(settings: PublicSettings, context?: PluginUiContext): PluginUiProps;
  subscribeSettings(listener: (settings: PublicSettings) => void): () => void;
  subscribeContext(listener: (context: PluginUiContext) => void): () => void;
  subscribeEvents(listener: (event: PluginUiEvent) => void): () => void;
  subscribeActions(listener: (action: PluginUiAction) => void): () => void;
  navigateAuthPopup(
    leaseId: string,
    authorizationUrl: string,
    callbackOrigin: string,
    operationId: string,
  ): Promise<void>;
  render(tree: PluginUiNode[]): void;
  ready(attemptId?: string): void;
  close(): void;
}

export function pluginUiUrl(
  pluginId: string,
  entry: string,
  viewType: PluginUiInitMessage['viewType'],
  viewId: string,
  uiSlot?: PluginUiSlot,
): string {
  const path = [pluginId, entry].map(encodeURIComponent).join('/');
  const query = new URLSearchParams({ viewType, viewId, ...(uiSlot ? { uiSlot } : {}) });
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
  const actionListeners = new Set<(value: PluginUiAction) => void>();

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
      | { type: 'pico:plugin-ui:action'; actionId: string; value?: string; event?: 'submit'; popupLeaseId?: string }
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
    if (message.type === 'pico:plugin-ui:action' && typeof message.actionId === 'string') {
      if (message.event !== undefined && message.event !== 'submit') return;
      const action = {
        actionId: message.actionId,
        ...(typeof message.value === 'string' ? { value: message.value } : {}),
        ...(message.event === 'submit' ? { event: message.event } : {}),
        ...(typeof message.popupLeaseId === 'string' ? { popupLeaseId: message.popupLeaseId } : {}),
      };
      for (const listener of actionListeners) listener(action);
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
    ready(attemptId) {
      if (typeof attemptId !== 'string' || closed) return;
      port.postMessage({ type: 'pico:plugin-ui:ready', attemptId });
    },
    props(currentSettings, currentContext = context) {
      settings = currentSettings;
      context = currentContext;
      return {
        api: (path, init) => request({ action: 'api', path, ...(init ? { init } : {}) }),
        executeCommand: (command) => request({ action: 'command', command }),
        settings: currentSettings,
        context: currentContext,
        updateModelSettings: async (update, threadId = context.thread?.id) => {
          await request({ action: 'update-model-settings', update, ...(threadId ? { threadId } : {}) });
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
    navigateAuthPopup: async (leaseId, authorizationUrl, callbackOrigin, operationId) => {
      await request({ action: 'auth-popup-navigate', leaseId, authorizationUrl, callbackOrigin, operationId });
    },
    subscribeActions(listener) {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },
    render(tree) {
      if (!closed) port.postMessage({ type: 'pico:plugin-ui:render', tree });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handler of pending.values()) handler.reject(new Error('Pico plugin UI connection closed.'));
      pending.clear();
      listeners.clear();
      contextListeners.clear();
      eventListeners.clear();
      actionListeners.clear();
      port.close();
    },
  };
}

export function isPluginUiRequest(value: unknown): value is PluginUiRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== 'pico:plugin-ui:request' || typeof message.id !== 'string') return false;
  switch (message.action) {
    case 'auth-popup-navigate':
      return (
        typeof message.leaseId === 'string' &&
        typeof message.authorizationUrl === 'string' &&
        typeof message.callbackOrigin === 'string' &&
        typeof message.operationId === 'string'
      );
    case 'api':
      return (
        typeof message.path === 'string' &&
        (message.init === undefined ||
          (Boolean(message.init) && typeof message.init === 'object' && !Array.isArray(message.init)))
      );
    case 'command':
      return typeof message.command === 'string' && message.command.length > 0 && message.command.length <= 200;
    case 'update-model-settings':
      return (
        isPluginModelSettingsUpdate(message.update) &&
        (message.threadId === undefined ||
          (typeof message.threadId === 'string' && message.threadId.length > 0 && message.threadId.length <= 200))
      );
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
