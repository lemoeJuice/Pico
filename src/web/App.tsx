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
  RemoteExecutorConnectionView,
  Thread,
  ToolCall,
  ToolResultPayload,
  UiContribution,
} from '../core/types.js';
import type { PermissionPolicy } from '../runtime/stages.js';
import type { ModelInputAttempt, ThreadSnapshot } from '../runtime/runtime.js';
import { isSessionExpired } from './session.js';
import { visiblePauseReason } from './pause-reason.js';
import { shouldSubmitOnEnter } from './composer-keys.js';
import { upsertProjectThread } from './project-threads.js';
import {
  fetchStableSnapshot,
  snapshotForSelection,
  snapshotThreadIsSelected,
  updateSnapshotForThread,
} from './snapshot-consistency.js';
import { isNearScrollEnd } from './scroll-follow.js';
import { threadCanBeInterrupted } from './thread-controls.js';
import {
  appendAssistantDraft,
  assistantStreamsAfterDisconnect,
  assistantDraftForThread,
  canAppendAssistantDelta,
  clearAssistantDraft,
  observeAssistantExecutions,
  type AssistantDrafts,
  type AssistantStreamExecutions,
} from './assistant-drafts.js';
import { noticeForThread, withThreadNotice, withoutThreadNotice, type ThreadNotices } from './thread-notices.js';
import { uiContributionsAt } from './ui-contributions.js';
import {
  clearAcceptedMessageDraft,
  hasPendingMessageSubmission,
  messageSubmissionId,
  messageSubmissionFailureMessage,
  messageSubmissionRequestInit,
  settleMessageSubmission,
  type PendingMessageIds,
  withPendingThreadSubmission,
} from './message-retries.js';

type PluginInfo = {
  plugins: Array<{ id: string; name: string; version: string; source: string }>;
  ui: UiContribution[];
  pipelines: Array<{ stage: string; pluginId: string; order: number }>;
  errors: string[];
};

type RuntimeEvent = Record<string, unknown> & { type: string };
type ToolPermission = { name: string; description: string; policy: PermissionPolicy };
type ThreadExecutorChoice = ExecutorKind | 'remote';

function executorLabel(thread: Thread): string {
  if (thread.executorRemote) return `Remote Host · ${thread.executorLabel.split(' · ')[1] ?? 'Executor'}`;
  return thread.executorKind === 'container' ? 'Container' : 'Host';
}

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
      <span className="executor-glyph">
        {thread.executorKind === 'container' ? '▧' : thread.executorRemote ? '⇄' : '⌂'}
      </span>
      <span>{executorLabel(thread)} Executor</span>
      {connected === null ? (
        <i className="tiny-spinner" />
      ) : (
        <i className={`connection-dot ${connected ? 'online' : 'offline'}`} />
      )}
    </span>
  );
}

function Modal({
  title,
  onClose,
  children,
  error,
  onDismissError,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  error: string;
  onDismissError(): void;
}) {
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
        {error ? (
          <div className="banner banner-error modal-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onDismissError}>
              Dismiss
            </button>
          </div>
        ) : null}
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
          {executorLabel(thread)} · {thread.state}
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
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [remoteConnections, setRemoteConnections] = useState<RemoteExecutorConnectionView[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [pluginInfo, setPluginInfo] = useState<PluginInfo | null>(null);
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [permissions, setPermissions] = useState<ToolPermission[]>([]);
  const [permissionsThreadId, setPermissionsThreadId] = useState<string | null>(null);
  const [executorConnected, setExecutorConnected] = useState<boolean | null>(null);
  const [executorError, setExecutorError] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [sendingThreadIds, setSendingThreadIds] = useState<Set<string>>(new Set());
  const [draftsByThread, setDraftsByThread] = useState<Record<string, string>>({});
  const [assistantDrafts, setAssistantDrafts] = useState<AssistantDrafts>({});
  const [unavailableModelExecutionIds, setUnavailableModelExecutionIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [threadNotices, setThreadNotices] = useState<ThreadNotices>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [remoteConnectionSaving, setRemoteConnectionSaving] = useState(false);
  const [remoteTokenEdits, setRemoteTokenEdits] = useState<Record<string, string>>({});
  const [remoteConnectionNotice, setRemoteConnectionNotice] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newThreadTitle, setNewThreadTitle] = useState('');
  const [newThreadExecutor, setNewThreadExecutor] = useState<ThreadExecutorChoice>('container');
  const [newThreadRemoteConnectionId, setNewThreadRemoteConnectionId] = useState('');
  const [newThreadRemoteWorkspacePath, setNewThreadRemoteWorkspacePath] = useState('');
  const [remoteForm, setRemoteForm] = useState({ name: '', endpointUrl: '', accessToken: '' });
  const [modelForm, setModelForm] = useState({
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: 0.2,
    hasApiKey: false,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const snapshotRequest = useRef(0);
  const projectThreadVersions = useRef(new Map<string, number>());
  const activeProjectId = useRef(projectId);
  const threadUpdateVersions = useRef(new Map<string, number>());
  const snapshotVersions = useRef(new Map<string, number>());
  const pendingMessageIds = useRef<PendingMessageIds>(new Map());
  const pendingSubmissionThreads = useRef(new Set<string>());
  const assistantDraftsRef = useRef(assistantDrafts);
  const activeModelExecutions = useRef<AssistantStreamExecutions>(new Map());
  const unavailableModelExecutions = useRef<AssistantStreamExecutions>(new Map());
  const observedModelExecutions = useRef(new Set<string>());
  const draft = threadId ? (draftsByThread[threadId] ?? '') : '';
  const draftRef = useRef({ threadId, value: draft });
  activeProjectId.current = projectId;
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;
  assistantDraftsRef.current = assistantDrafts;
  draftRef.current = { threadId, value: draft };

  const updateDraft = (value: string): void => {
    const targetThreadId = activeThreadId.current;
    if (!targetThreadId) return;
    draftRef.current = { threadId: targetThreadId, value };
    setDraftsByThread((current) => ({ ...current, [targetThreadId]: value }));
  };

  const clearAcceptedDraft = (targetThreadId: string, content: string): void => {
    if (draftRef.current.threadId === targetThreadId && draftRef.current.value.trim() === content) {
      draftRef.current = { threadId: targetThreadId, value: '' };
    }
    setDraftsByThread((current) => clearAcceptedMessageDraft(current, targetThreadId, content));
  };

  const observeModelExecutions = useCallback((executions: readonly Execution[]): void => {
    const next = observeAssistantExecutions(
      activeModelExecutions.current,
      unavailableModelExecutions.current,
      executions,
      observedModelExecutions.current,
    );
    activeModelExecutions.current = next.active;
    unavailableModelExecutions.current = next.unavailable;
    setUnavailableModelExecutionIds(new Set(next.unavailable.keys()));
  }, []);

  const settleModelExecution = useCallback((executionId: string): void => {
    activeModelExecutions.current.delete(executionId);
    observedModelExecutions.current.delete(executionId);
    if (!unavailableModelExecutions.current.delete(executionId)) return;
    setUnavailableModelExecutionIds(new Set(unavailableModelExecutions.current.keys()));
  }, []);

  const markThreadSending = (targetThreadId: string, isSending: boolean): void => {
    pendingSubmissionThreads.current = withPendingThreadSubmission(
      pendingSubmissionThreads.current,
      targetThreadId,
      isSending,
    );
    setSendingThreadIds(pendingSubmissionThreads.current);
  };

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const selectedRemoteConnection = remoteConnections.find(
    (connection) => connection.id === newThreadRemoteConnectionId,
  );
  const activeSnapshot = snapshotForSelection(snapshot, threadId, projectId);
  const selectedThread =
    activeSnapshot?.thread ??
    threads.find((thread) => thread.id === threadId && thread.projectId === projectId) ??
    null;
  const selectedThreadSending = selectedThread ? sendingThreadIds.has(selectedThread.id) : false;
  const displayedPermissions = permissionsThreadId === threadId ? permissions : [];
  const activeNotice = noticeForThread(threadId, threadNotices, notice);
  const assistantDraft = assistantDraftForThread(assistantDrafts, threadId);
  const filteredCommands = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const token = draft.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    return commands.filter((command) => command.name.startsWith(token)).slice(0, 7);
  }, [commands, draft]);
  const uiContributions = pluginInfo?.ui ?? [];
  const toolbarContributions = uiContributionsAt(uiContributions, 'thread.toolbar');
  const composerActions = uiContributionsAt(uiContributions, 'composer.action');
  const sidebarPanels = uiContributionsAt(uiContributions, 'sidebar.panel');

  const loadSnapshot = useCallback(
    async (id: string) => {
      if (!snapshotThreadIsSelected(id, activeThreadId.current)) return;
      const requestNumber = ++snapshotRequest.current;
      const value = await fetchStableSnapshot(
        () => api<ThreadSnapshot>(`/api/threads/${encodeURIComponent(id)}`),
        () => snapshotVersions.current.get(id) ?? 0,
        () => requestNumber === snapshotRequest.current && snapshotThreadIsSelected(id, activeThreadId.current),
      );
      if (value && requestNumber === snapshotRequest.current && snapshotThreadIsSelected(id, activeThreadId.current)) {
        observeModelExecutions(value.executions);
        for (const record of value.records) {
          if (
            record.kind === 'message' &&
            settleMessageSubmission(pendingMessageIds.current, id, record.id) &&
            record.payload.source === 'user' &&
            typeof record.payload.content === 'string'
          ) {
            clearAcceptedDraft(id, record.payload.content);
          }
        }
        setSnapshot(value);
      }
    },
    [observeModelExecutions],
  );

  const noteSnapshotChange = useCallback((threadId: string | null | undefined): void => {
    if (!threadId) return;
    snapshotVersions.current.set(threadId, (snapshotVersions.current.get(threadId) ?? 0) + 1);
  }, []);

  const loadProjectThreads = useCallback(async (id: string): Promise<Thread[] | null> => {
    const version = projectThreadVersions.current.get(id) ?? 0;
    projectThreadVersions.current.set(id, version + 1);
    const values = await fetchStableSnapshot(
      () => api<Thread[]>(`/api/projects/${encodeURIComponent(id)}/threads`),
      () => projectThreadVersions.current.get(id) ?? 0,
      () => activeProjectId.current === id,
    );
    if (values) setThreads(values);
    return values;
  }, []);

  const refreshSelected = useCallback(() => {
    if (projectId)
      void loadProjectThreads(projectId).catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
    if (threadId)
      void loadSnapshot(threadId).catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, [loadProjectThreads, loadSnapshot, projectId, threadId]);
  const refreshSelectedRef = useRef(refreshSelected);
  refreshSelectedRef.current = refreshSelected;

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<Project[]>('/api/projects'),
      api<PublicSettings>('/api/settings/model'),
      api<Array<{ name: string; description: string }>>('/api/commands'),
      api<PluginInfo>('/api/plugins'),
      api<{ defaultWorkspace: string }>('/api/info'),
      api<RemoteExecutorConnectionView[]>('/api/executor-connections'),
    ])
      .then(([projectList, modelSettings, commandList, pluginResult, info, connections]) => {
        if (!alive) return;
        setProjects(projectList);
        setSettings(modelSettings);
        setModelForm({ ...modelSettings, apiKey: '' });
        setCommands(commandList);
        setPluginInfo(pluginResult);
        setDefaultWorkspace(info.defaultWorkspace);
        setRemoteConnections(connections);
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
    let current = true;
    setThreads([]);
    setThreadId(null);
    setSnapshot(null);
    if (!projectId) {
      return () => {
        current = false;
      };
    }
    localStorage.setItem('pico.project', projectId);
    void loadProjectThreads(projectId)
      .then((values) => {
        if (!current || !values) return;
        const remembered = localStorage.getItem(`pico.thread.${projectId}`);
        const nextId = values.some((item) => item.id === remembered) ? remembered : (values[0]?.id ?? null);
        setThreadId(nextId);
      })
      .catch((caught: unknown) => {
        if (current) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [loadProjectThreads, projectId]);

  useEffect(() => {
    if (!threadId) {
      setSnapshot(null);
      return;
    }
    localStorage.setItem(`pico.thread.${projectId ?? 'none'}`, threadId);
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
      setPermissionsThreadId(null);
      return;
    }
    setExecutorConnected(null);
    setExecutorError(null);
    setPermissions([]);
    setPermissionsThreadId(threadId);
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
      setPermissionsThreadId(threadId);
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
        if (closed) {
          socket?.close();
          return;
        }
        retry = 750;
        observedModelExecutions.current = new Set();
        setSocketConnected(true);
        refreshSelectedRef.current();
      };
      socket.onmessage = (message) => {
        if (closed) return;
        let event: RuntimeEvent;
        try {
          event = JSON.parse(String(message.data)) as RuntimeEvent;
        } catch {
          return;
        }
        if (event.type === 'thread.created') {
          const created = event.thread as Thread | undefined;
          if (created) {
            projectThreadVersions.current.set(
              created.projectId,
              (projectThreadVersions.current.get(created.projectId) ?? 0) + 1,
            );
            noteSnapshotChange(created.id);
            noteSnapshotChange(created.parentThreadId);
            setThreads((items) => upsertProjectThread(items, created, activeProjectId.current));
            setSnapshot((current) =>
              current && created.parentThreadId === current.thread.id
                ? { ...current, children: [created, ...current.children.filter((item) => item.id !== created.id)] }
                : current,
            );
          }
        } else if (event.type === 'thread.updated') {
          const updated = event.thread as Thread | undefined;
          if (updated) {
            projectThreadVersions.current.set(
              updated.projectId,
              (projectThreadVersions.current.get(updated.projectId) ?? 0) + 1,
            );
            threadUpdateVersions.current.set(updated.id, (threadUpdateVersions.current.get(updated.id) ?? 0) + 1);
            noteSnapshotChange(updated.id);
            noteSnapshotChange(updated.parentThreadId);
            setThreads((items) => upsertProjectThread(items, updated, activeProjectId.current));
            setSnapshot((current) => (current?.thread.id === updated.id ? { ...current, thread: updated } : current));
          }
        } else if (event.type === 'record') {
          const record = event.record as CanonicalRecord | undefined;
          if (record?.kind === 'message' && record.threadId) {
            if (
              settleMessageSubmission(pendingMessageIds.current, record.threadId, record.id) &&
              record.payload.source === 'user' &&
              typeof record.payload.content === 'string'
            ) {
              clearAcceptedDraft(record.threadId, record.payload.content);
            }
          }
          if (record?.threadId === activeThreadId.current) {
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
          }
          const recordThreadId = record?.threadId;
          if (recordThreadId && record?.kind === 'assistant' && record.id.endsWith(':assistant')) {
            const executionId = record.id.slice(0, -':assistant'.length);
            settleModelExecution(executionId);
            setAssistantDrafts((current) => clearAssistantDraft(current, recordThreadId, executionId));
          }
        } else if (event.type === 'execution.updated') {
          const execution = event.execution as Execution | undefined;
          if (execution?.kind === 'model') {
            if (execution.status === 'pending' || execution.status === 'running') {
              observedModelExecutions.current.add(execution.id);
            } else {
              observedModelExecutions.current.delete(execution.id);
            }
            observeModelExecutions([execution]);
          }
          if (execution?.threadId === activeThreadId.current) {
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
          if (approval?.threadId === activeThreadId.current) {
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
        } else if (
          event.type === 'model.delta' &&
          typeof event.threadId === 'string' &&
          typeof event.executionId === 'string' &&
          typeof event.delta === 'string'
        ) {
          const draftThreadId = event.threadId;
          const executionId = event.executionId;
          const delta = event.delta;
          if (
            !canAppendAssistantDelta(
              activeModelExecutions.current,
              unavailableModelExecutions.current,
              draftThreadId,
              executionId,
            )
          ) {
            return;
          }
          setAssistantDrafts((current) => appendAssistantDraft(current, draftThreadId, executionId, delta));
        } else if (
          event.type === 'model.draft-ended' &&
          typeof event.threadId === 'string' &&
          typeof event.executionId === 'string'
        ) {
          const draftThreadId = event.threadId;
          const executionId = event.executionId;
          settleModelExecution(executionId);
          setAssistantDrafts((current) => clearAssistantDraft(current, draftThreadId, executionId));
        } else if (event.type === 'runtime.error') {
          const failedThreadId = typeof event.threadId === 'string' ? event.threadId : null;
          if (failedThreadId) {
            setAssistantDrafts((current) => clearAssistantDraft(current, failedThreadId));
          }
          if (failedThreadId === activeThreadId.current) {
            setError(String(event.message ?? 'Runtime error'));
          }
        } else if (event.type === 'runtime.notice' && typeof event.threadId === 'string') {
          setThreadNotices((current) =>
            withThreadNotice(current, event.threadId as string, String(event.message ?? 'Runtime notice')),
          );
        } else if (
          event.type === 'permissions.updated' &&
          typeof event.threadId === 'string' &&
          event.threadId === activeThreadId.current
        ) {
          setPermissions(event.permissions as ToolPermission[]);
          setPermissionsThreadId(event.threadId);
        } else if (event.type === 'settings.updated') {
          const value = event.settings as PublicSettings;
          setSettings(value);
          setModelForm((current) => ({ ...current, ...value }));
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setSocketConnected(false);
        void isSessionExpired().then((expired) => {
          if (expired) window.dispatchEvent(new Event('pico:auth-expired'));
        });
        if (!closed) {
          // WebSocket deltas are transient and cannot be replayed after reconnect.
          const unavailable = assistantStreamsAfterDisconnect(
            activeModelExecutions.current,
            assistantDraftsRef.current,
            unavailableModelExecutions.current,
          );
          unavailableModelExecutions.current = unavailable;
          setUnavailableModelExecutionIds(new Set(unavailable.keys()));
          setAssistantDrafts({});
          timer = window.setTimeout(connect, retry);
          retry = Math.min(retry * 1.7, 12_000);
        }
      };
      socket.onerror = () => {
        if (!closed) socket?.close();
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [noteSnapshotChange, observeModelExecutions, settleModelExecution]);

  useEffect(() => {
    followLatest.current = true;
  }, [threadId]);

  useEffect(() => {
    const list = listRef.current;
    if (list && followLatest.current) list.scrollTop = list.scrollHeight;
  }, [threadId, activeSnapshot?.records.length, activeSnapshot?.executions.length, assistantDraft]);

  const sendMessage = async (content = draft): Promise<void> => {
    const clean = content.trim();
    const sentThreadId = threadId;
    if (!sentThreadId || !clean || busy || pendingSubmissionThreads.current.has(sentThreadId)) return;
    followLatest.current = true;
    markThreadSending(sentThreadId, true);
    setError('');
    const id = messageSubmissionId(pendingMessageIds.current, sentThreadId, clean, () => crypto.randomUUID());
    try {
      const result = await api<{
        accepted: boolean;
        duplicate?: boolean;
        command?: { text?: string; openThreadId?: string };
      }>(`/api/threads/${sentThreadId}/messages`, messageSubmissionRequestInit(id, clean));
      settleMessageSubmission(pendingMessageIds.current, sentThreadId, id);
      clearAcceptedDraft(sentThreadId, clean);
      const commandText = result.command?.text;
      if (commandText) setThreadNotices((current) => withThreadNotice(current, sentThreadId, commandText));
      if (activeThreadId.current === sentThreadId) {
        if (result.command?.openThreadId) setThreadId(result.command.openThreadId);
      }
      void loadSnapshot(sentThreadId);
    } catch (caught) {
      if (
        activeThreadId.current === sentThreadId &&
        hasPendingMessageSubmission(pendingMessageIds.current, sentThreadId, id)
      ) {
        setError(messageSubmissionFailureMessage(caught));
      }
    } finally {
      markThreadSending(sentThreadId, false);
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
      setSnapshot(null);
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
        body: JSON.stringify({
          title: newThreadTitle,
          executorKind: newThreadExecutor === 'remote' ? 'host' : newThreadExecutor,
          ...(newThreadExecutor === 'remote'
            ? {
                remoteConnectionId: newThreadRemoteConnectionId,
                remoteWorkspacePath: newThreadRemoteWorkspacePath,
              }
            : {}),
        }),
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

  const startAlternateExecutorThread = (): void => {
    if (!selectedThread) return;
    setNewThreadTitle('');
    setNewThreadExecutor(selectedThread.executorKind === 'container' ? 'host' : 'container');
    setNewThreadRemoteConnectionId('');
    setNewThreadRemoteWorkspacePath('');
    setNewThreadOpen(true);
  };

  const addRemoteExecutorConnection = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setRemoteConnectionSaving(true);
    setError('');
    try {
      const connection = await api<RemoteExecutorConnectionView>('/api/executor-connections', {
        method: 'POST',
        body: JSON.stringify(remoteForm),
      });
      setRemoteConnections((items) => [connection, ...items]);
      setRemoteForm({ name: '', endpointUrl: '', accessToken: '' });
      setRemoteConnectionNotice(`Connected to ${connection.name}.`);
      setNotice(`Connected to ${connection.name}. Choose it when starting a new Thread.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoteConnectionSaving(false);
    }
  };

  const updateRemoteExecutorToken = async (event: FormEvent, connectionId: string): Promise<void> => {
    event.preventDefault();
    const connection = remoteConnections.find((item) => item.id === connectionId);
    const accessToken = remoteTokenEdits[connectionId]?.trim();
    if (!connection || !accessToken) return;
    setRemoteConnectionSaving(true);
    setError('');
    setRemoteConnectionNotice('');
    try {
      const updated = await api<RemoteExecutorConnectionView>(`/api/executor-connections/${connectionId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: connection.name,
          endpointUrl: connection.endpointUrl,
          accessToken,
        }),
      });
      setRemoteConnections((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setRemoteTokenEdits((items) => ({ ...items, [connectionId]: '' }));
      setRemoteConnectionNotice(`Connection verified. The access token for ${updated.name} was replaced.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRemoteConnectionSaving(false);
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
    const targetThreadId = threadId;
    if (!targetThreadId) return;
    try {
      const approval = await api<PermissionRequest>(`/api/approvals/${executionId}`, {
        method: 'POST',
        body: JSON.stringify({ allow, ...(rememberForThread ? { rememberForThread: true } : {}) }),
      });
      setSnapshot((current) =>
        updateSnapshotForThread(current, targetThreadId, (snapshot) => ({
          ...snapshot,
          approvals: [approval, ...snapshot.approvals.filter((item) => item.executionId !== executionId)],
        })),
      );
    } catch (caught) {
      if (snapshotThreadIsSelected(targetThreadId, activeThreadId.current)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };

  const updatePermission = async (toolName: string, policy: PermissionPolicy): Promise<void> => {
    const targetThreadId = threadId;
    if (!targetThreadId) return;
    try {
      const next = await api<ToolPermission[]>(
        `/api/threads/${targetThreadId}/permissions/${encodeURIComponent(toolName)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ policy }),
        },
      );
      if (!snapshotThreadIsSelected(targetThreadId, activeThreadId.current)) return;
      setPermissions(next);
      setPermissionsThreadId(targetThreadId);
    } catch (caught) {
      if (snapshotThreadIsSelected(targetThreadId, activeThreadId.current)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
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
    if (id !== threadId) {
      setThreadId(id);
      setSnapshot(null);
    }
    localStorage.setItem(`pico.thread.${projectId ?? 'none'}`, id);
    setMobileSidebarOpen(false);
    setNotice('');
    setError('');
  };

  const dismissNotice = (): void => {
    if (notice) {
      setNotice('');
      return;
    }
    if (threadId) setThreadNotices((current) => withoutThreadNotice(current, threadId));
  };

  const records = activeSnapshot?.records ?? [];
  const executions = activeSnapshot?.executions ?? [];
  const approvals = activeSnapshot?.approvals ?? [];
  const committedModelExecutionIds = new Set(
    records.filter((record) => record.kind === 'assistant').map((record) => record.id.replace(/:assistant$/, '')),
  );
  const uncommittedModelExecutions = executions.filter(
    (execution) =>
      execution.kind === 'model' && execution.status !== 'completed' && !committedModelExecutionIds.has(execution.id),
  );
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
  const timeline = [
    ...renderedRecords.map((record) => ({ type: 'record' as const, at: record.createdAt, record })),
    ...uncommittedModelExecutions.map((execution) => ({
      type: 'model-execution' as const,
      at: execution.updatedAt,
      execution,
    })),
  ].sort(
    (left, right) =>
      left.at.localeCompare(right.at) || Number(left.type !== 'record') - Number(right.type !== 'record'),
  );
  const currentState = selectedThread?.state ?? 'idle';
  const pauseReason = visiblePauseReason(currentState, selectedThread?.pauseReason ?? null, [error, activeNotice]);

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
              onChange={(event) => {
                setProjectId(event.target.value || null);
                setThreads([]);
                setThreadId(null);
                setSnapshot(null);
              }}
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
          {sidebarPanels.length > 0 ? (
            <section className="plugin-sidebar-panels" aria-label="Plugin panels">
              <span className="eyebrow">PLUGIN PANELS</span>
              {sidebarPanels.map((item) => (
                <div className="plugin-sidebar-panel" key={item.id}>
                  <div className="plugin-sidebar-copy">
                    <strong>{item.label}</strong>
                    {item.description ? <p>{item.description}</p> : null}
                  </div>
                  {item.command ? (
                    <button
                      className="plugin-sidebar-action"
                      disabled={!threadId || busy || selectedThreadSending}
                      title={item.description ?? item.label}
                      onClick={() => {
                        executeContribution(item);
                        setMobileSidebarOpen(false);
                      }}
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </div>
        <div className="sidebar-bottom">
          <button className="settings-link" onClick={() => setSettingsOpen(true)}>
            <span className="settings-icon">⚙</span>
            <span>Settings</span>
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
            <div className="executor-error-copy">
              <strong>{executorLabel(selectedThread)} Executor unavailable.</strong>{' '}
              <span>
                Continue in a new {selectedThread.executorKind === 'container' ? 'Host' : 'Container'} Thread in this
                Project.
              </span>
            </div>
            <div className="executor-error-actions">
              <button type="button" onClick={startAlternateExecutorThread}>
                New {selectedThread.executorKind === 'container' ? 'Host' : 'Container'} Thread
              </button>
              <details className="executor-error-details">
                <summary>Diagnostics</summary>
                <pre>{executorError}</pre>
              </details>
            </div>
          </div>
        ) : null}
        {pauseReason ? (
          <div className="banner banner-notice pause-reason" role="status">
            <span>{pauseReason}</span>
          </div>
        ) : null}
        {error ? (
          <div className="banner banner-error">
            <span>{error}</span>
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        ) : null}
        {activeNotice ? (
          <div className="banner banner-notice">
            <span>{activeNotice}</span>
            <button onClick={dismissNotice}>Dismiss</button>
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
                {toolbarContributions.map((item) => (
                  <button
                    key={item.id}
                    className="button button-quiet plugin-action"
                    disabled={!item.command || busy || selectedThreadSending}
                    title={item.description}
                    onClick={() => executeContribution(item)}
                  >
                    {item.label}
                  </button>
                ))}
                <details className="permission-menu">
                  <summary className="button button-quiet">
                    Tools <span className="permission-count">{displayedPermissions.length}</span>
                  </summary>
                  <div className="permission-popover">
                    <div className="popover-heading">
                      <strong>Tool permissions</strong>
                      <span>Saved for this Thread</span>
                    </div>
                    {displayedPermissions.map((permission) => (
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
                {threadCanBeInterrupted(currentState, executions) ? (
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

            <div
              className="conversation-scroll"
              ref={listRef}
              onScroll={(event) => {
                followLatest.current = isNearScrollEnd(event.currentTarget);
              }}
            >
              <div className="timeline">
                {timeline.map((item) =>
                  item.type === 'model-execution' ? (
                    <ModelExecutionNotice
                      key={item.execution.id}
                      execution={item.execution}
                      threadId={selectedThread.id}
                      outputUnavailable={unavailableModelExecutionIds.has(item.execution.id)}
                    />
                  ) : item.record.kind === 'message' ? (
                    <MessageBubble key={item.record.id} record={item.record} onOpenThread={chooseThread} />
                  ) : (
                    <AssistantBubble
                      key={item.record.id}
                      record={item.record}
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
                      Send a message to begin. This Thread will stay bound to its {executorLabel(selectedThread)}{' '}
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
                    <button key={command.name} onClick={() => updateDraft(`/${command.name} `)}>
                      <strong>/{command.name}</strong>
                      <span>{command.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="composer-box">
                <textarea
                  value={draft}
                  onChange={(event) => updateDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (shouldSubmitOnEnter(event.nativeEvent)) {
                      event.preventDefault();
                      if (filteredCommands.length > 0 && draft.trim() === '/')
                        updateDraft(`/${filteredCommands[0]!.name} `);
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
                  <div className="composer-footer-actions">
                    {composerActions.map((item) => (
                      <button
                        key={item.id}
                        className="composer-plugin-action"
                        disabled={!item.command || busy || selectedThreadSending}
                        title={item.description ?? item.label}
                        onClick={() => executeContribution(item)}
                      >
                        {item.label}
                      </button>
                    ))}
                    <button
                      className="send-button"
                      aria-label="Send message"
                      disabled={!draft.trim() || busy || selectedThreadSending}
                      onClick={() => void sendMessage()}
                    >
                      {selectedThreadSending ? <i className="tiny-spinner" /> : '↑'}
                    </button>
                  </div>
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
        <Modal
          title="Model and Executor connections"
          onClose={() => setSettingsOpen(false)}
          error={error}
          onDismissError={() => setError('')}
        >
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
          <section className="form-stack remote-connections-section">
            <div>
              <p className="eyebrow">REMOTE HOST EXECUTORS</p>
              <p className="form-intro">
                Start a Pico Executor on the machine that owns the workspace, then connect it here. Tokens stay in
                Pico’s local data file and are never returned by the API.
              </p>
            </div>
            {remoteConnectionNotice ? (
              <p className="remote-connection-notice" role="status">
                {remoteConnectionNotice}
              </p>
            ) : null}
            {remoteConnections.map((connection) => (
              <div className="remote-connection-item" key={connection.id}>
                <strong>{connection.name}</strong>
                <span>{connection.endpointUrl}</span>
                <code>{connection.workspaceRoot}</code>
                <form
                  className="remote-token-form"
                  onSubmit={(event) => void updateRemoteExecutorToken(event, connection.id)}
                >
                  <label>
                    Replace access token
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="New access token"
                      value={remoteTokenEdits[connection.id] ?? ''}
                      onChange={(event) => {
                        setRemoteTokenEdits((items) => ({ ...items, [connection.id]: event.target.value }));
                        setRemoteConnectionNotice('');
                      }}
                    />
                  </label>
                  <button
                    className="button button-soft"
                    disabled={remoteConnectionSaving || !remoteTokenEdits[connection.id]?.trim()}
                  >
                    {remoteConnectionSaving ? 'Checking…' : 'Replace token'}
                  </button>
                  <p className="field-note">
                    Pico checks the token before saving it. Existing Threads keep this Executor binding.
                  </p>
                </form>
              </div>
            ))}
            <form className="form-stack" onSubmit={(event) => void addRemoteExecutorConnection(event)}>
              <label>
                Connection name
                <input
                  value={remoteForm.name}
                  onChange={(event) => setRemoteForm((form) => ({ ...form, name: event.target.value }))}
                  placeholder="Build machine"
                />
              </label>
              <label>
                Executor URL
                <input
                  value={remoteForm.endpointUrl}
                  onChange={(event) => setRemoteForm((form) => ({ ...form, endpointUrl: event.target.value }))}
                  placeholder="https://build.example.test:4174"
                  autoComplete="url"
                />
              </label>
              <label>
                Access token <span className="field-note">Generated on the Executor machine</span>
                <input
                  value={remoteForm.accessToken}
                  onChange={(event) => setRemoteForm((form) => ({ ...form, accessToken: event.target.value }))}
                  type="password"
                  autoComplete="new-password"
                />
              </label>
              <div className="form-actions">
                <span className="field-note">Remote workspaces are limited to the Executor’s configured root.</span>
                <button className="button button-primary" disabled={remoteConnectionSaving}>
                  {remoteConnectionSaving ? 'Connecting…' : 'Connect Executor'}
                </button>
              </div>
            </form>
          </section>
        </Modal>
      ) : null}

      {newProjectOpen ? (
        <Modal
          title="Create a Project"
          onClose={() => setNewProjectOpen(false)}
          error={error}
          onDismissError={() => setError('')}
        >
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
        <Modal
          title="Start a Thread"
          onClose={() => setNewThreadOpen(false)}
          error={error}
          onDismissError={() => setError('')}
        >
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
              <button
                type="button"
                className={`executor-choice ${newThreadExecutor === 'remote' ? 'chosen' : ''}`}
                onClick={() => {
                  setNewThreadExecutor('remote');
                  const connection =
                    remoteConnections.find((item) => item.id === newThreadRemoteConnectionId) ?? remoteConnections[0];
                  if (connection) {
                    setNewThreadRemoteConnectionId(connection.id);
                    setNewThreadRemoteWorkspacePath(connection.workspaceRoot);
                  }
                }}
                disabled={remoteConnections.length === 0}
              >
                <span className="choice-icon">⇄</span>
                <strong>Remote Host</strong>
                <small>Run tools on a connected machine</small>
                <i>{newThreadExecutor === 'remote' ? 'Selected' : 'Choose'}</i>
              </button>
            </div>
            {newThreadExecutor === 'remote' ? (
              remoteConnections.length > 0 ? (
                <>
                  <label>
                    Remote Executor
                    <select
                      value={newThreadRemoteConnectionId}
                      onChange={(event) => {
                        const connection = remoteConnections.find((item) => item.id === event.target.value);
                        setNewThreadRemoteConnectionId(event.target.value);
                        setNewThreadRemoteWorkspacePath(connection?.workspaceRoot ?? '');
                      }}
                    >
                      {remoteConnections.map((connection) => (
                        <option value={connection.id} key={connection.id}>
                          {connection.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Workspace on Remote Executor
                    <input
                      value={newThreadRemoteWorkspacePath}
                      onChange={(event) => setNewThreadRemoteWorkspacePath(event.target.value)}
                      placeholder={selectedRemoteConnection?.workspaceRoot ?? '/workspace/project'}
                    />
                  </label>
                </>
              ) : (
                <p className="form-intro">Add a Remote Host in Settings before creating a Thread.</p>
              )
            ) : null}
            <div className="form-actions">
              <span className="field-note">
                {newThreadExecutor === 'container'
                  ? 'Container is the default and runs tools inside the selected workspace.'
                  : 'Host Executor tools ask before running.'}
              </span>
              <button
                className="button button-primary"
                disabled={
                  busy ||
                  (newThreadExecutor === 'remote' &&
                    (!newThreadRemoteConnectionId || !newThreadRemoteWorkspacePath.trim()))
                }
              >
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

function ModelInputDisclosure({ threadId, executionId }: { threadId: string; executionId: string }) {
  const [modelInputs, setModelInputs] = useState<ModelInputAttempt[] | null>(null);
  const [modelInputsLoading, setModelInputsLoading] = useState(false);
  const [modelInputsError, setModelInputsError] = useState('');
  return (
    <details
      className="projection-card"
      onToggle={(event) => {
        if (!event.currentTarget.open || modelInputs !== null || modelInputsLoading) return;
        setModelInputsLoading(true);
        setModelInputsError('');
        void api<{ attempts: ModelInputAttempt[] }>(
          `/api/threads/${encodeURIComponent(threadId)}/executions/${encodeURIComponent(executionId)}/model-input`,
        )
          .then((result) => setModelInputs(result.attempts))
          .catch((caught: unknown) => setModelInputsError(caught instanceof Error ? caught.message : String(caught)))
          .finally(() => setModelInputsLoading(false));
      }}
    >
      <summary>Model input</summary>
      <p className="projection-note">The exact prompt passed to the model adapter. API credentials are not included.</p>
      {modelInputsLoading ? <p className="projection-state">Loading model input…</p> : null}
      {modelInputsError ? <p className="projection-error">{modelInputsError}</p> : null}
      {modelInputs?.length === 0 ? (
        <p className="projection-state">The model pipeline completed this step without calling the adapter.</p>
      ) : null}
      {modelInputs?.map((attempt, index) => (
        <details className="projection-attempt" key={attempt.id}>
          <summary>
            Attempt {index + 1} · {attempt.status}
          </summary>
          {attempt.error ? <p className="projection-error">{attempt.error}</p> : null}
          <pre className="projection-view">{toJson(attempt.prompt)}</pre>
        </details>
      ))}
    </details>
  );
}

function ModelExecutionNotice({
  execution,
  threadId,
  outputUnavailable = false,
}: {
  execution: Execution;
  threadId: string;
  outputUnavailable?: boolean;
}) {
  return (
    <div className="assistant-message model-execution-notice">
      <div className="assistant-avatar">p</div>
      <div className="message-body">
        <div className="message-author">
          Model step <span className={`tool-status status-${execution.status}`}>{execution.status}</span>
          <span className="subtle-inline">· {new Date(execution.updatedAt).toLocaleTimeString()}</span>
        </div>
        {execution.error ? (
          <details className="model-execution-error">
            <summary>Failure details</summary>
            <p>{execution.error}</p>
          </details>
        ) : outputUnavailable ? (
          <p className="projection-state">
            The connection dropped during this Model Step. Partial text is unavailable; the final reply will appear when
            the step commits.
          </p>
        ) : (
          <p className="projection-state">This Model Step has not committed an assistant message.</p>
        )}
        <ModelInputDisclosure threadId={threadId} executionId={execution.id} />
      </div>
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
  const executionId = record.id.replace(/:assistant$/, '');
  const completionNote = assistant.finishReason === 'length' ? '· output limit reached' : null;
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
          {completionNote ? <span className="completion-label">{completionNote}</span> : null}
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
        <ModelInputDisclosure threadId={threadId} executionId={executionId} />
      </div>
    </div>
  );
}
