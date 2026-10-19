import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PublicSettings } from '../core/types.js';
import {
  markPluginUiDiagnosticMounted,
  reportPluginUiDiagnostic,
  type PluginUiDiagnostic,
  type PluginUiDiagnosticIdentity,
  type PluginUiDiagnosticStage,
} from './plugin-ui-diagnostics.js';
import {
  isPluginApiPath,
  isPluginModelSettingsUpdate,
  isPluginUiPopoverMessage,
  isPluginUiRequest,
  isPluginUiToolbarStateMessage,
  isPluginUiVisibilityMessage,
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
  const connectionReady = useRef(false);
  const communicationStarted = useRef(false);
  const initializationAcknowledged = useRef(false);
  const runtimeError = useRef<string | null>(null);
  const attemptSequence = useRef(0);
  const activeAttemptId = useRef<string | null>(null);
  const probeTimeout = useRef<number | null>(null);
  const readyTimeout = useRef<number | null>(null);
  const probeListener = useRef<((event: MessageEvent) => void) | null>(null);
  const popoverOpenRef = useRef(false);
  const toolbarContentHeight = useRef(240);
  const deliveredEventSequence = useRef(props.events?.at(-1)?.sequence ?? 0);
  const deliveredContext = useRef(props.context);
  const current = useRef(props);
  current.current = props;
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number; height: number } | null>(null);
  const [popover, setPopover] = useState<{ width: number; height: number } | null>(null);
  const [badgeCount, setBadgeCount] = useState<number | null>(null);
  const [inlineVisible, setInlineVisible] = useState(true);
  const [inlineWidth, setInlineWidth] = useState<number | null>(null);

  const src = pluginUiUrl(props.pluginId, props.entry, props.viewType, props.viewId);
  const reportDiagnostic = useCallback(
    (
      stage: PluginUiDiagnosticStage,
      detail?: string,
      extra: Partial<
        Pick<
          PluginUiDiagnostic,
          | 'bridgeResponded'
          | 'initSent'
          | 'initAcknowledged'
          | 'readyReceived'
          | 'mounted'
          | 'lastResizePx'
          | 'visible'
          | 'widthPx'
          | 'frameSecureContext'
          | 'frameRandomUUID'
          | 'frameResizeObserver'
          | 'frameMessageChannel'
        >
      > = {},
    ): void => {
      const latest = current.current;
      const identity: PluginUiDiagnosticIdentity = {
        pluginId: latest.pluginId,
        entry: latest.entry,
        viewType: latest.viewType,
        viewId: latest.viewId,
        ...(latest.uiSlot === undefined ? {} : { uiSlot: latest.uiSlot }),
      };
      reportPluginUiDiagnostic(identity, { stage, ...extra, ...(detail === undefined ? {} : { detail }) });
    },
    [],
  );
  const clearProbeTimeout = (): void => {
    if (probeTimeout.current === null) return;
    window.clearTimeout(probeTimeout.current);
    probeTimeout.current = null;
  };
  const clearReadyTimeout = (): void => {
    if (readyTimeout.current === null) return;
    window.clearTimeout(readyTimeout.current);
    readyTimeout.current = null;
  };
  const removeProbeListener = (): void => {
    if (!probeListener.current) return;
    window.removeEventListener('message', probeListener.current);
    probeListener.current = null;
  };
  useLayoutEffect(() => {
    const diagnosticIdentity: PluginUiDiagnosticIdentity = {
      pluginId: props.pluginId,
      entry: props.entry,
      viewType: props.viewType,
      viewId: props.viewId,
      ...(props.uiSlot === undefined ? {} : { uiSlot: props.uiSlot }),
    };
    setInlineVisible(true);
    setInlineWidth(null);
    connectionReady.current = false;
    communicationStarted.current = false;
    initializationAcknowledged.current = false;
    runtimeError.current = null;
    connected.current = false;
    activeAttemptId.current = null;
    reportDiagnostic('loading', 'Waiting for iframe load.', {
      bridgeResponded: false,
      initSent: false,
      initAcknowledged: false,
      readyReceived: false,
      lastResizePx: null,
      visible: null,
      widthPx: null,
      frameSecureContext: null,
      frameRandomUUID: null,
      frameResizeObserver: null,
      frameMessageChannel: null,
    });
    markPluginUiDiagnosticMounted(diagnosticIdentity, true);
    clearProbeTimeout();
    clearReadyTimeout();
    removeProbeListener();
    portRef.current?.close();
    portRef.current = null;
    return () => {
      markPluginUiDiagnosticMounted(diagnosticIdentity, false);
      clearProbeTimeout();
      clearReadyTimeout();
      removeProbeListener();
      portRef.current?.close();
      portRef.current = null;
      connectionReady.current = false;
      communicationStarted.current = false;
      connected.current = false;
      activeAttemptId.current = null;
    };
  }, [reportDiagnostic, src]);

  useLayoutEffect(() => {
    const onRuntimeError = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as { type?: unknown; kind?: unknown } | null;
      if (message?.type !== 'pico:plugin-ui:runtime-error' || typeof message.kind !== 'string') return;
      const detail =
        message.kind === 'script-error'
          ? 'A plugin JavaScript error occurred.'
          : message.kind === 'resource-error'
            ? 'A plugin UI resource failed to load.'
            : message.kind === 'unhandled-rejection'
              ? 'An unhandled promise rejection occurred in the plugin UI.'
              : message.kind === 'csp-violation'
                ? 'Content Security Policy blocked a plugin UI resource.'
                : undefined;
      if (detail) reportDiagnostic('error', detail);
      if (detail) {
        runtimeError.current = detail;
        clearReadyTimeout();
      }
    };
    window.addEventListener('message', onRuntimeError);
    return () => {
      window.removeEventListener('message', onRuntimeError);
    };
  }, [reportDiagnostic]);
  const layout = pluginUiLayoutForSlot(props.uiSlot);
  const hostPopover =
    props.viewType === 'component' &&
    (props.uiSlot === 'thread.toolbar' || props.uiSlot === 'composer.model') &&
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
    const spaceAbove = top - 12;
    const spaceBelow = window.innerHeight - top - height - 12;
    return Math.max(80, Math.max(spaceAbove, spaceBelow));
  };

  const toolbarPopoverWidth = (): number => {
    if (props.pluginId !== 'pico.rolling-context') return 360;
    return Math.min(640, Math.max(120, window.innerWidth - 24));
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
      setPopover((previous) =>
        previous
          ? {
              width: toolbarPopoverWidth(),
              height: Math.min(previous.height, availablePopoverHeight(rect.top, rect.height)),
            }
          : previous,
      );
      portRef.current?.postMessage({
        type: 'pico:plugin-ui:popover-viewport',
        maxHeight: availablePopoverHeight(rect.top, rect.height),
      });
    }
  };

  useLayoutEffect(() => {
    if (!hostPopover) return;
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
  }, [hostPopover]);

  useEffect(() => {
    if (!hostPopover || !popover) return;
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
  }, [hostPopover, popover]);

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

  const connectFrame = (): void => {
    reportDiagnostic(
      runtimeError.current ? 'error' : 'document-loaded',
      runtimeError.current ?? 'Iframe onLoad fired; this confirms navigation, not that the plugin UI rendered.',
    );
    if (connected.current) return;
    const frameWindow = frame.current?.contentWindow;
    if (!frameWindow) return;
    connected.current = true;
    connectionReady.current = false;
    communicationStarted.current = false;
    initializationAcknowledged.current = false;
    const attemptId = `pico-ui-${Date.now().toString(36)}-${++attemptSequence.current}`;
    activeAttemptId.current = attemptId;

    const markReady = (): void => {
      if (activeAttemptId.current !== attemptId) return;
      connectionReady.current = true;
      clearReadyTimeout();
      reportDiagnostic('ready', 'Plugin UI sent a ready response.', { readyReceived: true });
    };
    const markCommunicating = (): void => {
      if (activeAttemptId.current !== attemptId || connectionReady.current || communicationStarted.current) return;
      communicationStarted.current = true;
      clearReadyTimeout();
      reportDiagnostic('communicating', 'The plugin UI sent a message, but did not send an explicit ready response.');
    };

    const sendInit = (hasDiagnosticBridge: boolean): void => {
      if (activeAttemptId.current !== attemptId) return;
      removeProbeListener();
      clearProbeTimeout();
      reportDiagnostic(
        runtimeError.current ? 'error' : 'initializing',
        runtimeError.current ??
          (hasDiagnosticBridge
            ? 'Diagnostic bridge responded; waiting for the plugin UI ready response.'
            : 'No diagnostic bridge response; sent the compatibility initialization message.'),
        { bridgeResponded: hasDiagnosticBridge, initSent: false, initAcknowledged: false },
      );
      portRef.current?.close();
      let channel: MessageChannel;
      try {
        channel = new MessageChannel();
      } catch {
        reportDiagnostic('error', 'The host could not create a MessageChannel for this plugin UI.');
        return;
      }
      const hostPort = channel.port1;
      portRef.current = hostPort;

      hostPort.onmessage = (event: MessageEvent<unknown>): void => {
        if (portRef.current !== hostPort) return;
        const popoverMessage = event.data;
        const message = event.data as { type?: unknown; height?: unknown; attemptId?: unknown } | null;
        if (message?.type === 'pico:plugin-ui:ready') {
          if (message.attemptId === attemptId) markReady();
          return;
        }
        if (message?.type === 'pico:plugin-ui:bridge-init-ack') {
          if (message.attemptId !== attemptId) return;
          initializationAcknowledged.current = true;
          reportDiagnostic(
            runtimeError.current
              ? 'error'
              : connectionReady.current
                ? 'ready'
                : communicationStarted.current
                  ? 'communicating'
                  : 'init-acknowledged',
            runtimeError.current ??
              'The bridge received the initialization message and confirmed the transferred port; waiting for the plugin UI ready response.',
            { initAcknowledged: true },
          );
          return;
        }
        markCommunicating();
        if (isPluginUiPopoverMessage(popoverMessage)) {
          if (!hostPopover) return;
          const height = Math.max(80, Math.min(Math.ceil(popoverMessage.height) + 4, availablePopoverHeight()));
          if (popoverMessage.open) toolbarContentHeight.current = height;
          setToolbarPopover(popoverMessage.open ? { width: toolbarPopoverWidth(), height } : null);
          return;
        }
        if (isPluginUiToolbarStateMessage(popoverMessage)) {
          setBadgeCount(popoverMessage.badgeCount);
          return;
        }
        if (isPluginUiVisibilityMessage(popoverMessage)) {
          reportPluginUiDiagnostic(
            {
              pluginId: current.current.pluginId,
              entry: current.current.entry,
              viewType: current.current.viewType,
              viewId: current.current.viewId,
              ...(current.current.uiSlot === undefined ? {} : { uiSlot: current.current.uiSlot }),
            },
            {
              stage: connectionReady.current
                ? 'ready'
                : communicationStarted.current
                  ? 'communicating'
                  : 'initializing',
              visible: popoverMessage.visible,
              ...(popoverMessage.width === undefined ? {} : { widthPx: Math.ceil(popoverMessage.width) }),
            },
          );
          if (current.current.viewType === 'component' && current.current.uiSlot === 'composer.model' && !hostPopover) {
            setInlineVisible(popoverMessage.visible);
            setInlineWidth(popoverMessage.width === undefined ? null : Math.ceil(popoverMessage.width));
          }
          return;
        }
        if (message?.type === 'pico:plugin-ui:resize' && typeof message.height === 'number') {
          reportPluginUiDiagnostic(
            {
              pluginId: current.current.pluginId,
              entry: current.current.entry,
              viewType: current.current.viewType,
              viewId: current.current.viewId,
              ...(current.current.uiSlot === undefined ? {} : { uiSlot: current.current.uiSlot }),
            },
            {
              stage: connectionReady.current
                ? 'ready'
                : communicationStarted.current
                  ? 'communicating'
                  : 'initializing',
              lastResizePx: Math.ceil(message.height),
            },
          );
          if (hostPopover) {
            const height = Math.max(80, Math.min(Math.ceil(message.height) + 4, availablePopoverHeight()));
            toolbarContentHeight.current = height;
            setPopover((previous) => (previous ? { width: toolbarPopoverWidth(), height } : previous));
            return;
          }
          const isPopover = current.current.supportsPopover === true;
          const fixedHeight = pluginUiLayoutForSlot(current.current.uiSlot, isPopover).controlHeightPx;
          if (fixedHeight !== undefined) {
            if (frame.current) frame.current.style.height = `${fixedHeight}px`;
            return;
          }
          const limits =
            current.current.uiSlot === 'tool.result'
              ? { min: 0, max: 180 }
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
          (value) => {
            if (portRef.current === hostPort)
              hostPort.postMessage({ type: 'pico:plugin-ui:response', id: request.id, ok: true, value });
          },
          (error: unknown) => {
            if (portRef.current === hostPort)
              hostPort.postMessage({
                type: 'pico:plugin-ui:response',
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
          },
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
        attemptId,
        ...pluginUiLayoutForSlot(props.uiSlot, hostPopover),
        settings: props.settings,
        context: props.context,
      };
      try {
        frameWindow.postMessage(init, '*', [channel.port2]);
      } catch {
        reportDiagnostic('error', 'The host could not send the initialization message to this frame.');
        return;
      }
      reportDiagnostic(
        runtimeError.current ? 'error' : 'initializing',
        runtimeError.current ??
          (hasDiagnosticBridge
            ? 'Diagnostic bridge responded; waiting for the plugin UI ready response.'
            : 'No diagnostic bridge response; sent the compatibility initialization message.'),
        { bridgeResponded: hasDiagnosticBridge, initSent: true, initAcknowledged: false },
      );
      readyTimeout.current = window.setTimeout(() => {
        readyTimeout.current = null;
        if (communicationStarted.current || connectionReady.current || activeAttemptId.current !== attemptId) return;
        if (runtimeError.current) {
          reportDiagnostic('error', runtimeError.current);
          return;
        }
        reportDiagnostic(
          initializationAcknowledged.current ? 'ready-timeout' : 'init-timeout',
          initializationAcknowledged.current
            ? 'The bridge received initialization, but the plugin UI sent no ready or other message within 5 seconds.'
            : hasDiagnosticBridge
              ? 'The diagnostic bridge answered the probe, but did not acknowledge initialization or the transferred port within 5 seconds.'
              : 'No diagnostic bridge answered the probe, and no message arrived over the transferred port within 5 seconds; init receipt could not be confirmed.',
        );
      }, 5000);
      if (hostPopover) {
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

    const onProbeAck = (event: MessageEvent<unknown>): void => {
      const response = event.data as { type?: unknown; probeId?: unknown; capabilities?: unknown } | null;
      if (
        event.source !== frameWindow ||
        response?.type !== 'pico:plugin-ui:probe-ack' ||
        response.probeId !== attemptId
      ) {
        return;
      }
      clearProbeTimeout();
      removeProbeListener();
      const capabilities =
        response.capabilities && typeof response.capabilities === 'object'
          ? (response.capabilities as Record<string, unknown>)
          : {};
      const readCapability = (name: string): boolean | null =>
        typeof capabilities[name] === 'boolean' ? (capabilities[name] as boolean) : null;
      reportDiagnostic(
        runtimeError.current ? 'error' : 'bridge-ready',
        runtimeError.current ?? 'The iframe diagnostic bridge responded to the host probe.',
        {
        bridgeResponded: true,
        frameSecureContext: readCapability('secureContext'),
        frameRandomUUID: readCapability('randomUUID'),
        frameResizeObserver: readCapability('resizeObserver'),
        frameMessageChannel: readCapability('messageChannel'),
        },
      );
      sendInit(true);
    };
    probeListener.current = onProbeAck;
    window.addEventListener('message', onProbeAck);
    probeTimeout.current = window.setTimeout(() => sendInit(false), 250);
    try {
      frameWindow.postMessage(
        { type: 'pico:plugin-ui:probe', protocolVersion: PLUGIN_UI_PROTOCOL_VERSION, probeId: attemptId },
        '*',
      );
    } catch {
      sendInit(false);
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
        hostPopover
          ? { display: popover ? 'block' : 'none', width: '100%', height: '100%' }
          : layout.controlHeightPx === undefined
            ? undefined
            : {
                height: `${layout.controlHeightPx}px`,
                ...(inlineWidth === null ? {} : { width: `${inlineWidth}px`, minWidth: 0, flex: '0 1 auto' }),
                ...(inlineVisible ? {} : { display: 'none' }),
              }
      }
      title={`${props.pluginId} ${props.viewType} ${props.viewId}`}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={connectFrame}
      onError={() => reportDiagnostic('error', 'The browser reported that the iframe failed to load.')}
    />
  );

  if (!hostPopover) return iframe;
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
              width: toolbarPopoverWidth(),
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
            const width = Math.min(popover?.width ?? toolbarPopoverWidth(), Math.max(120, window.innerWidth - 24));
            const height = popover ? Math.min(popover.height, Math.max(80, window.innerHeight - 24)) : 0;
            const belowTop = anchor.top + anchor.height + 9;
            const belowSpace = window.innerHeight - belowTop - 12;
            const top = belowSpace >= height ? belowTop : Math.max(12, anchor.top - height - 9);
            return {
              left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
              top,
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
