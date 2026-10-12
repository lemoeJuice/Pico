import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AssistantPayload,
  CanonicalRecord,
  Execution,
  ExecutorKind,
  MessagePayload,
  ModelSettings,
  PermissionRequest,
  Project,
  PublicSettings,
  Thread,
  ToolCall,
  ToolResultPayload,
  UiContribution,
} from '../core/types.js';
import type { PermissionPolicy } from '../runtime/stages.js';
import type { ThreadSnapshot } from '../runtime/runtime.js';
import { isSessionExpired } from './session.js';
import { fetchStableSnapshot } from './snapshot-consistency.js';

type PluginInfo = {
  plugins: Array<{ id: string; name: string; version: string; source: string }>;
  ui: UiContribution[];
  pipelines: Array<{ stage: string; pluginId: string; order: number }>;
  errors: string[];
};

type RuntimeEvent = Record<string, unknown> & { type: string };
type ToolPermission = { name: string; description: string; policy: PermissionPolicy };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('pico:auth-expired'));
    const message =
      body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function recordPayload<T>(record: CanonicalRecord): T {
  return record.payload as unknown as T;
}

function StatePill({ state }: { state: Thread['state'] }) {
  const labels: Record<Thread['state'], string> = {
    idle: 'Idle',
    running: 'Working',
    pausing: 'Pausing',
    paused: 'Paused',
  };
  return (
    <span className={`state-pill state-${state}`}>
      <span className="state-dot" />
      {labels[state]}
    </span>
  );
}

function ExecutorPill({
  thread,
  connected,
  error,
}: {
  thread: Thread;
  connected: boolean | null;
  error: string | null;
}) {
  return (
    <span className={`executor-pill ${connected === false ? 'executor-offline' : ''}`} title={error ?? undefined}>
      <span className="executor-glyph">{thread.executorKind === 'container' ? '▧' : '⌂'}</span>
      <span>{thread.executorKind === 'container' ? 'Container' : 'Host'} Executor</span>
      {connected === null ? (
        <i className="tiny-spinner" />
      ) : (
        <i className={`connection-dot ${connected ? 'online' : 'offline'}`} />
      )}
    </span>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">PICO · SETTINGS</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function ThreadListItem({
  thread,
  active,
  child = false,
  onSelect,
}: {
  thread: Thread;
  active: boolean;
  child?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      className={`thread-list-item ${active ? 'selected' : ''} ${child ? 'child-thread-item' : ''}`}
      onClick={onSelect}
    >
      <span className="thread-item-icon">{child ? '↳' : '◌'}</span>
      <span className="thread-item-copy">
        <span className="thread-item-title">{thread.title}</span>
        <span className="thread-item-meta">
          {thread.executorKind === 'container' ? 'Container' : 'Host'} · {thread.state}
        </span>
      </span>
      {thread.state === 'running' || thread.state === 'pausing' ? <span className="mini-active-dot" /> : null}
    </button>
  );
}

function ToolCard({
  call,
  execution,
  result,
  approval,
  onApproval,
}: {
  call: ToolCall;
  execution: Execution | undefined;
  result: ToolResultPayload | undefined;
  approval: PermissionRequest | undefined;
  onApproval(executionId: string, allow: boolean, rememberForThread?: boolean): void;
}) {
  const status = approval?.status === 'pending' ? 'needs approval' : (execution?.status ?? 'pending');
  const resultText =
    result?.status === 'interrupted'
      ? `The tool was interrupted. Its side effects may be partial or unknown. Inspect the workspace before retrying.${result.error ? `\n\n${result.error}` : ''}`
      : result?.status === 'failed'
        ? (result.error ?? 'Tool failed.')
        : result
          ? toJson(result.result)
          : execution?.status === 'running'
            ? 'Running in the selected Executor…'
            : 'Waiting for the Executor…';
  return (
    <details className={`tool-card tool-${execution?.status ?? 'pending'}`}>
      <summary>
        <span className="tool-chevron">⌄</span>
        <span className="tool-name">{call.name}</span>
        <span
          className={`tool-status status-${approval?.status === 'pending' ? 'pending' : (execution?.status ?? 'pending')}`}
        >
          {status}
        </span>
      </summary>
      <div className="tool-card-body">
        {approval?.status === 'pending' && execution ? (
          <div className="approval-box">
            <div>
              <strong>Permission needed</strong>
              <p>Allow once, or remember this Tool choice for the Thread.</p>
            </div>
            <div className="approval-actions">
              <button className="button button-soft" onClick={() => onApproval(execution.id, false)}>
                Deny
              </button>
              <button className="button button-primary compact" onClick={() => onApproval(execution.id, true)}>
                Allow once
              </button>
              <button
                className="button button-soft compact"
                onClick={() => onApproval(execution.id, true, true)}
                title={`Allow ${call.name} in this Thread from now on`}
              >
                Allow in Thread
              </button>
            </div>
          </div>
        ) : null}
        <details className="tool-detail">
          <summary>Arguments</summary>
          <pre>{toJson(call.arguments)}</pre>
        </details>
        <details
          className="tool-detail"
          open={Boolean(result?.status === 'failed' || result?.status === 'interrupted')}
        >
          <summary>
            Result{' '}
            {execution?.updatedAt ? (
              <span className="subtle-inline">· {new Date(execution.updatedAt).toLocaleTimeString()}</span>
            ) : null}
          </summary>
          <pre className="tool-output">{resultText}</pre>
        </details>
      </div>
    </details>
  );
}

export function App({ authRequired = false, onSignOut }: { authRequired?: boolean; onSignOut?(): Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(localStorage.getItem('pico.project'));
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [pluginInfo, setPluginInfo] = useState<PluginInfo | null>(null);
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [permissions, setPermissions] = useState<ToolPermission[]>([]);
  const [executorConnected, setExecutorConnected] = useState<boolean | null>(null);
  const [executorError, setExecutorError] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const [assistantDraft, setAssistantDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newThreadTitle, setNewThreadTitle] = useState('');
  const [newThreadExecutor, setNewThreadExecutor] = useState<ExecutorKind>('container');
  const [modelForm, setModelForm] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: 0.2,
    hasApiKey: false,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const snapshotRequest = useRef(0);
  const threadUpdateVersions = useRef(new Map<string, number>());
  const snapshotVersions = useRef(new Map<string, number>());
  const retryMessage = useRef<{ id: string; content: string } | null>(null);

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedThread = snapshot?.thread ?? threads.find((thread) => thread.id === threadId) ?? null;
  const filteredCommands = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const token = draft.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    return commands.filter((command) => command.name.startsWith(token)).slice(0, 7);
  }, [commands, draft]);
  const uiContributions = (pluginInfo?.ui ?? []).filter((item) => item.slot === 'thread.toolbar');

  const loadThreads = useCallback(async (forProject: string) => {
    const values = await api<Thread[]>(`/api/projects/${encodeURIComponent(forProject)}/threads`);
    setThreads(values);
    const remembered = localStorage.getItem(`pico.thread.${forProject}`);
    const nextId = values.some((item) => item.id === remembered) ? remembered : (values[0]?.id ?? null);
    setThreadId(nextId);
  }, []);

  const loadSnapshot = useCallback(async (id: string) => {
    const requestNumber = ++snapshotRequest.current;
    const value = await fetchStableSnapshot(
      () => api<ThreadSnapshot>(`/api/threads/${encodeURIComponent(id)}`),
      () => snapshotVersions.current.get(id) ?? 0,
      () => requestNumber === snapshotRequest.current,
    );
    if (value && requestNumber === snapshotRequest.current) setSnapshot(value);
  }, []);

  const noteSnapshotChange = useCallback((threadId: string | null | undefined): void => {
    if (!threadId) return;
    snapshotVersions.current.set(threadId, (snapshotVersions.current.get(threadId) ?? 0) + 1);
  }, []);

  const refreshSelected = useCallback(() => {
    if (threadId)
      void loadSnapshot(threadId).catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [loadSnapshot, threadId]);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<Project[]>('/api/projects'),
      api<PublicSettings>('/api/settings/model'),
      api<Array<{ name: string; description: string }>>('/api/commands'),
      api<PluginInfo>('/api/plugins'),
      api<{ defaultWorkspace: string }>('/api/info'),
    ])
      .then(([projectList, modelSettings, commandList, pluginResult, info]) => {
        if (!alive) return;
        setProjects(projectList);
        setSettings(modelSettings);
        setModelForm({ ...modelSettings, apiKey: '' });
        setCommands(commandList);
        setPluginInfo(pluginResult);
        setDefaultWorkspace(info.defaultWorkspace);
        const remembered = localStorage.getItem('pico.project');
        const initial = projectList.find((project) => project.id === remembered)?.id ?? projectList[0]?.id ?? null;
        setProjectId(initial);
        if (initial) localStorage.setItem('pico.project', initial);
        else setNewProjectOpen(true);
        if (modelSettings.model.trim() === '') setSettingsOpen(false);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setThreads([]);
      setThreadId(null);
      setSnapshot(null);
      return;
    }
    localStorage.setItem('pico.project', projectId);
    void loadThreads(projectId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [projectId, loadThreads]);

  useEffect(() => {
    if (!threadId) {
      setSnapshot(null);
      return;
    }
    localStorage.setItem(`pico.thread.${projectId ?? 'none'}`, threadId);
    setAssistantDraft('');
    void loadSnapshot(threadId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => {
      snapshotRequest.current += 1;
    };
  }, [threadId, projectId, loadSnapshot]);

  useEffect(() => {
    if (!threadId) {
      setExecutorConnected(null);
      setExecutorError(null);
      setPermissions([]);
      return;
    }
    setExecutorConnected(null);
    setExecutorError(null);
    let alive = true;
    const refresh = async (): Promise<void> => {
      const [executor, nextPermissions] = await Promise.all([
        api<{ connected: boolean; error?: string }>(`/api/threads/${threadId}/executor`),
        api<ToolPermission[]>(`/api/threads/${threadId}/permissions`),
      ]);
      if (!alive) return;
      setExecutorConnected(executor.connected);
      setExecutorError(executor.connected ? null : (executor.error ?? 'Executor connection failed.'));
      setPermissions(nextPermissions);
    };
    void refresh().catch((caught: unknown) => {
      if (alive) {
        setExecutorConnected(false);
        setExecutorError(caught instanceof Error ? caught.message : String(caught));
      }
    });
    const timer = window.setInterval(() => {
      void refresh().catch((caught: unknown) => {
        if (alive) {
          setExecutorConnected(false);
          setExecutorError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    }, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId]);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    let retry = 750;
    let socket: WebSocket | null = null;
    const connect = (): void => {
      if (closed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/api/events`);
      socket.onopen = () => {
        retry = 750;
        setSocketConnected(true);
        refreshSelected();
      };
      socket.onmessage = (message) => {
        let event: RuntimeEvent;
        try {
          event = JSON.parse(String(message.data)) as RuntimeEvent;
        } catch {
          return;
        }
        if (event.type === 'thread.created') {
          const created = event.thread as Thread | undefined;
          if (created) {
            noteSnapshotChange(created.id);
            noteSnapshotChange(created.parentThreadId);
            setThreads((items) => [created, ...items.filter((item) => item.id !== created.id)]);
            setSnapshot((current) =>
              current && created.parentThreadId === current.thread.id
                ? { ...current, children: [created, ...current.children.filter((item) => item.id !== created.id)] }
                : current,
            );
          }
        } else if (event.type === 'thread.updated') {
          const updated = event.thread as Thread | undefined;
          if (updated) {
            threadUpdateVersions.current.set(updated.id, (threadUpdateVersions.current.get(updated.id) ?? 0) + 1);
            noteSnapshotChange(updated.id);
            noteSnapshotChange(updated.parentThreadId);
            setThreads((items) => items.map((item) => (item.id === updated.id ? updated : item)));
            setSnapshot((current) => (current?.thread.id === updated.id ? { ...current, thread: updated } : current));
          }
        } else if (event.type === 'record') {
          const record = event.record as CanonicalRecord | undefined;
          if (record?.threadId === threadId) {
            noteSnapshotChange(record.threadId);
            setSnapshot((current) => {
              if (
                !current ||
                current.thread.id !== record.threadId ||
                current.records.some((item) => item.id === record.id)
              )
                return current;
              return { ...current, records: [...current.records, record].sort((a, b) => a.seq - b.seq) };
            });
            if (record.kind === 'assistant') setAssistantDraft('');
          }
        } else if (event.type === 'execution.updated') {
          const execution = event.execution as Execution | undefined;
          if (execution?.threadId === threadId) {
            noteSnapshotChange(execution.threadId);
            setSnapshot((current) =>
              current
                ? {
                    ...current,
                    executions: [execution, ...current.executions.filter((item) => item.id !== execution.id)],
                  }
                : current,
            );
          }
        } else if (event.type === 'approval.updated') {
          const approval = event.approval as PermissionRequest | undefined;
          if (approval?.threadId === threadId) {
            noteSnapshotChange(approval.threadId);
            setSnapshot((current) =>
              current
                ? {
                    ...current,
                    approvals: [
                      approval,
                      ...current.approvals.filter((item) => item.executionId !== approval.executionId),
                    ],
                  }
                : current,
            );
          }
        } else if (event.type === 'model.delta' && event.threadId === threadId && typeof event.delta === 'string') {
          setAssistantDraft((text) => text + event.delta);
        } else if (event.type === 'model.draft-ended' && event.threadId === threadId) {
          setAssistantDraft('');
        } else if (event.type === 'runtime.error' && event.threadId === threadId) {
          setError(String(event.message ?? 'Runtime error'));
          setAssistantDraft('');
        } else if (event.type === 'runtime.notice' && event.threadId === threadId) {
          setNotice(String(event.message ?? 'Runtime notice'));
        } else if (event.type === 'permissions.updated' && event.threadId === threadId) {
          setPermissions(event.permissions as ToolPermission[]);
        } else if (event.type === 'settings.updated') {
          const value = event.settings as PublicSettings;
          setSettings(value);
          setModelForm((current) => ({ ...current, ...value }));
        }
      };
      socket.onclose = () => {
        setSocketConnected(false);
        void isSessionExpired().then((expired) => {
          if (expired) window.dispatchEvent(new Event('pico:auth-expired'));
        });
        if (!closed) {
          timer = window.setTimeout(connect, retry);
          retry = Math.min(retry * 1.7, 12_000);
        }
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [noteSnapshotChange, refreshSelected, threadId]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [snapshot?.records.length, assistantDraft]);

  const sendMessage = async (content = draft): Promise<void> => {
    const clean = content.trim();
    if (!threadId || !clean || busy) return;
    setBusy(true);
    setError('');
    const id = retryMessage.current?.content === clean ? retryMessage.current.id : crypto.randomUUID();
    retryMessage.current = { id, content: clean };
    try {
      const result = await api<{
        accepted: boolean;
        duplicate?: boolean;
        command?: { text?: string; openThreadId?: string };
      }>(`/api/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ id, content: clean }) });
      retryMessage.current = null;
      setDraft('');
      if (result.command?.text) setNotice(result.command.text);
      if (result.command?.openThreadId) setThreadId(result.command.openThreadId);
      void loadSnapshot(threadId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const project = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: newProjectName, workspacePath: newProjectPath || defaultWorkspace }),
      });
      setProjects((items) => [project, ...items]);
      setProjectId(project.id);
      localStorage.setItem('pico.project', project.id);
      setNewProjectOpen(false);
      setNewProjectName('');
      setNewProjectPath('');
      setThreads([]);
      setThreadId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const createThread = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError('');
    try {
      const thread = await api<Thread>(`/api/projects/${projectId}/threads`, {
        method: 'POST',
        body: JSON.stringify({ title: newThreadTitle, executorKind: newThreadExecutor }),
      });
      setThreads((items) => [thread, ...items.filter((item) => item.id !== thread.id)]);
      setThreadId(thread.id);
      localStorage.setItem(`pico.thread.${projectId}`, thread.id);
      setSnapshot(null);
      setNewThreadOpen(false);
      setNewThreadTitle('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const controlThread = async (action: 'pause' | 'continue' | 'interrupt'): Promise<void> => {
    if (!threadId) return;
    if (action === 'continue') setError('');
    const updateVersion = threadUpdateVersions.current.get(threadId) ?? 0;
    try {
      const updated = await api<Thread>(`/api/threads/${threadId}/${action}`, { method: 'POST', body: '{}' });
      setSnapshot((current) => {
        if (current?.thread.id !== updated.id || (threadUpdateVersions.current.get(threadId) ?? 0) !== updateVersion)
          return current;
        return { ...current, thread: updated };
      });
      setThreads((items) =>
        (threadUpdateVersions.current.get(threadId) ?? 0) === updateVersion
          ? items.map((item) => (item.id === updated.id ? updated : item))
          : items,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const resolveApproval = async (executionId: string, allow: boolean, rememberForThread = false): Promise<void> => {
    try {
      const approval = await api<PermissionRequest>(`/api/approvals/${executionId}`, {
        method: 'POST',
        body: JSON.stringify({ allow, ...(rememberForThread ? { rememberForThread: true } : {}) }),
      });
      setSnapshot((current) =>
        current
          ? {
              ...current,
              approvals: [approval, ...current.approvals.filter((item) => item.executionId !== executionId)],
            }
          : current,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const updatePermission = async (toolName: string, policy: PermissionPolicy): Promise<void> => {
    if (!threadId) return;
    try {
      const next = await api<ToolPermission[]>(`/api/threads/${threadId}/permissions/${encodeURIComponent(toolName)}`, {
        method: 'PUT',
        body: JSON.stringify({ policy }),
      });
      setPermissions(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const saveModelSettings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSettingsSaving(true);
    setError('');
    const body: Partial<ModelSettings> = {
      baseUrl: modelForm.baseUrl,
      model: modelForm.model,
      temperature: Number(modelForm.temperature),
    };
    if (modelForm.apiKey) body.apiKey = modelForm.apiKey;
    try {
      const saved = await api<PublicSettings>('/api/settings/model', { method: 'PUT', body: JSON.stringify(body) });
      setSettings(saved);
      setModelForm({ ...saved, apiKey: '' });
      setNotice('Model settings saved on this Pico Runtime.');
      setSettingsOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving(false);
    }
  };

  const clearApiKey = async (): Promise<void> => {
    try {
      const saved = await api<PublicSettings>('/api/settings/model', {
        method: 'PUT',
        body: JSON.stringify({
          baseUrl: modelForm.baseUrl,
          model: modelForm.model,
          temperature: Number(modelForm.temperature),
          apiKey: '',
        }),
      });
      setSettings(saved);
      setModelForm({ ...saved, apiKey: '' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const executeContribution = (item: UiContribution): void => {
    if (item.command) void sendMessage(item.command);
  };

  const chooseThread = (id: string): void => {
    setThreadId(id);
    localStorage.setItem(`pico.thread.${projectId ?? 'none'}`, id);
    setMobileSidebarOpen(false);
    setNotice('');
    setError('');
  };

  const records = snapshot?.records ?? [];
  const executions = snapshot?.executions ?? [];
  const approvals = snapshot?.approvals ?? [];
  const childrenByParent = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const children = childrenByParent.get(thread.parentThreadId) ?? [];
    children.push(thread);
    childrenByParent.set(thread.parentThreadId, children);
  }
  const renderThreadTree = (thread: Thread, child = false, depth = 0): ReactNode => (
    <div key={thread.id} style={depth > 1 ? { marginLeft: `${Math.min(depth - 1, 4) * 8}px` } : undefined}>
      <ThreadListItem
        thread={thread}
        active={thread.id === threadId}
        child={child}
        onSelect={() => chooseThread(thread.id)}
      />
      {(childrenByParent.get(thread.id) ?? []).map((nested) => renderThreadTree(nested, true, depth + 1))}
    </div>
  );
  const renderedRecords = records.filter((record) => record.kind === 'message' || record.kind === 'assistant');
  const currentState = selectedThread?.state ?? 'idle';

  return (
    <div className="app-shell">
      {mobileSidebarOpen ? (
        <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileSidebarOpen(false)} />
      ) : null}
      <aside className={`sidebar ${mobileSidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">
            <span>p</span>
            <i />
          </div>
          <div className="brand-name">
            pico<span>·</span>
          </div>
          <button
            className="icon-button mobile-close"
            aria-label="Close sidebar"
            onClick={() => setMobileSidebarOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="project-switcher">
          <label className="eyebrow" htmlFor="project-select">
            PROJECT
          </label>
          <div className="project-select-wrap">
            <select
              id="project-select"
              value={projectId ?? ''}
              onChange={(event) => setProjectId(event.target.value || null)}
            >
              <option value="">Choose a Project…</option>
              {projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="select-chevron">⌄</span>
          </div>
          <button className="sidebar-add-project" onClick={() => setNewProjectOpen(true)}>
            <span>＋</span> Add Project
          </button>
        </div>
        <div className="thread-section-heading">
          <span className="eyebrow">THREADS</span>
          <button
            className="icon-button small"
            aria-label="Create Thread"
            disabled={!projectId}
            onClick={() => setNewThreadOpen(true)}
          >
            ＋
          </button>
        </div>
        <div className="thread-list">
          {!selectedProject ? <div className="sidebar-empty">Create a Project to get started.</div> : null}
          {threads.filter((thread) => !thread.parentThreadId).map((thread) => renderThreadTree(thread))}
        </div>
        <div className="sidebar-bottom">
          <button className="settings-link" onClick={() => setSettingsOpen(true)}>
            <span className="settings-icon">⚙</span>
            <span>Model settings</span>
            {!settings?.model ? <span className="settings-needs-config">Set up</span> : null}
          </button>
          <div className="runtime-foot">
            <i className={socketConnected ? 'online' : 'offline'} />
            Runtime {socketConnected ? 'connected' : 'reconnecting'}
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Open navigation"
            onClick={() => setMobileSidebarOpen(true)}
          >
            ☰
          </button>
          <div className="breadcrumbs">
            <span>{selectedProject?.name ?? 'Pico'}</span>
            <b>/</b>
            <strong>{selectedThread?.title ?? 'Your workspace'}</strong>
          </div>
          {selectedThread ? (
            <div className="topbar-status">
              <ExecutorPill thread={selectedThread} connected={executorConnected} error={executorError} />
              <StatePill state={currentState} />
              {authRequired ? (
                <button className="session-logout" onClick={() => void onSignOut?.()} type="button">
                  Sign out
                </button>
              ) : null}
            </div>
          ) : (
            <div className="topbar-status">
              <span className="connection-label">
                <i className={socketConnected ? 'online' : 'offline'} />
                {socketConnected ? 'Runtime connected' : 'Connecting…'}
              </span>
              {authRequired ? (
                <button className="session-logout" onClick={() => void onSignOut?.()} type="button">
                  Sign out
                </button>
              ) : null}
            </div>
          )}
        </header>

        {selectedThread && executorConnected === false && executorError ? (
          <div className="banner banner-error executor-error" role="status">
            <span>
              <strong>
                {selectedThread.executorKind === 'container' ? 'Container' : 'Host'} Executor unavailable.
              </strong>{' '}
              {executorError}
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="banner banner-error">
            <span>{error}</span>
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        ) : null}
        {notice ? (
          <div className="banner banner-notice">
            <span>{notice}</span>
            <button onClick={() => setNotice('')}>Dismiss</button>
          </div>
        ) : null}

        {!selectedThread ? (
          <section className="welcome-screen">
            <div className="welcome-mark">
              <span>p</span>
              <i />
            </div>
            <p className="eyebrow">A SMALL PLACE TO THINK WITH AGENTS</p>
            <h1>
              Make room for
              <br />
              <em>good work.</em>
            </h1>
            <p className="welcome-copy">
              Pico keeps your conversations and execution state close, so you can pick up where you left off.
            </p>
            <div className="welcome-actions">
              <button className="button button-primary" onClick={() => setNewProjectOpen(true)}>
                Create a Project <span>↗</span>
              </button>
              {selectedProject ? (
                <button className="button button-soft" onClick={() => setNewThreadOpen(true)}>
                  Start a Thread
                </button>
              ) : null}
            </div>
            {!settings?.model ? (
              <button className="welcome-settings" onClick={() => setSettingsOpen(true)}>
                Configure a model connection <span>→</span>
              </button>
            ) : null}
          </section>
        ) : (
          <>
            <div className="conversation-header">
              <div className="conversation-title">
                <div className="thread-sparkle">✳</div>
                <div>
                  <h1>{selectedThread.title}</h1>
                  <p>
                    {selectedThread.parentThreadId ? 'Child Thread · ' : ''}
                    {selectedProject?.name} <span>·</span> {selectedThread.executorLabel}
                  </p>
                </div>
              </div>
              <div className="conversation-actions">
                {uiContributions.map((item) => (
                  <button
                    key={item.id}
                    className="button button-quiet plugin-action"
                    title={item.description}
                    onClick={() => executeContribution(item)}
                  >
                    {item.label}
                  </button>
                ))}
                <details className="permission-menu">
                  <summary className="button button-quiet">
                    Tools <span className="permission-count">{permissions.length}</span>
                  </summary>
                  <div className="permission-popover">
                    <div className="popover-heading">
                      <strong>Tool permissions</strong>
                      <span>Saved for this Thread</span>
                    </div>
                    {permissions.map((permission) => (
                      <label className="permission-row" key={permission.name}>
                        <span>
                          <strong>{permission.name}</strong>
                          <small>{permission.description}</small>
                        </span>
                        <select
                          value={permission.policy}
                          onChange={(event) =>
                            void updatePermission(permission.name, event.target.value as PermissionPolicy)
                          }
                        >
                          <option value="allow">Allow</option>
                          <option value="ask">Ask</option>
                          <option value="deny">Deny</option>
                        </select>
                      </label>
                    ))}
                  </div>
                </details>
                {currentState === 'running' ? (
                  <button className="button button-soft" onClick={() => void controlThread('pause')}>
                    Pause
                  </button>
                ) : null}
                {currentState === 'pausing' ? (
                  <button className="button button-soft" onClick={() => void controlThread('pause')}>
                    Pausing…
                  </button>
                ) : null}
                {currentState === 'paused' ? (
                  <button className="button button-primary compact" onClick={() => void controlThread('continue')}>
                    Continue
                  </button>
                ) : null}
                {currentState === 'running' || currentState === 'pausing' ? (
                  <button
                    className="interrupt-button"
                    onClick={() => void controlThread('interrupt')}
                    title="Try to stop the active execution"
                  >
                    Interrupt
                  </button>
                ) : null}
              </div>
            </div>

            <div className="conversation-scroll" ref={listRef}>
              <div className="timeline">
                {renderedRecords.map((record) =>
                  record.kind === 'message' ? (
                    <MessageBubble key={record.id} record={record} onOpenThread={chooseThread} />
                  ) : (
                    <AssistantBubble
                      key={record.id}
                      record={record}
                      executions={executions}
                      approvals={approvals}
                      records={records}
                      threadId={selectedThread.id}
                      onApproval={(id, allow, rememberForThread) => void resolveApproval(id, allow, rememberForThread)}
                    />
                  ),
                )}
                {assistantDraft ? (
                  <div className="assistant-message draft-message">
                    <div className="assistant-avatar">p</div>
                    <div className="message-body">
                      <div className="message-author">
                        Pico <span className="typing-label">writing</span>
                      </div>
                      <div className="markdown-like">
                        {assistantDraft}
                        <span className="cursor-block" />
                      </div>
                    </div>
                  </div>
                ) : null}
                {renderedRecords.length === 0 && !assistantDraft ? (
                  <div className="empty-thread">
                    <div className="empty-orbit">✳</div>
                    <h2>A fresh Thread</h2>
                    <p>
                      Send a message to begin. This Thread will stay bound to its {selectedThread.executorKind}{' '}
                      Executor.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="composer-wrap">
              {filteredCommands.length > 0 ? (
                <div className="command-menu">
                  {filteredCommands.map((command) => (
                    <button key={command.name} onClick={() => setDraft(`/${command.name} `)}>
                      <strong>/{command.name}</strong>
                      <span>{command.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="composer-box">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (filteredCommands.length > 0 && draft.trim() === '/')
                        setDraft(`/${filteredCommands[0]!.name} `);
                      else void sendMessage();
                    }
                  }}
                  placeholder="Write a message… use / for commands"
                  rows={2}
                  aria-label="Message"
                />
                <div className="composer-footer">
                  <span>
                    {selectedThread.state === 'paused' || selectedThread.state === 'pausing'
                      ? 'Messages are saved while paused.'
                      : 'Enter to send · Shift + Enter for a new line'}
                  </span>
                  <button
                    className="send-button"
                    aria-label="Send message"
                    disabled={!draft.trim() || busy}
                    onClick={() => void sendMessage()}
                  >
                    {busy ? <i className="tiny-spinner" /> : '↑'}
                  </button>
                </div>
              </div>
              {settings?.model ? (
                <div className="composer-caption">
                  {settings.model} <span>·</span> Responses stream as they arrive
                </div>
              ) : (
                <button className="composer-caption setup-caption" onClick={() => setSettingsOpen(true)}>
                  Choose a model in Settings to start a conversation →
                </button>
              )}
            </div>
          </>
        )}
      </main>

      {settingsOpen ? (
        <Modal title="Model connection" onClose={() => setSettingsOpen(false)}>
          <form className="form-stack" onSubmit={(event) => void saveModelSettings(event)}>
            <p className="form-intro">Connect any OpenAI-compatible provider. Settings stay in this Pico Runtime.</p>
            <label>
              API base URL
              <input
                value={modelForm.baseUrl}
                onChange={(event) => setModelForm((form) => ({ ...form, baseUrl: event.target.value }))}
                placeholder="https://api.openai.com/v1"
                autoComplete="url"
              />
            </label>
            <label>
              Model
              <input
                value={modelForm.model}
                onChange={(event) => setModelForm((form) => ({ ...form, model: event.target.value }))}
                placeholder="gpt-4.1-mini"
              />
            </label>
            <label>
              API key{' '}
              <span className="field-note">
                {modelForm.hasApiKey
                  ? 'A key is saved. Leave blank to keep it.'
                  : 'Stored locally in Pico’s data file.'}
              </span>
              <input
                value={modelForm.apiKey}
                onChange={(event) => setModelForm((form) => ({ ...form, apiKey: event.target.value }))}
                type="password"
                placeholder={modelForm.hasApiKey ? 'Saved · enter a new key to replace' : 'sk-…'}
                autoComplete="new-password"
              />
            </label>
            <label className="temperature-label">
              Temperature <span>{Number(modelForm.temperature).toFixed(1)}</span>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={modelForm.temperature}
                onChange={(event) => setModelForm((form) => ({ ...form, temperature: Number(event.target.value) }))}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="button button-quiet"
                onClick={() => void clearApiKey()}
                disabled={!settings?.hasApiKey}
              >
                Clear saved key
              </button>
              <button className="button button-primary" disabled={settingsSaving}>
                {settingsSaving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {newProjectOpen ? (
        <Modal title="Create a Project" onClose={() => setNewProjectOpen(false)}>
          <form className="form-stack" onSubmit={(event) => void createProject(event)}>
            <p className="form-intro">A Project groups Threads that share the same workspace and long-term context.</p>
            <label>
              Project name
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="Pico, notes, research…"
                autoFocus
              />
            </label>
            <label>
              Workspace folder
              <input
                value={newProjectPath}
                onChange={(event) => setNewProjectPath(event.target.value)}
                placeholder={defaultWorkspace || '/path/to/folder'}
              />
            </label>
            <button type="button" className="path-suggestion" onClick={() => setNewProjectPath(defaultWorkspace)}>
              <span>Use this Pico folder</span>
              <code>{defaultWorkspace}</code>
            </button>
            <div className="form-actions">
              <span className="field-note">The selected Executor receives access to this folder.</span>
              <button className="button button-primary" disabled={busy || !newProjectName.trim()}>
                {busy ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {newThreadOpen ? (
        <Modal title="Start a Thread" onClose={() => setNewThreadOpen(false)}>
          <form className="form-stack" onSubmit={(event) => void createThread(event)}>
            <p className="form-intro">Choose the execution environment now. A Thread stays bound to this Executor.</p>
            <label>
              Thread name <span className="field-note">Optional</span>
              <input
                value={newThreadTitle}
                onChange={(event) => setNewThreadTitle(event.target.value)}
                placeholder="New Thread"
              />
            </label>
            <div className="executor-choice-grid">
              <button
                type="button"
                className={`executor-choice ${newThreadExecutor === 'container' ? 'chosen' : ''}`}
                onClick={() => setNewThreadExecutor('container')}
              >
                <span className="choice-icon">▧</span>
                <strong>Container</strong>
                <small>Isolated workspace, root inside the container</small>
                <i>{newThreadExecutor === 'container' ? 'Selected' : 'Choose'}</i>
              </button>
              <button
                type="button"
                className={`executor-choice ${newThreadExecutor === 'host' ? 'chosen' : ''}`}
                onClick={() => setNewThreadExecutor('host')}
              >
                <span className="choice-icon">⌂</span>
                <strong>Host</strong>
                <small>Use tools and software already on this machine</small>
                <i>{newThreadExecutor === 'host' ? 'Selected' : 'Choose'}</i>
              </button>
            </div>
            <div className="form-actions">
              <span className="field-note">Container is the default. Host tools ask before running.</span>
              <button className="button button-primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create Thread'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {pluginInfo && pluginInfo.errors.length > 0 ? (
        <div className="plugin-warning">A plugin could not be loaded: {pluginInfo.errors.join(' · ')}</div>
      ) : null}
    </div>
  );
}

function MessageBubble({ record, onOpenThread }: { record: CanonicalRecord; onOpenThread(id: string): void }) {
  const message = recordPayload<MessagePayload>(record);
  const incoming = message.source !== 'user';
  return (
    <div className={`user-message ${incoming ? 'incoming-message' : ''}`}>
      <div className="message-body">
        <div className="message-author">
          {incoming ? (
            <>
              {message.source === 'child' ? 'Child Thread' : 'Agent'} <span>·</span>{' '}
              {message.senderLabel ?? 'another Thread'}
            </>
          ) : (
            'You'
          )}
          {incoming && message.senderThreadId ? (
            <button className="inline-link" onClick={() => onOpenThread(message.senderThreadId!)}>
              Open Thread ↗
            </button>
          ) : null}
        </div>
        <div className="user-bubble">{message.content}</div>
      </div>
      <div className="user-avatar">{incoming ? '↗' : 'Y'}</div>
    </div>
  );
}

function AssistantBubble({
  record,
  executions,
  approvals,
  records,
  threadId,
  onApproval,
}: {
  record: CanonicalRecord;
  executions: Execution[];
  approvals: PermissionRequest[];
  records: CanonicalRecord[];
  threadId: string;
  onApproval(id: string, allow: boolean, rememberForThread?: boolean): void;
}) {
  const assistant = recordPayload<AssistantPayload>(record);
  const calls = assistant.toolCalls ?? [];
  const usage = assistant.usage;
  const usageLabel =
    usage && Object.keys(usage).length > 0
      ? [
          usage.inputTokens === undefined ? null : `${usage.inputTokens.toLocaleString()} in`,
          usage.outputTokens === undefined ? null : `${usage.outputTokens.toLocaleString()} out`,
          usage.totalTokens === undefined ? null : `${usage.totalTokens.toLocaleString()} total`,
        ]
          .filter(Boolean)
          .join(' / ')
      : null;
  return (
    <div className="assistant-message">
      <div className="assistant-avatar">p</div>
      <div className="message-body">
        <div className="message-author">
          Pico {assistant.model ? <span className="model-label">· {assistant.model}</span> : null}
          {usageLabel ? <span className="usage-label">· {usageLabel} tokens</span> : null}
        </div>
        {assistant.content ? <div className="markdown-like">{assistant.content}</div> : null}
        {calls.length > 0 ? (
          <div className="tool-group">
            <div className="tool-group-label">
              <span>✳</span> {calls.length} tool {calls.length === 1 ? 'call' : 'calls'} · parallel batch
            </div>
            {calls.map((call) => {
              const executionId = `${threadId}:${record.id.replace(/:assistant$/, '')}:${call.id}`;
              const execution = executions.find((item) => item.id === executionId);
              const resultRecord = records.find(
                (item) =>
                  item.kind === 'tool_result' &&
                  (item.payload as unknown as ToolResultPayload).executionId === executionId,
              );
              const result = resultRecord ? recordPayload<ToolResultPayload>(resultRecord) : undefined;
              const approval = approvals.find((item) => item.executionId === executionId);
              return (
                <ToolCard
                  key={executionId}
                  call={call}
                  execution={execution}
                  result={result}
                  approval={approval}
                  onApproval={onApproval}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
