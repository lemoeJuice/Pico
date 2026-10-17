import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PublicSettings } from '../core/types.js';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiPopoverMessage,
  isPluginUiRequest,
  isPluginUiToolbarStateMessage,
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
  controlLabel?: string | undefined;
  controlClassName?: string | undefined;
  supportsPopover?: boolean | undefined;
  context: PluginUiContext;
  events?: Array<{ sequence: number; event: PluginUiEvent }>;
  settings: PublicSettings;
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  updateModelSettings(update: PluginModelSettingsUpdate): Promise<void>;
  openThread(threadId: string): Promise<void>;
  openMessage(seq: number): Promise<void>;
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
  const toolbarAnchor = useRef<HTMLButtonElement>(null);
  const popoverSurface = useRef<HTMLDivElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const connected = useRef(false);
  const popoverOpenRef = useRef(false);
  const toolbarContentHeight = useRef(240);
  const deliveredEventSequence = useRef(props.events?.at(-1)?.sequence ?? 0);
  const deliveredContext = useRef(props.context);
  const current = useRef(props);
  current.current = props;
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number; height: number } | null>(null);
  const [popover, setPopover] = useState<{ width: number; height: number } | null>(null);
  const [badgeCount, setBadgeCount] = useState<number | null>(null);

  const src = pluginUiUrl(props.pluginId, props.entry, props.viewType, props.viewId);
  const layout = pluginUiLayoutForSlot(props.uiSlot);
  const toolbarPopover =
    props.viewType === 'component' &&
    props.uiSlot === 'thread.toolbar' &&
    props.supportsPopover === true &&
    props.controlLabel !== undefined &&
    props.controlClassName !== undefined;

  const setToolbarPopover = (next: { width: number; height: number } | null): void => {
    popoverOpenRef.current = next !== null;
    setPopover(next);
  };

  const availablePopoverHeight = (anchorTop?: number, anchorHeight?: number): number => {
    const rect = toolbarAnchor.current?.getBoundingClientRect();
    const top = anchorTop ?? rect?.top;
    const height = anchorHeight ?? rect?.height;
    if (top === undefined || height === undefined) return Math.max(120, window.innerHeight - 32);
    return Math.max(120, window.innerHeight - top - height - 20);
  };

  const updateAnchor = (): void => {
    const rect = toolbarAnchor.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchorPosition((previous) =>
      previous?.left === rect.left && previous.top === rect.top && previous.height === rect.height
        ? previous
        : { left: rect.left, top: rect.top, height: rect.height },
    );
    if (popoverOpenRef.current) {
      portRef.current?.postMessage({
        type: 'pico:plugin-ui:popover-viewport',
        maxHeight: availablePopoverHeight(rect.top, rect.height),
      });
    }
  };

  useLayoutEffect(() => {
    if (!toolbarPopover) return;
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
  }, [toolbarPopover]);

  useEffect(() => {
    if (!toolbarPopover || !popover) return;
    const dismiss = (): void => {
      setToolbarPopover(null);
      portRef.current?.postMessage({ type: 'pico:plugin-ui:popover-dismiss' });
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (
        popoverSurface.current?.contains(event.target as Node) ||
        toolbarAnchor.current?.contains(event.target as Node)
      )
        return;
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
        const height = Math.max(80, Math.min(Math.ceil(popoverMessage.height) + 4, availablePopoverHeight()));
        if (popoverMessage.open) toolbarContentHeight.current = height;
        setToolbarPopover(popoverMessage.open ? { width: 360, height } : null);
        return;
      }
      if (isPluginUiToolbarStateMessage(popoverMessage)) {
        setBadgeCount(popoverMessage.badgeCount);
        return;
      }
      if (message?.type === 'pico:plugin-ui:resize' && typeof message.height === 'number') {
        if (toolbarPopover) {
          const height = Math.max(80, Math.min(Math.ceil(message.height) + 4, availablePopoverHeight()));
          toolbarContentHeight.current = height;
          setPopover((previous) => (previous ? { width: 360, height } : previous));
          return;
        }
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
    if (toolbarPopover) {
      hostPort.postMessage({
        type: 'pico:plugin-ui:toolbar-toggle',
        open: popoverOpenRef.current,
        maxHeight: availablePopoverHeight(),
      });
    }
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
    if (message.action === 'open-message') {
      if (!Number.isSafeInteger(message.seq) || message.seq < 0 || !latest.context.thread) {
        throw new Error('A canonical message in the active Thread must be selected.');
      }
      await latest.openMessage(message.seq);
      return null;
    }
    if (message.action === 'open-thread') {
      const currentThread = latest.context.thread;
      if (!currentThread || message.threadId.length > 200) {
        throw new Error('A Thread in the active Project must be selected.');
      }
      await latest.openThread(message.threadId);
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
          ? { display: popover ? 'block' : 'none', width: '100%', height: '100%' }
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
      <button
        ref={toolbarAnchor}
        type="button"
        className={props.controlClassName}
        title={props.controlLabel}
        aria-haspopup="dialog"
        aria-expanded={popover !== null}
        onClick={() => {
          const nextOpen = !popoverOpenRef.current;
          const rect = toolbarAnchor.current?.getBoundingClientRect();
          if (rect) setAnchorPosition({ left: rect.left, top: rect.top, height: rect.height });
          if (nextOpen) {
            const maxHeight = availablePopoverHeight(rect?.top, rect?.height);
            setToolbarPopover({
              width: 360,
              height: Math.max(80, Math.min(toolbarContentHeight.current, maxHeight)),
            });
          } else {
            setToolbarPopover(null);
          }
          portRef.current?.postMessage({
            type: 'pico:plugin-ui:toolbar-toggle',
            open: nextOpen,
            maxHeight: availablePopoverHeight(rect?.top, rect?.height),
          });
        }}
      >
        {props.controlLabel}
        {badgeCount !== null ? <span className="plugin-toolbar-badge">{badgeCount}</span> : null}
      </button>
      {createPortal(
        <div
          ref={popoverSurface}
          className="plugin-toolbar-popover"
          role="dialog"
          aria-label={`${props.controlLabel} panel`}
          style={(() => {
            const anchor = anchorPosition ?? { left: -1000, top: -1000, height: 0 };
            const width = Math.min(popover?.width ?? 360, Math.max(120, window.innerWidth - 24));
            const height = popover ? Math.min(popover.height, availablePopoverHeight()) : 0;
            return {
              left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
              top: anchor.top + anchor.height + 9,
              width,
              height,
              display: popover ? 'flex' : 'none',
            };
          })()}
        >
          {iframe}
        </div>,
        document.body,
        `${props.pluginId}:${props.viewId}`,
      )}
    </>
  );
}
