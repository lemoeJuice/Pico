import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PublicSettings } from '../core/types.js';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiPopoverMessage,
  isPluginUiRequest,
  pluginUiLayoutForSlot,
  pluginUiEventMatchesPlugin,
  samePluginUiContext,
  PLUGIN_UI_PROTOCOL_VERSION,
  pluginUiUrl,
  type PluginApiInit,
  type PluginModelSettingsUpdate,
  type PluginUiInitMessage,
  type PluginUiContext,
  type PluginUiEvent,
  type PluginUiRequest,
  type PluginUiSlot,
} from '../plugins/ui-protocol.js';

type PluginWebViewProps = {
  pluginId: string;
  entry: string;
  viewType: PluginUiInitMessage['viewType'];
  viewId: string;
  uiSlot?: PluginUiSlot;
  controlWidthPx?: number | undefined;
  controlHeightPx?: number | undefined;
  supportsPopover?: boolean | undefined;
  context: PluginUiContext;
  events?: Array<{ sequence: number; event: PluginUiEvent }>;
  settings: PublicSettings;
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  updateModelSettings(update: PluginModelSettingsUpdate): Promise<void>;
  runCommand(pluginId: string, threadId: string | null, command: string): Promise<unknown>;
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
  const toolbarAnchor = useRef<HTMLSpanElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const connected = useRef(false);
  const deliveredEventSequence = useRef(props.events?.at(-1)?.sequence ?? 0);
  const deliveredContext = useRef(props.context);
  const current = useRef(props);
  current.current = props;
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number } | null>(null);
  const [popover, setPopover] = useState<{ width: number; height: number } | null>(null);

  const src = pluginUiUrl(props.pluginId, props.entry, props.viewType, props.viewId);
  const layout = pluginUiLayoutForSlot(props.uiSlot);
  const toolbarPopover =
    props.viewType === 'component' &&
    props.uiSlot === 'thread.toolbar' &&
    props.supportsPopover === true &&
    props.controlWidthPx !== undefined &&
    props.controlHeightPx !== undefined;

  useLayoutEffect(() => {
    if (!toolbarPopover) return;
    const updateAnchor = (): void => {
      const rect = toolbarAnchor.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchorPosition((previous) =>
        previous?.left === rect.left && previous.top === rect.top ? previous : { left: rect.left, top: rect.top },
      );
    };
    updateAnchor();
    const observer = new ResizeObserver(updateAnchor);
    if (toolbarAnchor.current) observer.observe(toolbarAnchor.current);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
    };
  }, [toolbarPopover, props.controlWidthPx, props.controlHeightPx]);

  useEffect(() => {
    if (!toolbarPopover || !popover) return;
    const dismiss = (): void => {
      setPopover(null);
      portRef.current?.postMessage({ type: 'pico:plugin-ui:popover-dismiss' });
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target === frame.current || toolbarAnchor.current?.contains(event.target as Node)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [toolbarPopover, popover]);

  useEffect(() => {
    portRef.current?.postMessage({ type: 'pico:plugin-ui:settings', settings: props.settings });
  }, [props.settings]);

  useEffect(() => {
    if (samePluginUiContext(deliveredContext.current, props.context)) return;
    deliveredContext.current = props.context;
    portRef.current?.postMessage({ type: 'pico:plugin-ui:context', context: props.context });
  }, [props.context]);

  useEffect(() => {
    const port = portRef.current;
    if (!port) return;
    for (const queued of props.events ?? []) {
      if (queued.sequence <= deliveredEventSequence.current) continue;
      deliveredEventSequence.current = queued.sequence;
      if (pluginUiEventMatchesPlugin(queued.event, props.pluginId)) {
        port.postMessage({ type: 'pico:plugin-ui:event', event: queued.event });
      }
    }
  }, [props.events, props.pluginId]);

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
      const popoverMessage = event.data;
      const message = event.data as { type?: unknown; height?: unknown } | null;
      if (isPluginUiPopoverMessage(popoverMessage)) {
        if (!toolbarPopover) return;
        setPopover(
          popoverMessage.open
            ? {
                width: Math.max(280, Math.min(420, popoverMessage.width)),
                height: Math.max(160, Math.min(520, popoverMessage.height)),
              }
            : null,
        );
        return;
      }
      if (message?.type === 'pico:plugin-ui:resize' && typeof message.height === 'number') {
        if (toolbarPopover) return;
        const fixedHeight = pluginUiLayoutForSlot(current.current.uiSlot).controlHeightPx;
        if (fixedHeight !== undefined) {
          if (frame.current) frame.current.style.height = `${fixedHeight}px`;
          return;
        }
        const limits =
          current.current.uiSlot === 'tool.renderer'
            ? { min: 72, max: 620 }
            : current.current.viewType === 'page'
              ? { min: 220, max: 620 }
              : { min: 46, max: 180 };
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
      context: props.context,
    };
    frameWindow.postMessage(init, '*', [channel.port2]);
    for (const queued of current.current.events ?? []) {
      if (queued.sequence <= deliveredEventSequence.current) continue;
      deliveredEventSequence.current = queued.sequence;
      if (pluginUiEventMatchesPlugin(queued.event, current.current.pluginId)) {
        hostPort.postMessage({ type: 'pico:plugin-ui:event', event: queued.event });
      }
    }
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
    if (message.action === 'command') {
      if (message.command.length > 200) throw new Error('Plugin UI commands are too long.');
      return await latest.runCommand(latest.pluginId, latest.context.thread?.id ?? null, message.command);
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

  const iframe = (
    <iframe
      ref={frame}
      className={`plugin-web-view plugin-web-view-${props.viewType}`}
      style={
        toolbarPopover
          ? (() => {
              const anchor = anchorPosition ?? { left: -1000, top: -1000 };
              const width = popover
                ? Math.min(popover.width, Math.max(120, window.innerWidth - 24))
                : props.controlWidthPx!;
              const height = popover
                ? Math.min(
                    popover.height + props.controlHeightPx! + 8,
                    Math.max(80, window.innerHeight - anchor.top - 8),
                  )
                : props.controlHeightPx!;
              const left = popover ? Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)) : anchor.left;
              const top = anchor.top;
              return {
                position: 'fixed' as const,
                left,
                top,
                width,
                height,
                zIndex: popover ? 30 : 7,
              };
            })()
          : layout.controlHeightPx === undefined
            ? undefined
            : { height: `${layout.controlHeightPx}px` }
      }
      title={`${props.pluginId} ${props.viewType} ${props.viewId}`}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={connectFrame}
    />
  );

  if (!toolbarPopover) return iframe;
  return (
    <>
      <span
        ref={toolbarAnchor}
        className="plugin-web-view-toolbar-anchor"
        style={{
          display: 'block',
          flex: '0 0 auto',
          width: `${props.controlWidthPx}px`,
          height: `${props.controlHeightPx}px`,
          alignSelf: 'center',
        }}
        aria-hidden="true"
      />
      {createPortal(iframe, document.body, `${props.pluginId}:${props.viewId}`)}
    </>
  );
}
