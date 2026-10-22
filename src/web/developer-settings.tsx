import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PluginUiDiagnostic } from './plugin-ui-diagnostics.js';
import { getPluginUiDiagnostics, subscribePluginUiDiagnostics } from './plugin-ui-diagnostics.js';

type DeveloperSettingsProps = {
  plugins: Array<{ id: string; name: string; version: string }>;
  catalog: Array<{
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    loaded: boolean;
    error?: string;
  }>;
  pluginErrors: string[];
};

type BrowserSnapshot = {
  origin: string;
  secureContext: boolean;
  userAgent: string;
  platform: string;
  language: string;
  viewport: string;
  pixelRatio: number;
  messageChannel: boolean;
  resizeObserver: boolean;
  randomUUID: boolean;
};

function browserSnapshot(): BrowserSnapshot {
  return {
    origin: window.location.origin,
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'Unknown',
    language: navigator.language || 'Unknown',
    viewport: `${window.innerWidth} × ${window.innerHeight}`,
    pixelRatio: window.devicePixelRatio || 1,
    messageChannel: typeof MessageChannel === 'function',
    resizeObserver: typeof ResizeObserver === 'function',
    randomUUID: typeof crypto.randomUUID === 'function',
  };
}

function diagnosticLabel(stage: PluginUiDiagnostic['stage']): string {
  switch (stage) {
    case 'loading':
      return 'Waiting for iframe load';
    case 'load-timeout':
      return 'Iframe load timed out';
    case 'document-loaded':
      return 'Document loaded';
    case 'bridge-ready':
      return 'Bridge responded';
    case 'initializing':
      return 'Waiting for plugin UI';
    case 'init-acknowledged':
      return 'Init reached iframe';
    case 'communicating':
      return 'Responding; no ready signal';
    case 'ready':
      return 'Ready';
    case 'init-timeout':
      return 'No response after init';
    case 'ready-timeout':
      return 'Plugin UI did not signal ready';
    case 'error':
      return 'Error';
  }
}

function isDiagnosticWarning(stage: PluginUiDiagnostic['stage']): boolean {
  return stage === 'error' || stage === 'load-timeout' || stage === 'init-timeout' || stage === 'ready-timeout';
}

function capabilityLabel(value: boolean | null | undefined): string {
  return value === undefined || value === null ? 'unknown' : value ? 'yes' : 'no';
}

function makeDiagnosticReport(
  browser: BrowserSnapshot,
  plugins: DeveloperSettingsProps['plugins'],
  catalog: DeveloperSettingsProps['catalog'],
  pluginUis: PluginUiDiagnostic[],
): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      browser,
      plugins: {
        runtime: plugins.map(({ id, name, version }) => ({ id, name, version })),
        catalog: catalog.map(({ id, name, version, enabled, loaded }) => ({
          id,
          name,
          version,
          enabled,
          loaded,
        })),
      },
      pluginUis,
    },
    null,
    2,
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

export function DeveloperSettings({ plugins, catalog, pluginErrors }: DeveloperSettingsProps) {
  const [browser, setBrowser] = useState(browserSnapshot);
  const [copyStatus, setCopyStatus] = useState('');
  const pluginUis = useSyncExternalStore(subscribePluginUiDiagnostics, getPluginUiDiagnostics, getPluginUiDiagnostics);

  useEffect(() => {
    const update = (): void => setBrowser(browserSnapshot());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  const visiblePlugins: Array<{
    id: string;
    name: string;
    version: string;
    state: 'Loaded' | 'Load failed' | 'Disabled';
    error?: string;
  }> =
    catalog.length > 0
      ? catalog.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          state: plugin.loaded ? 'Loaded' : plugin.enabled ? 'Load failed' : 'Disabled',
          ...(plugin.error ? { error: plugin.error } : {}),
        }))
      : plugins.map((plugin) => ({ ...plugin, state: 'Loaded' }));

  const report = makeDiagnosticReport(browser, plugins, catalog, pluginUis);

  const copyReport = async (): Promise<void> => {
    const copied = await copyText(report);
    setCopyStatus(copied ? 'Diagnostics copied.' : 'Copy was blocked. Select the text below to copy it.');
  };

  return (
    <section className="plugin-settings-page developer-settings-page" aria-label="Developer diagnostics">
      <p className="form-intro">
        Browser and plugin UI diagnostics collected by Pico. This page is rendered by Pico and does not use a plugin
        iframe. The report excludes settings, messages, credentials, and raw plugin errors; review the origin and user
        agent before sharing it.
      </p>

      <section className="developer-diagnostic-card" aria-labelledby="developer-browser-heading">
        <h3 id="developer-browser-heading">Browser environment</h3>
        <dl className="developer-diagnostic-grid">
          <div>
            <dt>Origin</dt>
            <dd>{browser.origin}</dd>
          </div>
          <div>
            <dt>Secure context</dt>
            <dd className={!browser.secureContext ? 'is-warning' : ''}>{browser.secureContext ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Platform / language</dt>
            <dd>
              {browser.platform} · {browser.language}
            </dd>
          </div>
          <div>
            <dt>Viewport / pixel ratio</dt>
            <dd>
              {browser.viewport} · {browser.pixelRatio}×
            </dd>
          </div>
          <div>
            <dt>MessageChannel</dt>
            <dd>{browser.messageChannel ? 'Available' : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>ResizeObserver</dt>
            <dd>{browser.resizeObserver ? 'Available' : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>crypto.randomUUID</dt>
            <dd className={!browser.randomUUID ? 'is-warning' : ''}>
              {browser.randomUUID ? 'Available' : 'Unavailable'}
            </dd>
          </div>
        </dl>
        <p className="developer-user-agent">{browser.userAgent}</p>
        {!browser.secureContext ? (
          <p className="developer-diagnostic-warning">
            This page is not in a secure context. Some browser APIs, including crypto.randomUUID, may be unavailable.
          </p>
        ) : null}
      </section>

      <section className="developer-diagnostic-card" aria-labelledby="developer-plugin-heading">
        <h3 id="developer-plugin-heading">Runtime plugins</h3>
        {catalog.length === 0 && plugins.length === 0 ? (
          <p className="field-note">No plugin status is available.</p>
        ) : (
          <ul className="developer-plugin-list">
            {visiblePlugins.map((plugin) => (
              <li key={plugin.id}>
                <span>
                  <strong>{plugin.name}</strong>
                  <small>
                    {plugin.id} · v{plugin.version}
                  </small>
                  {plugin.error ? <small className="is-warning">{plugin.error}</small> : null}
                </span>
                <span className={`developer-status ${plugin.state === 'Loaded' ? 'is-ready' : 'is-warning'}`}>
                  {plugin.state}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pluginErrors.map((message, index) => (
          <p className="developer-diagnostic-warning" key={`${index}:${message}`}>
            {message}
          </p>
        ))}
      </section>

      <section className="developer-diagnostic-card" aria-labelledby="developer-ui-heading">
        <h3 id="developer-ui-heading">Plugin UI views</h3>
        <p className="field-note">
          Each row is a separate embedded plugin view. Rows marked “not mounted” are earlier views from this session;
          timeout labels identify the last handshake step the browser could confirm.
        </p>
        {pluginUis.length === 0 ? (
          <p className="field-note">
            No plugin UI has reported a load attempt in this session. Open the affected Settings page or control, then
            return here to inspect its status.
          </p>
        ) : (
          <ul className="developer-plugin-list developer-ui-list">
            {pluginUis.map((view) => (
              <li key={view.key}>
                <span>
                  <strong>
                    {view.pluginId} · {view.viewType}: {view.viewId}
                  </strong>
                  <small>
                    {view.entry}
                    {view.uiSlot ? ` · ${view.uiSlot}` : ''}
                  </small>
                  {view.detail ? (
                    <small className={isDiagnosticWarning(view.stage) ? 'is-warning' : ''}>
                      {view.detail}
                    </small>
                  ) : null}
                  <small>Path: {view.history.map((event) => diagnosticLabel(event.stage)).join(' → ')}</small>
                  {view.history
                    .filter((event) => event.stage === 'error' && event.detail)
                    .slice(-1)
                    .map((event) => (
                      <small className="is-warning" key={event.at}>
                        Earlier error: {event.detail}
                      </small>
                    ))}
                  <small>
                    Frame: {view.mounted === false ? 'not mounted' : 'mounted'} · Probe bridge:{' '}
                    {view.bridgeResponded ? 'yes' : 'no'} · Init: {view.initSent ? 'sent' : 'not sent'} · Init received:{' '}
                    {view.initAcknowledged ? 'yes' : 'no'} · Ready: {view.readyReceived ? 'yes' : 'no'}
                  </small>
                  <small>
                    Iframe APIs: secure context {capabilityLabel(view.frameSecureContext)} · crypto.randomUUID{' '}
                    {capabilityLabel(view.frameRandomUUID)} · ResizeObserver {capabilityLabel(view.frameResizeObserver)}{' '}
                    · MessageChannel {capabilityLabel(view.frameMessageChannel)}
                  </small>
                  <small>
                    Updated {new Date(view.updatedAt).toLocaleTimeString()}
                  </small>
                </span>
                <span
                  className={`developer-status ${view.stage === 'ready' ? 'is-ready' : isDiagnosticWarning(view.stage) ? 'is-warning' : ''}`}
                >
                  {diagnosticLabel(view.stage)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="developer-diagnostic-card developer-report-card" aria-labelledby="developer-report-heading">
        <div className="developer-report-heading">
          <h3 id="developer-report-heading">Diagnostic report</h3>
          <button type="button" className="button button-quiet" onClick={() => void copyReport()}>
            Copy report
          </button>
        </div>
        {copyStatus ? (
          <p className="field-note" role="status">
            {copyStatus}
          </p>
        ) : null}
        <textarea
          className="developer-report-output"
          readOnly
          value={report}
          rows={8}
          aria-label="Diagnostic report text"
        />
      </section>
    </section>
  );
}
