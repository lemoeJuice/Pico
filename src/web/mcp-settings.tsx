import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, Pencil, Play, Plus, Square, Trash2, X } from 'lucide-react';

type McpTransport = 'stdio' | 'streamable-http';

type McpToolView = { name: string; description: string };

type McpServerView = {
  id: string;
  name: string;
  transport: McpTransport;
  status: string;
  autoStart: boolean;
  hasToken: boolean;
  privateNetworkConfirmed: boolean;
  executionFingerprint?: string;
  lastError: string | null;
  tools: McpToolView[];
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envKeys?: string[];
};

type McpServerInput = {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  bearerToken?: string;
  confirmPrivateNetworkAccess?: boolean;
  autoStart: boolean;
};

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

type FormDraft = {
  id: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  lastKnownUrlOrigin: string | null;
  bearerToken: string;
  clearToken: boolean;
  confirmPrivateNetworkAccess: boolean;
  autoStart: boolean;
  replaceEnv: boolean;
  envText: string;
};

function emptyForm(): FormDraft {
  return {
    id: null,
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    cwd: '',
    url: '',
    lastKnownUrlOrigin: null,
    bearerToken: '',
    clearToken: false,
    confirmPrivateNetworkAccess: false,
    autoStart: false,
    replaceEnv: false,
    envText: '',
  };
}

function draftFor(server: McpServerView): FormDraft {
  return {
    ...emptyForm(),
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    lastKnownUrlOrigin: getHttpOrigin(server.url ?? ''),
    autoStart: server.autoStart,
    confirmPrivateNetworkAccess: server.privateNetworkConfirmed,
  };
}

function environmentFromText(value: string): Record<string, string> {
  const entries = value.split(/\r?\n/).filter((line) => line.trim() !== '');
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('Enter environment variables as KEY=value, one per line.');
    const key = entry.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    env[key] = entry.slice(separator + 1);
  }
  return env;
}

function inputFromDraft(draft: FormDraft): McpServerInput {
  const base = { name: draft.name.trim(), transport: draft.transport, autoStart: draft.autoStart };
  if (draft.transport === 'stdio') {
    return {
      ...base,
      command: draft.command.trim(),
      args: draft.argsText.split(/\r?\n/).filter((argument) => argument !== ''),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      ...(draft.replaceEnv ? { env: environmentFromText(draft.envText) } : {}),
    };
  }
  return {
    ...base,
    url: draft.url.trim(),
    ...(draft.bearerToken ? { bearerToken: draft.bearerToken } : {}),
    confirmPrivateNetworkAccess: draft.confirmPrivateNetworkAccess,
  };
}

function displayStatus(status: string): string {
  return status.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function updateMcpHttpUrlDraft(
  current: Pick<FormDraft, 'url' | 'lastKnownUrlOrigin' | 'confirmPrivateNetworkAccess'>,
  url: string,
): Pick<FormDraft, 'url' | 'lastKnownUrlOrigin' | 'confirmPrivateNetworkAccess'> {
  const nextOrigin = getHttpOrigin(url);
  const originChanged =
    nextOrigin !== null && current.lastKnownUrlOrigin !== null && nextOrigin !== current.lastKnownUrlOrigin;
  return {
    url,
    lastKnownUrlOrigin: nextOrigin ?? current.lastKnownUrlOrigin,
    confirmPrivateNetworkAccess: originChanged ? false : current.confirmPrivateNetworkAccess,
  };
}

export function localStartRequestBody(server: Pick<McpServerView, 'executionFingerprint'>) {
  if (!server.executionFingerprint) throw new Error('The local execution confirmation fingerprint is missing.');
  return { confirmLocalExecution: true as const, executionFingerprint: server.executionFingerprint };
}

export function McpPrivateNetworkAccessControl({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <>
      <p className="field-note mcp-private-network-note">
        Pico blocks loopback, private and link-local network destinations by default. Allowing these addresses can
        expose local services to this remote MCP connection.
      </p>
      <label className="mcp-checkbox-label">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        Allow this server to connect to loopback, private and link-local addresses
      </label>
      {checked ? (
        <p className="field-note mcp-private-network-warning">
          This authorization applies to the configured server URL and permits access to private network destinations.
          Only enable it if you trust the target.
        </p>
      ) : null}
    </>
  );
}

export function McpPrivateNetworkAccessStatus({ authorized }: { authorized: boolean }) {
  return (
    <small className={authorized ? 'mcp-private-network-status is-authorized' : 'mcp-private-network-status'}>
      {authorized
        ? 'Loopback, private and link-local network access authorized'
        : 'Loopback, private and link-local network access blocked by default'}
    </small>
  );
}

export function McpStartConfirmation({
  server,
  busy,
  action,
  onCancel,
  onConfirm,
}: {
  server: McpServerView;
  busy: boolean;
  action: 'start' | 'restart';
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div className="mcp-confirm-backdrop">
      <section className="mcp-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mcp-confirm-title">
        <h3 id="mcp-confirm-title">
          {action === 'restart' ? 'Restart this local MCP process?' : 'Start a local MCP process?'}
        </h3>
        <p>
          This process will run with the same operating-system permissions as Pico. Confirm that you trust this command
          and its arguments.
        </p>
        <dl>
          <div>
            <dt>Command</dt>
            <dd>
              <code>{server.command ?? '(missing command)'}</code>
            </dd>
          </div>
          <div>
            <dt>Arguments</dt>
            <dd>
              {server.args?.length ? (
                server.args.map((argument, index) => <code key={`${index}:${argument}`}>{argument}</code>)
              ) : (
                <span>(none)</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Working directory</dt>
            <dd>
              <code>{server.cwd || '(Pico default)'}</code>
            </dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>
              {server.envKeys?.length ? (
                server.envKeys.map((key) => <code key={key}>{key}</code>)
              ) : (
                <span>(none configured)</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="mcp-env-warning">
          Environment variable values are hidden and may contain credentials. Pico will pass these configured values to
          the local process.
        </p>
        <div className="form-actions">
          <button type="button" className="button button-quiet" disabled={busy} onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            {action === 'restart' ? 'Restart local process' : 'Start local process'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function McpSettings({ request, refreshVersion = 0 }: { request: Request; refreshVersion?: number }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [pendingStart, setPendingStart] = useState<McpServerView | null>(null);
  const [pendingStartAction, setPendingStartAction] = useState<'start' | 'restart'>('start');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    const result = await request<{ servers: McpServerView[] }>('/api/mcp/servers');
    setServers(result.servers);
  }, [request]);

  useEffect(() => {
    let active = true;
    void request<{ servers: McpServerView[] }>('/api/mcp/servers')
      .then((result) => {
        if (active) setServers(result.servers);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'MCP servers could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [request, refreshVersion]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const input = inputFromDraft(draft);
      const requestInput =
        draft.id && draft.transport === 'streamable-http' && draft.clearToken
          ? { ...input, clearBearerToken: true }
          : input;
      if (!input.name) throw new Error('Enter a name for this MCP server.');
      if (input.transport === 'stdio' && !input.command)
        throw new Error('Enter the command to start the local server.');
      if (input.transport === 'streamable-http' && !input.url) throw new Error('Enter the remote MCP server URL.');
      if (draft.id) {
        await request<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(draft.id)}`, {
          method: 'PUT',
          body: JSON.stringify(requestInput),
        });
        setNotice('MCP server settings saved.');
      } else {
        await request<{ server: McpServerView }>('/api/mcp/servers', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        setNotice('MCP server added.');
      }
      setDraft(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MCP server settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (server: McpServerView, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if ((action === 'start' || action === 'restart') && server.transport === 'stdio') {
      if (!server.executionFingerprint) {
        setError(
          'This local server configuration is missing its confirmation fingerprint. Reload and review it again.',
        );
        return;
      }
      setPendingStart(server);
      setPendingStartAction(action);
      return;
    }
    await performAction(server, action, false);
  };

  const performAction = async (
    server: McpServerView,
    action: 'start' | 'stop' | 'restart',
    confirmLocalExecution: boolean,
  ): Promise<void> => {
    setBusyId(server.id);
    setError('');
    setNotice('');
    try {
      const serverPath = `/api/mcp/servers/${encodeURIComponent(server.id)}`;
      if (action === 'restart') {
        await request<{ server: McpServerView }>(`${serverPath}/stop`, { method: 'POST', body: JSON.stringify({}) });
      }
      const endpointAction = action === 'restart' ? 'start' : action;
      const body = confirmLocalExecution ? localStartRequestBody(server) : {};
      const result = await request<{ server: McpServerView }>(`${serverPath}/${endpointAction}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result.server.status === 'failed') {
        setError(result.server.lastError ?? `${server.name} could not connect.`);
      } else {
        setNotice(`${server.name} ${action === 'stop' ? 'stopped' : action === 'restart' ? 'restarted' : 'started'}.`);
      }
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `MCP server could not be ${action}ed.`);
    } finally {
      setBusyId(null);
      setPendingStart(null);
    }
  };

  const deleteServer = async (server: McpServerView): Promise<void> => {
    if (!window.confirm(`Delete the MCP server “${server.name}”?`)) return;
    setBusyId(server.id);
    setError('');
    setNotice('');
    try {
      await request<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
      setNotice(`${server.name} deleted.`);
      if (draft?.id === server.id) setDraft(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MCP server could not be deleted.');
    } finally {
      setBusyId(null);
    }
  };

  const updateDraft = (update: Partial<FormDraft>): void =>
    setDraft((current) => (current ? { ...current, ...update } : current));

  return (
    <section className="plugin-settings-page mcp-settings-page" aria-label="MCP server management">
      <p className="form-intro">
        Connect Pico to remote MCP servers or let this Runtime start a local server process. Pico manages each
        connection and makes its discovered tools available to Threads.
      </p>
      <p className="field-note mcp-security-note">
        Local server processes run with the same operating-system permissions as Pico. Review the command and all
        arguments before starting one. This setting does not expose an MCP endpoint from Pico.
      </p>
      {error ? (
        <p className="mcp-inline-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mcp-inline-message" role="status">
          {notice}
        </p>
      ) : null}

      <div className="mcp-list-heading">
        <h2>MCP servers</h2>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setError('');
            setNotice('');
            setDraft(emptyForm());
          }}
          disabled={draft !== null}
        >
          <Plus size={13} aria-hidden="true" /> Add server
        </button>
      </div>

      {servers === null ? (
        <p className="field-note">Loading MCP servers…</p>
      ) : servers.length === 0 ? (
        <p className="field-note">No MCP servers are configured.</p>
      ) : (
        <div className="mcp-server-list">
          {servers.map((server) => (
            <article className="mcp-server-card" key={server.id}>
              <div className="mcp-server-card-header">
                <div className="mcp-server-title">
                  <h3>{server.name}</h3>
                  <span
                    className={`mcp-server-status status-${server.status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                  >
                    {displayStatus(server.status)}
                  </span>
                </div>
                <small>{server.transport === 'stdio' ? 'Local process · stdio' : 'Remote · Streamable HTTP'}</small>
              </div>
              <div className="mcp-server-summary">
                {server.transport === 'stdio' ? (
                  <>
                    {server.command ? <code>{server.command}</code> : null}
                    {server.args?.length ? <small>Arguments: {server.args.join(' · ')}</small> : null}
                    {server.cwd ? <small>Working directory: {server.cwd}</small> : null}
                    {server.envKeys?.length ? (
                      <small>Environment variable names saved: {server.envKeys.join(', ')}</small>
                    ) : null}
                  </>
                ) : (
                  <>
                    {server.url ? <code>{server.url}</code> : null}
                    <small>{server.hasToken ? 'Bearer token saved' : 'No bearer token saved'}</small>
                    <McpPrivateNetworkAccessStatus authorized={server.privateNetworkConfirmed} />
                  </>
                )}
                <small>
                  {server.autoStart
                    ? server.transport === 'stdio'
                      ? 'Starts with Pico after local execution has been confirmed'
                      : 'Starts automatically with Pico'
                    : 'Manual start'}
                </small>
              </div>
              {server.lastError ? <p className="mcp-server-error">{server.lastError}</p> : null}
              <details className="mcp-tools-details">
                <summary>Discovered tools ({server.tools.length})</summary>
                {server.tools.length ? (
                  <ul>
                    {server.tools.map((tool) => (
                      <li key={tool.name}>
                        <strong>{tool.name}</strong>
                        {tool.description ? <span>{tool.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-note">No tools are currently available.</p>
                )}
              </details>
              <div className="mcp-server-actions">
                {server.status === 'ready' ? (
                  server.transport === 'stdio' ? (
                    <>
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={busyId !== null}
                        onClick={() => void runAction(server, 'restart')}
                      >
                        {busyId === server.id ? (
                          <LoaderCircle size={12} aria-hidden="true" />
                        ) : (
                          <Play size={12} aria-hidden="true" />
                        )}
                        Restart
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={busyId !== null}
                        onClick={() => void runAction(server, 'stop')}
                      >
                        {busyId === server.id ? (
                          <LoaderCircle size={12} aria-hidden="true" />
                        ) : (
                          <Square size={12} aria-hidden="true" />
                        )}
                        Stop
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button button-quiet"
                      disabled={busyId !== null}
                      onClick={() => void runAction(server, 'stop')}
                    >
                      {busyId === server.id ? (
                        <LoaderCircle size={12} aria-hidden="true" />
                      ) : (
                        <Square size={12} aria-hidden="true" />
                      )}
                      Stop
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={busyId !== null}
                    onClick={() => void runAction(server, 'start')}
                  >
                    {busyId === server.id ? (
                      <LoaderCircle size={12} aria-hidden="true" />
                    ) : (
                      <Play size={12} aria-hidden="true" />
                    )}
                    {server.transport === 'streamable-http' && server.status === 'failed' ? 'Reconnect' : 'Start'}
                  </button>
                )}
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busyId !== null || draft !== null}
                  onClick={() => {
                    setError('');
                    setNotice('');
                    setDraft(draftFor(server));
                  }}
                >
                  <Pencil size={12} aria-hidden="true" /> Edit
                </button>
                <button
                  type="button"
                  className="button button-quiet mcp-delete-button"
                  disabled={busyId !== null}
                  onClick={() => void deleteServer(server)}
                >
                  <Trash2 size={12} aria-hidden="true" /> Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {draft ? (
        <form className="mcp-editor" onSubmit={(event) => void save(event)}>
          <div className="mcp-editor-heading">
            <h3>{draft.id ? 'Edit MCP server' : 'Add MCP server'}</h3>
            <button
              type="button"
              className="button button-quiet"
              aria-label="Close editor"
              onClick={() => setDraft(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <label>
            Name
            <input required value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
          </label>
          <label>
            Connection type
            <select
              value={draft.transport}
              onChange={(event) => updateDraft({ transport: event.target.value as McpTransport })}
            >
              <option value="stdio">Start a local process (stdio)</option>
              <option value="streamable-http">Connect to a remote server (Streamable HTTP)</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label>
                Command
                <input
                  required
                  value={draft.command}
                  onChange={(event) => updateDraft({ command: event.target.value })}
                />
              </label>
              <label>
                Arguments, one per line
                <textarea
                  rows={4}
                  value={draft.argsText}
                  onChange={(event) => updateDraft({ argsText: event.target.value })}
                  placeholder={'--config\n/path/to/config.json'}
                />
              </label>
              <label>
                Working directory (optional)
                <input value={draft.cwd} onChange={(event) => updateDraft({ cwd: event.target.value })} />
              </label>
              {draft.id && servers?.find((server) => server.id === draft.id)?.envKeys?.length ? (
                <p className="field-note">
                  Saved environment variable names:{' '}
                  {servers.find((server) => server.id === draft.id)?.envKeys?.join(', ')}. Their values are hidden;
                  leave replacement off to keep them.
                </p>
              ) : null}
              <label className="mcp-checkbox-label">
                <input
                  type="checkbox"
                  checked={draft.replaceEnv}
                  onChange={(event) => updateDraft({ replaceEnv: event.target.checked })}
                />
                Replace saved environment variables
              </label>
              {draft.replaceEnv ? (
                <label>
                  Environment variables, one KEY=value per line
                  <textarea
                    rows={3}
                    value={draft.envText}
                    onChange={(event) => updateDraft({ envText: event.target.value })}
                    placeholder="Leave empty to clear saved variables"
                    autoComplete="off"
                  />
                </label>
              ) : null}
            </>
          ) : (
            <>
              <label>
                Server URL
                <input
                  required
                  type="url"
                  value={draft.url}
                  onChange={(event) => {
                    const urlUpdate = updateMcpHttpUrlDraft(draft, event.target.value);
                    updateDraft(urlUpdate);
                  }}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <McpPrivateNetworkAccessControl
                checked={draft.confirmPrivateNetworkAccess}
                onChange={(confirmPrivateNetworkAccess) => updateDraft({ confirmPrivateNetworkAccess })}
              />
              <label>
                Bearer token{' '}
                <span className="field-note">
                  {draft.id && servers?.find((server) => server.id === draft.id)?.hasToken
                    ? 'A token is saved. Leave blank to keep it. Bearer tokens require HTTPS.'
                    : 'Optional. Bearer tokens require HTTPS.'}
                </span>
                <input
                  type="password"
                  value={draft.bearerToken}
                  onChange={(event) =>
                    updateDraft({
                      bearerToken: event.target.value,
                      ...(event.target.value ? { clearToken: false } : {}),
                    })
                  }
                  autoComplete="new-password"
                  placeholder={
                    draft.id && servers?.find((server) => server.id === draft.id)?.hasToken
                      ? 'Saved · enter a new token to replace'
                      : 'Bearer token'
                  }
                />
              </label>
              {draft.id && servers?.find((server) => server.id === draft.id)?.hasToken ? (
                <label className="mcp-checkbox-label">
                  <input
                    type="checkbox"
                    checked={draft.clearToken}
                    onChange={(event) =>
                      updateDraft({
                        clearToken: event.target.checked,
                        ...(event.target.checked ? { bearerToken: '' } : {}),
                      })
                    }
                  />
                  Clear saved bearer token
                </label>
              ) : null}
            </>
          )}
          <label className="mcp-checkbox-label">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(event) => updateDraft({ autoStart: event.target.checked })}
            />
            Start automatically when Pico Runtime starts
          </label>
          <div className="form-actions">
            <button type="button" className="button button-quiet" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save server'}
            </button>
          </div>
        </form>
      ) : null}

      {pendingStart ? (
        <McpStartConfirmation
          server={pendingStart}
          busy={busyId !== null}
          action={pendingStartAction}
          onCancel={() => setPendingStart(null)}
          onConfirm={() => void performAction(pendingStart, pendingStartAction, true)}
        />
      ) : null}
    </section>
  );
}
