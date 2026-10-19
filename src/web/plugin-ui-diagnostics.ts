export type PluginUiDiagnosticStage =
  | 'loading'
  | 'document-loaded'
  | 'bridge-ready'
  | 'initializing'
  | 'init-acknowledged'
  | 'communicating'
  | 'ready'
  | 'init-timeout'
  | 'ready-timeout'
  | 'error';

export type PluginUiDiagnostic = {
  key: string;
  pluginId: string;
  entry: string;
  viewType: 'page' | 'component';
  viewId: string;
  uiSlot?: string;
  stage: PluginUiDiagnosticStage;
  updatedAt: string;
  history: Array<{ stage: PluginUiDiagnosticStage; at: string; detail?: string }>;
  bridgeResponded?: boolean;
  initSent?: boolean;
  initAcknowledged?: boolean;
  readyReceived?: boolean;
  mounted?: boolean;
  frameSecureContext?: boolean | null;
  frameRandomUUID?: boolean | null;
  frameResizeObserver?: boolean | null;
  frameMessageChannel?: boolean | null;
  detail?: string;
  lastResizePx?: number | null;
  visible?: boolean | null;
  widthPx?: number | null;
};

export type PluginUiDiagnosticIdentity = Pick<
  PluginUiDiagnostic,
  'pluginId' | 'entry' | 'viewType' | 'viewId' | 'uiSlot'
>;

const MAX_DIAGNOSTICS = 80;
let diagnostics: PluginUiDiagnostic[] = [];
const mountedViewCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function keyFor(identity: PluginUiDiagnosticIdentity): string {
  return JSON.stringify([identity.pluginId, identity.entry, identity.viewType, identity.viewId, identity.uiSlot ?? '']);
}

export function getPluginUiDiagnostics(): PluginUiDiagnostic[] {
  return diagnostics;
}

export function subscribePluginUiDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportPluginUiDiagnostic(
  identity: PluginUiDiagnosticIdentity,
  update: Pick<PluginUiDiagnostic, 'stage'> &
    Partial<
      Pick<
        PluginUiDiagnostic,
        | 'detail'
        | 'lastResizePx'
        | 'visible'
        | 'widthPx'
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
    >,
): void {
  const key = keyFor(identity);
  const previous = diagnostics.find((item) => item.key === key);
  const updatedAt = new Date().toISOString();
  const nextDetail = update.detail === undefined ? previous?.detail : update.detail;
  const stageChanged = previous?.stage !== update.stage || previous?.detail !== nextDetail;
  const history = stageChanged
    ? [
        ...(previous?.history ?? []),
        { stage: update.stage, at: updatedAt, ...(update.detail === undefined ? {} : { detail: update.detail }) },
      ].slice(-8)
    : (previous?.history ?? []);
  const next: PluginUiDiagnostic = {
    ...previous,
    ...identity,
    ...update,
    key,
    updatedAt,
    history,
  };
  diagnostics = [next, ...diagnostics.filter((item) => item.key !== key)].slice(0, MAX_DIAGNOSTICS);
  for (const listener of listeners) listener();
}

export function markPluginUiDiagnosticMounted(identity: PluginUiDiagnosticIdentity, mounted: boolean): void {
  const key = keyFor(identity);
  const previousCount = mountedViewCounts.get(key) ?? 0;
  const count = Math.max(0, previousCount + (mounted ? 1 : -1));
  if (count === 0) mountedViewCounts.delete(key);
  else mountedViewCounts.set(key, count);
  const isMounted = count > 0;
  const previous = diagnostics.find((item) => item.key === key);
  if (!previous || previous.mounted === isMounted) return;
  diagnostics = diagnostics.map((item) =>
    item.key === key ? { ...item, mounted: isMounted, updatedAt: new Date().toISOString() } : item,
  );
  for (const listener of listeners) listener();
}
