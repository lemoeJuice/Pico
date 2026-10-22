import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PublicSettings } from '../core/types.js';
import { PluginUiTreeView } from './plugin-ui-tree.js';
import { clampPluginPopoverWidth } from './plugin-ui-sizing.js';
import {
  validatePluginAuthPopupCallback,
  validatePluginAuthPopupNavigation,
  type PluginAuthPopupLease,
} from './plugin-auth-popup.js';
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
  type PluginUiNode,
  validatePluginUiTree,
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
  externalAuthOrigins?: string[] | undefined;
  context: PluginUiContext;
  events?: Array<{ sequence: number; event: PluginUiEvent }>;
  settings: PublicSettings;
  api<T>(path: string, init?: PluginApiInit): Promise<T>;
  updateModelSettings(update: PluginModelSettingsUpdate, threadId?: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  openMessage(seq: number): Promise<void>;
  runCommand(pluginId: string, threadId: string | null, command: string): Promise<unknown>;
  openPage(pluginId: string, pageId: string): void;
  isRegisteredPage(pluginId: string, pageId: string): boolean;
  onError(message: string): void;
  onNotice(message: string): void;
};

const pluginApiMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PLUGIN_UI_FRAME_LOAD_TIMEOUT_MS = 15_000;

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

function containsExternalAuthButton(node: PluginUiNode): boolean {
  if (node.type === 'button') return node.externalAuth === true;
  if ('children' in node) return node.children.some(containsExternalAuthButton);
  if (node.type === 'list') return node.items.some(containsExternalAuthButton);
  return false;
}

export function PluginWebView(props: PluginWebViewProps): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const toolbarAnchor = useRef<HTMLButtonElement>(null);
  const popoverSurface = useRef<HTMLDivElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const authPopupLeases = useRef(
    new Map<string, PluginAuthPopupLease & { popup: Window; expiryTimer: number; portCloseListener: () => void }>(),
  );
  const connected = useRef(false);
  const connectionReady = useRef(false);
  const communicationStarted = useRef(false);
  const initializationAcknowledged = useRef(false);
  const runtimeError = useRef<string | null>(null);
  const attemptSequence = useRef(0);
  const activeAttemptId = useRef<string | null>(null);
  const probeTimeout = useRef<number | null>(null);
  const iframeLoadTimeout = useRef<number | null>(null);
  const readyTimeout = useRef<number | null>(null);
  const renderTimeout = useRef<number | null>(null);
  const hasRenderedUi = useRef(false);
  const probeListener = useRef<((event: MessageEvent) => void) | null>(null);
  const popoverOpenRef = useRef(false);
  const deliveredEventSequence = useRef(props.events?.at(-1)?.sequence ?? 0);
  const deliveredContext = useRef(props.context);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const onPopupMessage = (event: MessageEvent<unknown>): void => {
      for (const [leaseId, lease] of authPopupLeases.current) {
        if (lease.expiresAt <= Date.now() || lease.port !== portRef.current) {
          lease.popup.close();
          window.clearTimeout(lease.expiryTimer);
          (lease.port as MessagePort).removeEventListener('close', lease.portCloseListener);
          authPopupLeases.current.delete(leaseId);
          continue;
        }
        const data = event.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 12) return;
        const callbackOperationId = (data as Record<string, unknown>).operationId;
        if (
          !validatePluginAuthPopupCallback(
            lease,
            event.source as object | null,
            event.origin,
            typeof callbackOperationId === 'string' ? callbackOperationId : undefined,
            portRef.current ?? {},
          ) ||
          lease.pluginId !== current.current.pluginId ||
          lease.entry !== current.current.entry ||
          lease.viewId !== current.current.viewId ||
          lease.actionId.length === 0
        )
          continue;
        const safe: Record<string, string | boolean> = {};
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (
            !/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key) ||
            (typeof value !== 'string' && typeof value !== 'boolean') ||
            (typeof value === 'string' && value.length > 2000)
          )
            return;
          safe[key] = value;
        }
        lease.callbackConsumed = true;
        authPopupLeases.current.delete(leaseId);
        window.clearTimeout(lease.expiryTimer);
        (lease.port as MessagePort).removeEventListener('close', lease.portCloseListener);
        (lease.port as MessagePort).postMessage({
          type: 'pico:plugin-ui:event',
          event: { type: 'external-auth-popup-result', leaseId, actionId: lease.actionId, data: safe },
        });
        return;
      }
    };
    window.addEventListener('message', onPopupMessage);
    return () => window.removeEventListener('message', onPopupMessage);
  }, []);
  const [anchorPosition, setAnchorPosition] = useState<{ left: number; top: number; height: number } | null>(null);
  const [popover, setPopover] = useState<{ width: number; height: number } | null>(null);
  const [badgeCount, setBadgeCount] = useState<number | null>(null);
  const [uiTree, setUiTree] = useState<PluginUiNode[] | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  const src = pluginUiUrl(props.pluginId, props.entry, props.viewType, props.viewId, props.uiSlot);
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
  const clearIframeLoadTimeout = (): void => {
    if (iframeLoadTimeout.current === null) return;
    window.clearTimeout(iframeLoadTimeout.current);
    iframeLoadTimeout.current = null;
  };
  const clearReadyTimeout = (): void => {
    if (readyTimeout.current === null) return;
    window.clearTimeout(readyTimeout.current);
    readyTimeout.current = null;
  };
  const clearRenderTimeout = (): void => {
    if (renderTimeout.current === null) return;
    window.clearTimeout(renderTimeout.current);
    renderTimeout.current = null;
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
    setUiTree(null);
    setUiError(null);
    hasRenderedUi.current = false;
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
      frameSecureContext: null,
      frameRandomUUID: null,
      frameResizeObserver: null,
      frameMessageChannel: null,
    });
    markPluginUiDiagnosticMounted(diagnosticIdentity, true);
    clearProbeTimeout();
    clearIframeLoadTimeout();
    clearReadyTimeout();
    clearRenderTimeout();
    removeProbeListener();
    portRef.current?.close();
    portRef.current = null;
    iframeLoadTimeout.current = window.setTimeout(() => {
      iframeLoadTimeout.current = null;
      if (connected.current || activeAttemptId.current !== null) return;
      setUiError('The plugin interface did not finish loading. Check Plugin UI diagnostics for details.');
      reportDiagnostic(
        'load-timeout',
        `The iframe did not fire its load event within ${PLUGIN_UI_FRAME_LOAD_TIMEOUT_MS / 1000} seconds; check the plugin asset response, content security policy, and browser network errors.`,
      );
    }, PLUGIN_UI_FRAME_LOAD_TIMEOUT_MS);
    return () => {
      markPluginUiDiagnosticMounted(diagnosticIdentity, false);
      clearProbeTimeout();
      clearIframeLoadTimeout();
      clearReadyTimeout();
      clearRenderTimeout();
      removeProbeListener();
      portRef.current?.close();
      for (const lease of authPopupLeases.current.values()) {
        window.clearTimeout(lease.expiryTimer);
        (lease.port as MessagePort).removeEventListener('close', lease.portCloseListener);
        lease.popup.close();
      }
      authPopupLeases.current.clear();
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
        clearRenderTimeout();
        if (!hasRenderedUi.current) {
          setUiError('The plugin interface failed to start. Check Plugin UI diagnostics for details.');
        }
      }
    };
    window.addEventListener('message', onRuntimeError);
    return () => {
      window.removeEventListener('message', onRuntimeError);
    };
  }, [reportDiagnostic]);
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
    if (top === undefined || height === undefined) return Math.max(0, window.innerHeight - 24);
    const spaceAbove = top - 12;
    const spaceBelow = window.innerHeight - top - height - 12;
    return Math.max(0, Math.min(window.innerHeight - 24, Math.max(spaceAbove, spaceBelow)));
  };

  const toolbarPopoverWidth = (): number => {
    return clampPluginPopoverWidth(window.innerWidth);
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
    clearIframeLoadTimeout();
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
    const scheduleMissingRenderError = (timeoutMs: number, detail: string, stage: 'ready-timeout' | 'error'): void => {
      clearRenderTimeout();
      renderTimeout.current = window.setTimeout(() => {
        renderTimeout.current = null;
        if (hasRenderedUi.current || activeAttemptId.current !== attemptId) return;
        setUiError('The plugin interface did not render. Check Plugin UI diagnostics for details.');
        reportDiagnostic(stage, detail);
      }, timeoutMs);
    };

    const markReady = (): void => {
      if (activeAttemptId.current !== attemptId) return;
      connectionReady.current = true;
      clearReadyTimeout();
      if (!hasRenderedUi.current) {
        scheduleMissingRenderError(
          5000,
          'The plugin UI sent ready without a supported component description.',
          'ready-timeout',
        );
      }
      reportDiagnostic('ready', 'Plugin UI sent a ready response.', { readyReceived: true });
    };
    const markCommunicating = (): void => {
      if (activeAttemptId.current !== attemptId || connectionReady.current || communicationStarted.current) return;
      communicationStarted.current = true;
      clearReadyTimeout();
      if (!hasRenderedUi.current) {
        scheduleMissingRenderError(
          5000,
          'The plugin UI communicated with the host but did not send a component description.',
          'error',
        );
      }
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
        setUiError('The plugin interface could not be initialized. Check Plugin UI diagnostics for details.');
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
        if (message?.type === 'pico:plugin-ui:render') {
          markCommunicating();
          const tree = (event.data as { tree?: unknown }).tree;
          const slot = current.current.uiSlot ?? 'settings.page';
          if (
            !validatePluginUiTree(tree, slot) ||
            ((tree as PluginUiNode[]).some((node) => containsExternalAuthButton(node)) &&
              !current.current.externalAuthOrigins?.length)
          ) {
            clearRenderTimeout();
            setUiTree(null);
            hasRenderedUi.current = false;
            setUiError(
              'This plugin sent an interface that Pico cannot display. Check Plugin UI diagnostics for details.',
            );
            reportDiagnostic('error', 'Plugin UI supplied an unsupported or invalid component description.');
            return;
          }
          setUiTree(tree);
          hasRenderedUi.current = true;
          clearRenderTimeout();
          setUiError(null);
          return;
        }
        markCommunicating();
        if (isPluginUiToolbarStateMessage(popoverMessage)) {
          setBadgeCount(popoverMessage.badgeCount);
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
        ...(props.externalAuthOrigins ? { externalAuthOrigins: props.externalAuthOrigins } : {}),
        settings: props.settings,
        context: props.context,
      };
      try {
        frameWindow.postMessage(init, '*', [channel.port2]);
      } catch {
        setUiError('The plugin interface could not be initialized. Check Plugin UI diagnostics for details.');
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
        const detail = initializationAcknowledged.current
          ? 'The bridge received initialization, but the plugin UI sent no ready or other message within 5 seconds.'
          : hasDiagnosticBridge
            ? 'The diagnostic bridge answered the probe, but did not acknowledge initialization or the transferred port within 5 seconds.'
            : 'No diagnostic bridge answered the probe, and no message arrived over the transferred port within 5 seconds; init receipt could not be confirmed.';
        setUiError('The plugin interface did not respond. Check Plugin UI diagnostics for details.');
        reportDiagnostic(initializationAcknowledged.current ? 'ready-timeout' : 'init-timeout', detail);
      }, 5000);
      if (hostPopover) {
        hostPort.postMessage({
          type: 'pico:plugin-ui:toolbar-toggle',
          open: popoverOpenRef.current,
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
    if (message.action === 'auth-popup-navigate') {
      const lease = authPopupLeases.current.get(message.leaseId);
      const navigation = validatePluginAuthPopupNavigation(
        lease ? { ...lease, popup: lease.popup } : undefined,
        {
          pluginId: latest.pluginId,
          entry: latest.entry,
          viewId: latest.viewId,
          leaseId: message.leaseId,
          authorizationUrl: message.authorizationUrl,
          callbackOrigin: message.callbackOrigin,
          operationId: message.operationId,
        },
        portRef.current ?? {},
        latest.externalAuthOrigins ?? [],
      );
      if (!lease || !navigation) {
        if (lease) {
          lease.popup.close();
          window.clearTimeout(lease.expiryTimer);
          (lease.port as MessagePort).removeEventListener('close', lease.portCloseListener);
          authPopupLeases.current.delete(message.leaseId);
        }
        throw new Error('External auth popup lease is invalid, expired, or already used.');
      }
      lease.callbackOrigin = navigation.callbackOrigin.origin;
      lease.operationId = message.operationId;
      lease.popup.location.replace(navigation.authorizationUrl.href);
      return null;
    }
    if (message.action === 'api') {
      if (!isPluginApiPath(message.path, latest.pluginId)) {
        throw new Error('A plugin UI may only call its own plugin API.');
      }
      const init = serializedInit(message.init);
      return await latest.api(message.path, init);
    }
    if (message.action === 'update-model-settings') {
      if (!isPluginModelSettingsUpdate(message.update)) throw new Error('Invalid model settings update.');
      const contextThreadId = latest.context.thread?.id;
      if (message.threadId !== contextThreadId) {
        throw new Error('The active Thread changed before the model setting could be saved.');
      }
      await latest.updateModelSettings(message.update, message.threadId);
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
      className={`plugin-web-view plugin-web-view-${props.viewType}${props.uiSlot === 'composer.status' ? ' plugin-web-view-composer-status' : ''}`}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        opacity: 0,
        pointerEvents: 'none',
        zIndex: -1,
      }}
      title={`${props.pluginId} ${props.viewType} ${props.viewId}`}
      aria-hidden="true"
      tabIndex={-1}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={connectFrame}
      onError={() => {
        clearIframeLoadTimeout();
        setUiError('The plugin interface could not be loaded. Check that its Web UI entry is available.');
        reportDiagnostic('error', 'The browser reported that the iframe failed to load.');
      }}
    />
  );

  const renderedUi =
    uiTree !== null ? (
      <PluginUiTreeView
        nodes={uiTree}
        compactComposerControls={props.uiSlot === 'composer.model' && !hostPopover}
        onAction={(actionId, value, actionEvent, externalAuth) => {
          const activePort = portRef.current;
          if (!activePort) return;
          let popupLeaseId: string | undefined;
          if (externalAuth) {
            if (!current.current.externalAuthOrigins?.length) return;
            const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720');
            if (!popup) {
              current.current.onError('Allow pop-up windows for this plugin to continue.');
              return;
            }
            popupLeaseId = window.crypto.randomUUID();
            const latest = current.current;
            const expiresAt = Date.now() + 120_000;
            const portCloseListener = (): void => {
              const lease = authPopupLeases.current.get(popupLeaseId!);
              if (lease?.port !== activePort) return;
              window.clearTimeout(lease.expiryTimer);
              lease.popup.close();
              authPopupLeases.current.delete(popupLeaseId!);
            };
            const expiryTimer = window.setTimeout(() => {
              const lease = authPopupLeases.current.get(popupLeaseId!);
              if (lease?.port === activePort) {
                lease.popup.close();
                (lease.port as MessagePort).removeEventListener('close', lease.portCloseListener);
                authPopupLeases.current.delete(popupLeaseId!);
              }
            }, 120_000);
            activePort.addEventListener('close', portCloseListener, { once: true });
            authPopupLeases.current.set(popupLeaseId, {
              pluginId: latest.pluginId,
              entry: latest.entry,
              viewId: latest.viewId,
              actionId,
              port: activePort,
              popup,
              expiresAt,
              expiryTimer,
              portCloseListener,
            });
          }
          activePort.postMessage({
            type: 'pico:plugin-ui:action',
            actionId,
            ...(value === undefined ? {} : { value }),
            ...(actionEvent === undefined ? {} : { event: actionEvent }),
            ...(popupLeaseId ? { popupLeaseId } : {}),
          });
        }}
      />
    ) : (
      <p className={uiError ? 'plugin-ui-unavailable' : 'plugin-ui-loading'} role="status">
        {uiError ?? 'Loading plugin interface…'}
      </p>
    );

  if (!hostPopover)
    return (
      <>
        {iframe}
        <div
          className={`plugin-ui-host-rendered plugin-ui-host-rendered--${props.viewType}${props.uiSlot ? ` plugin-ui-host-rendered--${props.uiSlot.replaceAll('.', '-')}` : ''}${props.supportsPopover ? ' plugin-ui-host-rendered--popover-content' : ''}`}
        >
          {renderedUi}
        </div>
      </>
    );
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
              height: maxHeight,
            });
          } else {
            setToolbarPopover(null);
          }
          portRef.current?.postMessage({
            type: 'pico:plugin-ui:toolbar-toggle',
            open: nextOpen,
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
            const width = toolbarPopoverWidth();
            const height = popover ? Math.min(popover.height, Math.max(0, window.innerHeight - 24)) : 0;
            const belowTop = anchor.top + anchor.height + 9;
            const belowSpace = window.innerHeight - belowTop - 12;
            const top = belowSpace >= height ? belowTop : Math.max(12, anchor.top - height - 9);
            return {
              left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
              top,
              width,
              height: 'auto',
              maxHeight: popover ? availablePopoverHeight(anchor.top, anchor.height) : 0,
              display: popover ? 'block' : 'none',
            };
          })()}
        >
          <div
            className={`plugin-ui-host-rendered plugin-ui-host-rendered--${props.uiSlot?.replaceAll('.', '-') ?? 'settings-page'}`}
          >
            {renderedUi}
          </div>
        </div>,
        document.body,
        `${props.pluginId}:${props.viewId}`,
      )}
      {iframe}
    </>
  );
}
