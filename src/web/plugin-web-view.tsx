import { useEffect, useRef, type ReactElement } from 'react';
import type { PublicSettings } from '../core/types.js';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiRequest,
  pluginUiLayoutForSlot,
  PLUGIN_UI_PROTOCOL_VERSION,
  pluginUiUrl,
  type PluginApiInit,
  type PluginModelSettingsUpdate,
  type PluginUiInitMessage,
  type PluginUiRequest,
  type PluginUiSlot,
} from '../plugins/ui-protocol.js';

type PluginWebViewProps = {
  pluginId: string;
  entry: string;
  viewType: PluginUiInitMessage['viewType'];
  viewId: string;
  uiSlot?: PluginUiSlot;
  settings: PublicSettings;
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  updateModelSettings(update: PluginModelSettingsUpdate): Promise<void>;
  openPage(pluginId: string, pageId: string): void;
  isRegisteredPage(pluginId: string, pageId: string): boolean;
  onError(message: string): void;
  onNotice(message: string): void;
};

const pluginApiMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function serializedInit(value: PluginApiInit | undefined): PluginApiInit | undefined {
  if (!value) return undefined;
  if (
    value.method !== undefined &&
    (typeof value.method !== 'string' || !pluginApiMethods.has(value.method.toUpperCase()))
  ) {
    throw new Error('Plugin API method is not supported.');
  }
  if (value.body !== undefined && typeof value.body !== 'string') throw new Error('Plugin API body must be text.');
  return {
    ...(value.method === undefined
      ? {}
      : { method: value.method.toUpperCase() as NonNullable<PluginApiInit['method']> }),
    ...(value.body === undefined ? {} : { body: value.body }),
  };
}

export function PluginWebView(props: PluginWebViewProps): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const connected = useRef(false);
  const current = useRef(props);
  current.current = props;

  const src = pluginUiUrl(props.pluginId, props.entry, props.viewType, props.viewId);
  const layout = pluginUiLayoutForSlot(props.uiSlot);

  useEffect(() => {
    portRef.current?.postMessage({ type: 'pico:plugin-ui:settings', settings: props.settings });
  }, [props.settings]);

  useEffect(
    () => () => {
      portRef.current?.close();
      portRef.current = null;
    },
    [],
  );

  const connectFrame = (): void => {
    if (connected.current) return;
    const frameWindow = frame.current?.contentWindow;
    if (!frameWindow) return;
    connected.current = true;
    portRef.current?.close();
    const channel = new MessageChannel();
    const hostPort = channel.port1;
    portRef.current = hostPort;

    hostPort.onmessage = (event: MessageEvent<unknown>): void => {
      const message = event.data as { type?: unknown; height?: unknown } | null;
      if (message?.type === 'pico:plugin-ui:resize' && typeof message.height === 'number') {
        const fixedHeight = pluginUiLayoutForSlot(current.current.uiSlot).controlHeightPx;
        if (fixedHeight !== undefined) {
          if (frame.current) frame.current.style.height = `${fixedHeight}px`;
          return;
        }
        const limits = current.current.viewType === 'page' ? { min: 220, max: 620 } : { min: 46, max: 180 };
        const height = Math.max(limits.min, Math.min(limits.max, Math.ceil(message.height)));
        if (frame.current) frame.current.style.height = `${height}px`;
        return;
      }
      if (!isPluginUiRequest(event.data)) return;
      const request = event.data;
      void handleRequest(request).then(
        (value) => hostPort.postMessage({ type: 'pico:plugin-ui:response', id: request.id, ok: true, value }),
        (error: unknown) =>
          hostPort.postMessage({
            type: 'pico:plugin-ui:response',
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    };
    hostPort.start();

    const init: PluginUiInitMessage = {
      type: 'pico:plugin-ui:init',
      protocolVersion: PLUGIN_UI_PROTOCOL_VERSION,
      pluginId: props.pluginId,
      entry: props.entry,
      viewType: props.viewType,
      viewId: props.viewId,
      ...layout,
      settings: props.settings,
    };
    frameWindow.postMessage(init, '*', [channel.port2]);
  };

  const handleRequest = async (message: PluginUiRequest): Promise<unknown> => {
    const latest = current.current;
    if (message.action === 'api') {
      if (!isPluginApiPath(message.path, latest.pluginId)) {
        throw new Error('A plugin UI may only call its own plugin API.');
      }
      const init = serializedInit(message.init);
      return await latest.api(message.path, init);
    }
    if (message.action === 'update-model-settings') {
      if (!isPluginModelSettingsUpdate(message.update)) throw new Error('Invalid model settings update.');
      await latest.updateModelSettings(message.update);
      return null;
    }
    if (message.action === 'open-page') {
      if (message.pluginId !== latest.pluginId || !latest.isRegisteredPage(message.pluginId, message.pageId)) {
        throw new Error('A plugin UI may only open its own registered pages.');
      }
      latest.openPage(message.pluginId, message.pageId);
      return null;
    }
    if (message.message.length > 2000) throw new Error('Plugin UI messages are too long.');
    if (message.action === 'error') latest.onError(message.message);
    else if (message.action === 'notice') latest.onNotice(message.message);
    return null;
  };

  return (
    <iframe
      ref={frame}
      className={`plugin-web-view plugin-web-view-${props.viewType}`}
      style={layout.controlHeightPx === undefined ? undefined : { height: `${layout.controlHeightPx}px` }}
      title={`${props.pluginId} ${props.viewType} ${props.viewId}`}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={connectFrame}
    />
  );
}
