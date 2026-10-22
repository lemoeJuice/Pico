import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  AssistantPayload,
  CanonicalRecord,
  ContextManagementSettings,
  Execution,
  ExecutorKind,
  MessagePayload,
  ModelProviderContribution,
  ModelSettings,
  Project,
  PublicSettings,
  RemoteExecutorConnectionView,
  Thread,
  ThreadModelSelection,
  ToolCall,
  ToolResultPayload,
  UiContribution,
} from '../core/types.js';
import type { ModelInputAttempt, ThreadSnapshot, ThreadToolView } from '../contracts/runtime.js';
import { isSessionExpired } from './session.js';
import { visiblePauseReason } from './pause-reason.js';
import { shouldSubmitOnEnter } from './composer-keys.js';
import { upsertProjectThread } from './project-threads.js';
import { fetchStableSnapshot, snapshotForSelection, snapshotThreadIsSelected } from './snapshot-consistency.js';
import { isNearScrollEnd } from './scroll-follow.js';
import { threadCanBeInterrupted } from './thread-controls.js';
import { executorStatusFromProbe } from './executor-status.js';
import {
  assistantStreamsAfterDisconnect,
  canAppendAssistantDelta,
  observeAssistantExecutions,
  type AssistantStreamExecutions,
} from './assistant-drafts.js';
import { assistantDraftStore } from './assistant-drafts-store.js';
import { noticeForThread, withThreadNotice, withoutThreadNotice, type ThreadNotices } from './thread-notices.js';
import { pluginUiContributionKey, toolResultForCall, uiContributionsAt } from './ui-contributions.js';
import {
  PLUGIN_COMPOSER_CONTROL_HEIGHT_PX,
  type PluginUiContext,
  type PluginUiEvent,
  type PluginUiProps,
} from '../plugins/ui-protocol.js';
import { ToolCard } from './tool-card.js';
import { reasoningSummaryMarkdown } from './reasoning-summary.js';
import { Markdown } from './markdown.js';
import {
  modelExecutionGroups,
  selectedAttemptIndex,
  modelExecutionCanRetry,
  modelExecutionProjectionThrough,
  assistantRecordHasVisibleResult,
  type ModelExecutionGroup,
  type ModelExecutionVariant,
} from './model-execution-groups.js';
import { conversationTimeline } from './conversation-timeline.js';
import { PluginWebView } from './plugin-web-view.js';
import { PluginUiSelect } from './plugin-ui-tree.js';
import { DeveloperSettings } from './developer-settings.js';
import { appendSnapshotRecord, mergeEarlierSnapshot, mergeLatestSnapshot } from './history-pages.js';
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  Box,
  ChevronLeft,
  ChevronRight,
  Cloud,
  GitBranch,
  Folder,
  FolderOpen,
  Info,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  COMPOSER_STATE_STORAGE_KEY,
  acceptComposerMessage,
  createRequestUuid,
  hasPendingMessageSubmission,
  messageSubmissionId,
  messageSubmissionFailureMessage,
  messageSubmissionRequestInit,
  parseComposerState,
  serializeComposerState,
  type ComposerState,
  type PendingMessageIds,
  withPendingThreadSubmission,
} from './message-retries.js';

type PluginInfo = {
  plugins: Array<{ id: string; name: string; version: string; source: string }>;
  catalog: Array<{
    id: string;
    name: string;
    version: string;
    source: string;
    enabled: boolean;
    loaded: boolean;
    hotReloadable: boolean;
    required: boolean;
    error?: string;
  }>;
  ui: UiContribution[];
  pages: Array<{
    id: string;
    label: string;
    description?: string;
    entry: string;
    pluginId: string;
    group?: string;
    externalAuthOrigins?: string[];
  }>;
  providers: ModelProviderContribution[];
  pipelines: Array<{ stage: string; pluginId: string; order: number }>;
  errors: string[];
};
type PluginHostUiProps = Omit<PluginUiProps, 'executeCommand'>;

type RuntimeEvent = Record<string, unknown> & { type: string };
type ThreadExecutorChoice = ExecutorKind | 'remote';
type ExecutorStatusDetails = {
  updateAvailable?: boolean;
  compatible?: boolean;
  executorVersion?: string | null;
  targetVersion?: string | null;
  updateSupported?: boolean;
};
type ThinkingDisclosureContextValue = {
  expanded: boolean;
  toggle(expanded: boolean, summary: HTMLElement): void;
};

const ThinkingDisclosureContext = createContext<ThinkingDisclosureContextValue | null>(null);

function readComposerState(): ComposerState {
  try {
    return parseComposerState(
      typeof window === 'undefined' ? null : window.localStorage.getItem(COMPOSER_STATE_STORAGE_KEY),
    );
  } catch {
    return parseComposerState(null);
  }
}

function workspaceDirectoryName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';
}

function persistComposerState(state: ComposerState): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COMPOSER_STATE_STORAGE_KEY, serializeComposerState(state));
    }
  } catch {
    // Keep in-memory sending and drafting available when browser storage is disabled or full.
  }
}

function executorLabel(thread: Thread): string {
  if (thread.executorRemote) return 'Remote';
  if (thread.executorKind === 'runtime') return 'Chat';
  return thread.executorKind === 'container' ? 'Container' : 'Local';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
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
    throw new HttpError(response.status, message);
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

function modelExecutionModelId(execution: Execution): string | null {
  const argumentModel = execution.arguments?.model;
  if (typeof argumentModel === 'string' && argumentModel.trim()) return argumentModel;
  if (execution.result && typeof execution.result === 'object' && !Array.isArray(execution.result)) {
    const resultModel = (execution.result as Record<string, unknown>).model;
    if (typeof resultModel === 'string' && resultModel.trim()) return resultModel;
  }
  return null;
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
  const ExecutorIcon = thread.executorRemote
    ? Cloud
    : thread.executorKind === 'runtime'
      ? MessageSquare
      : thread.executorKind === 'container'
        ? Box
        : Monitor;
  const accessibleStatus =
    connected === null ? (error ? 'status unknown' : 'checking connection') : connected ? 'connected' : 'disconnected';
  return (
    <span
      className={`executor-pill ${connected === false ? 'executor-offline' : ''}`}
      title={error ?? undefined}
      aria-label={`${executorLabel(thread)} ${accessibleStatus}${error ? `: ${error}` : ''}`}
    >
      <ExecutorIcon className="executor-glyph" size={14} aria-hidden="true" />
      <span>{executorLabel(thread)}</span>
      {connected === null ? (
        error ? (
          <i className="connection-dot offline" aria-hidden="true" />
        ) : (
          <i className="tiny-spinner" aria-hidden="true" />
        )
      ) : (
        <i className={`connection-dot ${connected ? 'online' : 'offline'}`} aria-hidden="true" />
      )}
    </span>
  );
}

function ThreadStateControl({
  state,
  canInterrupt,
  onAction,
}: {
  state: Thread['state'];
  canInterrupt: boolean;
  onAction(action: 'pause' | 'continue' | 'interrupt'): void;
}) {
  const control =
    state === 'running'
      ? { label: 'Pause', accessible: 'Thread working. Pause after the active execution settles.', icon: Pause }
      : state === 'pausing'
        ? { label: 'Pausing', accessible: 'Thread is pausing after the active execution settles.', icon: LoaderCircle }
        : state === 'paused'
          ? { label: 'Continue', accessible: 'Thread is paused. Continue this Thread.', icon: Play }
          : { label: 'Idle', accessible: 'Thread is idle.', icon: null };
  const ControlIcon = control.icon;
  return (
    <>
      <button
        type="button"
        className={`composer-state-control state-${state}`}
        aria-label={control.accessible}
        title={control.accessible}
        disabled={state === 'idle' || state === 'pausing'}
        onClick={() => onAction(state === 'running' ? 'pause' : 'continue')}
      >
        {ControlIcon ? (
          <ControlIcon className={state === 'pausing' ? 'state-spinner' : undefined} size={14} aria-hidden="true" />
        ) : (
          <i className="state-dot" aria-hidden="true" />
        )}
        <span>{control.label}</span>
      </button>
      {canInterrupt ? (
        <button
          type="button"
          className="interrupt-icon-button"
          aria-label="Interrupt active execution"
          title="Interrupt active execution"
          onClick={() => onAction('interrupt')}
        >
          <Square size={13} aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

function Modal({
  title,
  contextLabel = 'PICO · SETTINGS',
  onClose,
  children,
  error,
  onDismissError,
}: {
  title: string;
  contextLabel?: string;
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
            <p className="eyebrow">{contextLabel}</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={17} aria-hidden="true" />
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
      <span className="thread-item-icon" aria-hidden="true">
        {child ? <GitBranch size={14} /> : <MessageSquare size={14} />}
      </span>
      <span className="thread-item-copy">
        <span className="thread-item-title">{thread.title}</span>
        <span className="thread-item-meta">{executorLabel(thread)}</span>
      </span>
      <span
        className={`thread-state-dot state-${thread.state}`}
        role="img"
        aria-label={thread.state}
        title={thread.state}
      />
    </button>
  );
}

function PluginContributionView({
  item,
  pluginProps,
  events,
  isRegisteredPage,
  runCommand,
  onActivate,
  disabled,
  buttonClassName,
}: {
  item: UiContribution;
  pluginProps: PluginHostUiProps | null;
  events: Array<{ sequence: number; event: PluginUiEvent }>;
  isRegisteredPage(pluginId: string, pageId: string): boolean;
  runCommand(pluginId: string, threadId: string | null, command: string): Promise<unknown>;
  onActivate(item: UiContribution): void;
  disabled: boolean;
  buttonClassName: string;
}) {
  if (pluginProps && item.pluginId && item.entry && item.component) {
    return (
      <PluginWebView
        key={pluginUiContributionKey(item)}
        pluginId={item.pluginId}
        entry={item.entry}
        viewType="component"
        viewId={item.component}
        uiSlot={item.slot}
        controlLabel={item.label}
        controlClassName={buttonClassName}
        supportsPopover={item.supportsPopover}
        externalAuthOrigins={item.externalAuthOrigins}
        events={events}
        {...pluginProps}
        isRegisteredPage={isRegisteredPage}
        runCommand={runCommand}
      />
    );
  }
  return (
    <button
      className={buttonClassName}
      disabled={disabled || !item.command}
      title={item.description}
      onClick={() => onActivate(item)}
    >
      {item.label}
    </button>
  );
}

function formatTokenCount(tokens: number): string {
  return tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`;
}

export function App({ authRequired = false, onSignOut }: { authRequired?: boolean; onSignOut?(): Promise<void> }) {
  const composerState = useRef<ComposerState | null>(null);
  if (composerState.current === null) composerState.current = readComposerState();
  const [projects, setProjects] = useState<Project[]>([]);
  const [threadsByProject, setThreadsByProject] = useState<Record<string, Thread[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [contextManagement, setContextManagement] = useState<ContextManagementSettings | null>(null);
  const [contextManagementForm, setContextManagementForm] = useState({
    contextWindowTokens: '272000',
    compactionThresholdTokens: '256000',
    keepRecentTokens: '16000',
  });
  const [remoteConnections, setRemoteConnections] = useState<RemoteExecutorConnectionView[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginPageSelection, setPluginPageSelection] = useState<{ pluginId: string; pageId: string } | null>(null);
  const [contextManagerOpen, setContextManagerOpen] = useState(false);
  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [archivedThreadsOpen, setArchivedThreadsOpen] = useState(false);
  const [developerMenuOpen, setDeveloperMenuOpen] = useState(false);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [archivedThreadsLoading, setArchivedThreadsLoading] = useState(false);
  const [archivedThreadActionId, setArchivedThreadActionId] = useState<string | null>(null);
  const [pluginActionId, setPluginActionId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [threadInfoOpen, setThreadInfoOpen] = useState(false);
  const [threadTitleDraft, setThreadTitleDraft] = useState('');
  const [threadTitleSaving, setThreadTitleSaving] = useState(false);
  const [threadInfoError, setThreadInfoError] = useState('');
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [pluginInfo, setPluginInfo] = useState<PluginInfo | null>(null);
  const [threadTools, setThreadTools] = useState<ThreadToolView[]>([]);
  const [threadToolsLoading, setThreadToolsLoading] = useState(false);
  const [threadToolsError, setThreadToolsError] = useState('');
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [savingToolName, setSavingToolName] = useState<string | null>(null);
  const [pluginEvents, setPluginEvents] = useState<Array<{ sequence: number; event: PluginUiEvent }>>([]);
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [executorConnected, setExecutorConnected] = useState<boolean | null>(null);
  const [executorError, setExecutorError] = useState<string | null>(null);
  const [executorDetails, setExecutorDetails] = useState<ExecutorStatusDetails>({});
  const [dismissedPluginNoticeKey, setDismissedPluginNoticeKey] = useState<string | null>(null);
  const [dismissedExecutorNoticeKey, setDismissedExecutorNoticeKey] = useState<string | null>(null);
  const [dismissedPauseNoticeKey, setDismissedPauseNoticeKey] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const [executorUpdateOpen, setExecutorUpdateOpen] = useState(false);
  const [executorUpdateBusy, setExecutorUpdateBusy] = useState(false);
  const [executorUpdateError, setExecutorUpdateError] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [sendingThreadIds, setSendingThreadIds] = useState<Set<string>>(new Set());
  const [draftsByThread, setDraftsByThread] = useState<Record<string, string>>(
    () => composerState.current!.draftsByThread,
  );
  const [unavailableModelExecutionIds, setUnavailableModelExecutionIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [threadNotices, setThreadNotices] = useState<ThreadNotices>({});
  const [loadingEarlierThreadIds, setLoadingEarlierThreadIds] = useState<Set<string>>(new Set());
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
    provider: 'openai-compatible' as ModelSettings['provider'],
    hasApiKey: false,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const threadScrollbarRef = useRef<HTMLDivElement>(null);
  const threadScrollbarThumbRef = useRef<HTMLDivElement>(null);
  const threadScrollbarDrag = useRef<{ pointerId: number; pointerOffset: number } | null>(null);
  const [threadScrollbar, setThreadScrollbar] = useState({
    maxScroll: 0,
    scrollTop: 0,
    thumbHeight: 0,
    thumbTop: 0,
  });
  const pendingThinkingScrollAdjustment = useRef<{
    summary: HTMLElement;
    summaryTop: number;
    followLatest: boolean;
  } | null>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const snapshotRequest = useRef(0);
  const projectThreadVersions = useRef(new Map<string, number>());
  const archivedThreadVersion = useRef(0);
  const activeProjectId = useRef(projectId);
  const activeThreadsRef = useRef(threads);
  activeThreadsRef.current = threads;
  const threadUpdateVersions = useRef(new Map<string, number>());
  const snapshotVersions = useRef(new Map<string, number>());
  const pendingMessageIds = useRef<PendingMessageIds>(composerState.current.pendingMessages);
  const pendingSubmissionThreads = useRef(new Set<string>());
  const activeModelExecutions = useRef<AssistantStreamExecutions>(new Map());
  const pluginEventSequence = useRef(0);
  const unavailableModelExecutions = useRef<AssistantStreamExecutions>(new Map());
  const observedModelExecutions = useRef(new Set<string>());
  const historyExpandedThreads = useRef(new Set<string>());
  const projectThreadLoads = useRef(new Set<string>());
  const draft = threadId ? (draftsByThread[threadId] ?? '') : '';
  const draftRef = useRef({ threadId, value: draft });
  activeProjectId.current = projectId;
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;
  draftRef.current = { threadId, value: draft };

  const toggleThinking = useCallback(
    (expanded: boolean, summary: HTMLElement): void => {
      if (expanded === thinkingExpanded) return;
      const scroll = listRef.current;
      if (scroll) {
        const followingLatest = followLatest.current;
        pendingThinkingScrollAdjustment.current = {
          summary,
          summaryTop: summary.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
          followLatest: followingLatest,
        };
        if (!followingLatest) scroll.classList.add('conversation-scroll-preserve-anchor');
      }
      setThinkingExpanded(expanded);
    },
    [thinkingExpanded],
  );

  const thinkingDisclosure = useMemo(
    () => ({ expanded: thinkingExpanded, toggle: toggleThinking }),
    [thinkingExpanded, toggleThinking],
  );

  useLayoutEffect(() => {
    const pending = pendingThinkingScrollAdjustment.current;
    if (!pending) return;
    pendingThinkingScrollAdjustment.current = null;
    const scroll = listRef.current;
    if (!scroll) return;
    if (pending.followLatest) {
      scroll.classList.remove('conversation-scroll-preserve-anchor');
      scroll.scrollTop = scroll.scrollHeight;
      scroll.classList.add('conversation-scroll-follow-latest');
      followLatest.current = true;
      return;
    }
    if (!pending.summary.isConnected) {
      scroll.classList.remove('conversation-scroll-preserve-anchor');
      return;
    }
    const summaryTop = pending.summary.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTop += summaryTop - pending.summaryTop;
    scroll.classList.remove('conversation-scroll-preserve-anchor');
  }, [thinkingExpanded]);

  useLayoutEffect(() => {
    const textarea = messageTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const style = window.getComputedStyle(textarea);
    const fontSize = Number.parseFloat(style.fontSize) || 12;
    const parsedLineHeight = Number.parseFloat(style.lineHeight);
    const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fontSize * 1.65;
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const maxHeight = Math.ceil(lineHeight * 5 + verticalPadding);
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [draft, threadId]);

  const updateDraft = (value: string): void => {
    const targetThreadId = activeThreadId.current;
    if (!targetThreadId) return;
    draftRef.current = { threadId: targetThreadId, value };
    const state = composerState.current!;
    state.draftsByThread = { ...state.draftsByThread, [targetThreadId]: value };
    setDraftsByThread(state.draftsByThread);
    persistComposerState(state);
  };

  const acceptMessage = useCallback((targetThreadId: string, id: string, content: string): boolean => {
    const state = composerState.current!;
    if (!acceptComposerMessage(state, targetThreadId, id, content)) return false;
    if (draftRef.current.threadId === targetThreadId && draftRef.current.value.trim() === content) {
      draftRef.current = { threadId: targetThreadId, value: '' };
    }
    setDraftsByThread(state.draftsByThread);
    persistComposerState(state);
    return true;
  }, []);

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
  const activeSnapshotThreadId = activeSnapshot?.thread.id;
  const activeSnapshotLatestSeq = activeSnapshot?.records.at(-1)?.seq;
  const selectedThread =
    activeSnapshot?.thread ??
    threads.find((thread) => thread.id === threadId && thread.projectId === projectId) ??
    null;
  const selectedThreadId = selectedThread?.id ?? null;
  const syncThreadScrollbar = useCallback(() => {
    const scroll = listRef.current;
    const track = threadScrollbarRef.current;
    if (!scroll || !track) {
      setThreadScrollbar((current) =>
        current.maxScroll === 0 && current.scrollTop === 0 && current.thumbHeight === 0 && current.thumbTop === 0
          ? current
          : { maxScroll: 0, scrollTop: 0, thumbHeight: 0, thumbTop: 0 },
      );
      return;
    }

    const trackHeight = track.clientHeight;
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const scrollTop = Math.max(0, Math.min(maxScroll, scroll.scrollTop));
    const thumbHeight =
      maxScroll > 0 && trackHeight > 0
        ? Math.min(
            trackHeight,
            Math.max(Math.min(36, trackHeight), (trackHeight * scroll.clientHeight) / scroll.scrollHeight),
          )
        : trackHeight;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0;

    setThreadScrollbar((current) =>
      current.maxScroll === maxScroll &&
      current.scrollTop === scrollTop &&
      current.thumbHeight === thumbHeight &&
      current.thumbTop === thumbTop
        ? current
        : { maxScroll, scrollTop, thumbHeight, thumbTop },
    );
  }, []);
  useLayoutEffect(() => {
    const scroll = listRef.current;
    const track = threadScrollbarRef.current;
    if (!scroll || !track) {
      syncThreadScrollbar();
      return undefined;
    }

    syncThreadScrollbar();
    const observer = new ResizeObserver(syncThreadScrollbar);
    observer.observe(scroll);
    observer.observe(track);
    if (scroll.firstElementChild instanceof HTMLElement) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, [selectedThreadId, syncThreadScrollbar]);
  const scrollThreadFromPointer = (clientY: number, pointerOffset: number): void => {
    const scroll = listRef.current;
    const track = threadScrollbarRef.current;
    if (!scroll || !track) return;
    const trackHeight = track.clientHeight;
    const thumbHeight = threadScrollbarThumbRef.current?.clientHeight ?? threadScrollbar.thumbHeight;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    if (maxThumbTop === 0 || maxScroll === 0) return;
    const trackTop = track.getBoundingClientRect().top;
    const thumbTop = Math.max(0, Math.min(maxThumbTop, clientY - trackTop - pointerOffset));
    scroll.scrollTop = (thumbTop / maxThumbTop) * maxScroll;
  };
  const selectedThreadSending = selectedThread ? sendingThreadIds.has(selectedThread.id) : false;
  const activeNotice = noticeForThread(threadId, threadNotices, notice);
  const filteredCommands = useMemo(() => {
    if (!draft.startsWith('/')) return [];
    const token = draft.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    return commands.filter((command) => command.name.startsWith(token)).slice(0, 7);
  }, [commands, draft]);
  const uiContributions = pluginInfo?.ui ?? [];
  const toolbarContributions = uiContributionsAt(uiContributions, 'thread.toolbar');
  const composerActions = uiContributionsAt(uiContributions, 'composer.action');
  const composerModelContributions = uiContributionsAt(uiContributions, 'composer.model', settings?.provider);
  const composerStatusContributions = uiContributionsAt(uiContributions, 'composer.status');
  const sidebarPanels = uiContributionsAt(uiContributions, 'sidebar.panel');
  const toolResultContributions = uiContributionsAt(uiContributions, 'tool.result');
  const newProjectWorkspacePath = newProjectPath || defaultWorkspace;
  const suggestedNewProjectName = workspaceDirectoryName(newProjectWorkspacePath);

  const loadThreadTools = useCallback(async (targetThreadId: string): Promise<void> => {
    setThreadToolsLoading(true);
    setThreadToolsError('');
    try {
      const result = await api<{ tools: ThreadToolView[] }>(`/api/threads/${encodeURIComponent(targetThreadId)}/tools`);
      if (activeThreadId.current === targetThreadId) setThreadTools(result.tools);
    } catch (caught) {
      if (activeThreadId.current === targetThreadId) {
        setThreadToolsError(caught instanceof Error ? caught.message : 'Could not load Thread tools.');
      }
    } finally {
      if (activeThreadId.current === targetThreadId) setThreadToolsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setThreadTools([]);
      setThreadToolsLoading(false);
      setThreadToolsError('');
      setToolsMenuOpen(false);
      return;
    }
    setThreadTools([]);
    setThreadToolsError('');
    setToolsMenuOpen(false);
    void loadThreadTools(selectedThreadId);
  }, [loadThreadTools, selectedThreadId]);

  useEffect(() => {
    if (!toolsMenuOpen) return;
    const dismissOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !toolsMenuRef.current?.contains(event.target)) setToolsMenuOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setToolsMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismissOutside);
    window.addEventListener('keydown', dismissEscape);
    return () => {
      window.removeEventListener('pointerdown', dismissOutside);
      window.removeEventListener('keydown', dismissEscape);
    };
  }, [toolsMenuOpen]);

  const toggleThreadTool = async (tool: ThreadToolView): Promise<void> => {
    if (!selectedThread || savingToolName) return;
    setSavingToolName(tool.name);
    setThreadToolsError('');
    try {
      const result = await api<{ tools: ThreadToolView[] }>(
        `/api/threads/${encodeURIComponent(selectedThread.id)}/tools`,
        { method: 'PUT', body: JSON.stringify({ name: tool.name, enabled: !tool.enabled }) },
      );
      setThreadTools(result.tools);
    } catch (caught) {
      setThreadToolsError(caught instanceof Error ? caught.message : 'Could not update this Tool.');
    } finally {
      setSavingToolName(null);
    }
  };

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
            record.payload.source === 'user' &&
            typeof record.payload.content === 'string'
          ) {
            acceptMessage(id, record.id, record.payload.content);
          }
        }
        setSnapshot((current) => mergeLatestSnapshot(current, value));
      }
    },
    [acceptMessage, observeModelExecutions],
  );

  const noteSnapshotChange = useCallback((threadId: string | null | undefined): void => {
    if (!threadId) return;
    snapshotVersions.current.set(threadId, (snapshotVersions.current.get(threadId) ?? 0) + 1);
  }, []);

  const loadProjectThreads = useCallback(async (id: string): Promise<Thread[] | null> => {
    projectThreadLoads.current.add(id);
    const version = projectThreadVersions.current.get(id) ?? 0;
    projectThreadVersions.current.set(id, version + 1);
    try {
      const values = await fetchStableSnapshot(
        () => api<Thread[]>(`/api/projects/${encodeURIComponent(id)}/threads`),
        () => projectThreadVersions.current.get(id) ?? 0,
        () => true,
      );
      if (values) {
        const activeThreads = values.filter((thread) => !thread.archivedAt && !thread.deletedAt);
        setThreadsByProject((current) => ({ ...current, [id]: activeThreads }));
        if (activeProjectId.current === id) setThreads(activeThreads);
        return activeThreads;
      }
      return values;
    } catch (caught) {
      projectThreadLoads.current.delete(id);
      throw caught;
    }
  }, []);

  const syncThreadLists = useCallback((updated: Thread): void => {
    projectThreadVersions.current.set(
      updated.projectId,
      (projectThreadVersions.current.get(updated.projectId) ?? 0) + 1,
    );
    archivedThreadVersion.current += 1;
    const isActive = !updated.archivedAt && !updated.deletedAt;
    const isArchived = Boolean(updated.archivedAt) && !updated.deletedAt;

    setThreadsByProject((current) => {
      const projectThreads = current[updated.projectId] ?? [];
      return {
        ...current,
        [updated.projectId]: isActive
          ? upsertProjectThread(projectThreads, updated, updated.projectId)
          : projectThreads.filter((thread) => thread.id !== updated.id),
      };
    });
    setThreads((current) =>
      isActive
        ? upsertProjectThread(current, updated, activeProjectId.current)
        : current.filter((thread) => thread.id !== updated.id),
    );
    setArchivedThreads((current) =>
      isArchived
        ? upsertProjectThread(current, updated, updated.projectId)
        : current.filter((thread) => thread.id !== updated.id),
    );

    if (!isActive && activeThreadId.current === updated.id) {
      const next = activeThreadsRef.current.find(
        (thread) =>
          thread.id !== updated.id && thread.projectId === updated.projectId && !thread.archivedAt && !thread.deletedAt,
      );
      setThreadId(next?.id ?? null);
    }
    setSnapshot((current) => {
      if (current?.thread.id !== updated.id) return current;
      if (!isActive) return null;
      return { ...current, thread: updated };
    });
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
    void fetchStableSnapshot(
      () =>
        Promise.all([
          api<Project[]>('/api/projects'),
          api<PublicSettings>('/api/settings/model'),
          api<ContextManagementSettings>('/api/settings/context-management'),
          api<Array<{ name: string; description: string }>>('/api/commands'),
          api<PluginInfo>('/api/plugins'),
          api<{ defaultWorkspace: string }>('/api/info'),
          api<RemoteExecutorConnectionView[]>('/api/executor-connections'),
        ]),
      () => 0,
      () => alive,
    )
      .then((bootstrap) => {
        if (!alive || !bootstrap) return;
        setBootstrapping(false);
        const [projectList, modelSettings, contextSettings, commandList, pluginResult, info, connections] = bootstrap;
        setProjects(projectList);
        setSettings(modelSettings);
        setContextManagement(contextSettings);
        setContextManagementForm({
          contextWindowTokens: String(contextSettings.contextWindowTokens),
          compactionThresholdTokens: String(contextSettings.compactionThresholdTokens),
          keepRecentTokens: String(contextSettings.keepRecentTokens),
        });
        setModelForm({ ...modelSettings, apiKey: '' });
        setCommands(commandList);
        setPluginInfo(pluginResult);
        setDefaultWorkspace(info.defaultWorkspace);
        setRemoteConnections(connections);
        const remembered = localStorage.getItem('pico.project');
        const initial = projectList.find((project) => project.id === remembered)?.id ?? projectList[0]?.id ?? null;
        setProjectId(initial);
        setExpandedProjectIds(new Set(initial ? [initial] : []));
        if (initial) localStorage.setItem('pico.project', initial);
        if (modelSettings.model.trim() === '') setSettingsOpen(false);
      })
      .catch((caught: unknown) => {
        if (alive) {
          setBootstrapping(false);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    for (const project of projects) {
      if (project.id === projectId || projectThreadLoads.current.has(project.id)) continue;
      void loadProjectThreads(project.id).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    }
  }, [loadProjectThreads, projectId, projects]);

  useEffect(() => {
    if (!settingsOpen || !archivedThreadsOpen) return;
    let alive = true;
    setArchivedThreadsLoading(true);
    setError('');
    void fetchStableSnapshot(
      () => api<{ threads: Thread[] }>('/api/threads/archived'),
      () => archivedThreadVersion.current,
      () => alive,
    )
      .then((result) => {
        if (alive && result) {
          setArchivedThreads(result.threads.filter((thread) => thread.archivedAt && !thread.deletedAt));
        }
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (alive) setArchivedThreadsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [archivedThreadsOpen, settingsOpen]);

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
      setExecutorDetails({});
      setExecutorUpdateOpen(false);
      return;
    }
    setExecutorConnected(null);
    setExecutorError(null);
    setExecutorDetails({});
    setExecutorUpdateOpen(false);
    setExecutorUpdateError('');
    let alive = true;
    let refreshing = false;
    let promptedUpdate = false;
    const refresh = async (): Promise<void> => {
      if (!alive || refreshing) return;
      refreshing = true;
      try {
        const [executorResult] = await Promise.allSettled([
          api<{
            connected: boolean;
            error?: string;
            updateAvailable?: boolean;
            compatible?: boolean;
            executorVersion?: string | null;
            targetVersion?: string | null;
            updateSupported?: boolean;
          }>(`/api/threads/${encodeURIComponent(threadId)}/executor`),
        ]);
        if (!alive) return;
        const executorStatus = executorStatusFromProbe(executorResult);
        setExecutorConnected(executorStatus.connected);
        setExecutorError(executorStatus.error);
        if (executorResult.status === 'fulfilled') {
          const details = executorResult.value;
          setExecutorDetails(details);
          if (selectedThread?.executorKind !== 'runtime' && details.updateAvailable && !promptedUpdate) {
            promptedUpdate = true;
            setExecutorUpdateOpen(true);
          }
        }
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedThread?.executorKind, threadId]);

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
        if (event.type === 'plugin.updated' && typeof event.pluginId === 'string') {
          const pluginEvent = { type: event.type, pluginId: event.pluginId } satisfies PluginUiEvent;
          const sequence = ++pluginEventSequence.current;
          setPluginEvents((current) => [...current.slice(-99), { sequence, event: pluginEvent }]);
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
            if (created.archivedAt || created.deletedAt) {
              syncThreadLists(created);
            } else {
              setThreadsByProject((current) => ({
                ...current,
                [created.projectId]: upsertProjectThread(current[created.projectId] ?? [], created, created.projectId),
              }));
              setThreads((items) => upsertProjectThread(items, created, activeProjectId.current));
            }
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
            syncThreadLists(updated);
          }
        } else if (event.type === 'thread.hidden') {
          const hidden = event.thread as Thread | undefined;
          if (hidden) {
            threadUpdateVersions.current.set(hidden.id, (threadUpdateVersions.current.get(hidden.id) ?? 0) + 1);
            noteSnapshotChange(hidden.id);
            noteSnapshotChange(hidden.parentThreadId);
            syncThreadLists(hidden);
          }
        } else if (event.type === 'record') {
          const record = event.record as CanonicalRecord | undefined;
          if (record?.kind === 'message' && record.threadId) {
            if (record.payload.source === 'user' && typeof record.payload.content === 'string') {
              acceptMessage(record.threadId, record.id, record.payload.content);
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
              return appendSnapshotRecord(
                current,
                record,
                Boolean(record.threadId && historyExpandedThreads.current.has(record.threadId)),
              );
            });
          }
          const recordThreadId = record?.threadId;
          if (recordThreadId && record?.kind === 'assistant' && record.id.endsWith(':assistant')) {
            const executionId = record.id.slice(0, -':assistant'.length);
            settleModelExecution(executionId);
            assistantDraftStore.clear(recordThreadId, executionId);
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
        } else if (
          event.type === 'thread.model-selection.updated' &&
          typeof event.threadId === 'string' &&
          event.selection &&
          typeof event.selection === 'object'
        ) {
          const targetThreadId = event.threadId;
          const selection = event.selection as ThreadModelSelection;
          setSnapshot((current) =>
            current?.thread.id === targetThreadId ? { ...current, modelSelection: selection } : current,
          );
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
          assistantDraftStore.appendText(draftThreadId, executionId, delta);
        } else if (
          (event.type === 'model.reasoning_summary.delta' || event.type === 'model.tool_call.preview') &&
          typeof event.threadId === 'string' &&
          typeof event.executionId === 'string'
        ) {
          const { threadId: previewThreadId, executionId } = event;
          if (
            !canAppendAssistantDelta(
              activeModelExecutions.current,
              unavailableModelExecutions.current,
              previewThreadId,
              executionId,
            )
          )
            return;
          if (event.type === 'model.reasoning_summary.delta' && typeof event.delta === 'string') {
            const delta = event.delta;
            assistantDraftStore.appendPreview(previewThreadId, executionId, { type: 'reasoning', delta });
          } else if (typeof event.index === 'number' && typeof event.argumentsText === 'string') {
            const call = {
              index: event.index,
              argumentsText: event.argumentsText,
              ...(typeof event.id === 'string' ? { id: event.id } : {}),
              ...(typeof event.name === 'string' ? { name: event.name } : {}),
            };
            assistantDraftStore.appendPreview(previewThreadId, executionId, { type: 'tool', call });
          }
        } else if (
          event.type === 'model.draft-ended' &&
          typeof event.threadId === 'string' &&
          typeof event.executionId === 'string'
        ) {
          const draftThreadId = event.threadId;
          const executionId = event.executionId;
          settleModelExecution(executionId);
          assistantDraftStore.clear(draftThreadId, executionId);
        } else if (event.type === 'runtime.error') {
          const failedThreadId = typeof event.threadId === 'string' ? event.threadId : null;
          if (failedThreadId) {
            assistantDraftStore.clear(failedThreadId);
          }
          if (failedThreadId === activeThreadId.current && event.source !== 'model-execution') {
            setError(String(event.message ?? 'Runtime error'));
          }
        } else if (event.type === 'runtime.notice' && typeof event.threadId === 'string') {
          setThreadNotices((current) =>
            withThreadNotice(current, event.threadId as string, String(event.message ?? 'Runtime notice')),
          );
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
            assistantDraftStore.getAll(),
            unavailableModelExecutions.current,
          );
          unavailableModelExecutions.current = unavailable;
          setUnavailableModelExecutionIds(new Set(unavailable.keys()));
          assistantDraftStore.clearAll();
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
  }, [acceptMessage, noteSnapshotChange, observeModelExecutions, settleModelExecution, syncThreadLists]);

  useEffect(() => {
    followLatest.current = true;
    listRef.current?.classList.add('conversation-scroll-follow-latest');
  }, [threadId]);

  useEffect(() => {
    if (!activeSnapshotThreadId || activeSnapshotLatestSeq === undefined) return;
    const timer = window.setTimeout(() => {
      void loadSnapshot(activeSnapshotThreadId).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [activeSnapshotLatestSeq, activeSnapshotThreadId, loadSnapshot]);

  useEffect(() => {
    const list = listRef.current;
    if (list && followLatest.current) list.scrollTop = list.scrollHeight;
  }, [threadId, activeSnapshot?.records.length, activeSnapshot?.executions]);

  const sendMessage = async (content = draft): Promise<void> => {
    const clean = content.trim();
    const sentThreadId = threadId;
    if (!sentThreadId || !clean || busy || pendingSubmissionThreads.current.has(sentThreadId)) return;
    if (selectedThread?.executorKind !== 'runtime' && executorConnected !== true) return;
    let id: string | undefined;
    try {
      followLatest.current = true;
      listRef.current?.classList.add('conversation-scroll-follow-latest');
      markThreadSending(sentThreadId, true);
      setError('');
      id = messageSubmissionId(pendingMessageIds.current, sentThreadId, clean, createRequestUuid);
      persistComposerState(composerState.current!);
      const result = await api<{
        accepted: boolean;
        duplicate?: boolean;
        command?: { text?: string; openThreadId?: string };
      }>(`/api/threads/${sentThreadId}/messages`, messageSubmissionRequestInit(id, clean));
      acceptMessage(sentThreadId, id, clean);
      const commandText = result.command?.text;
      if (commandText) setThreadNotices((current) => withThreadNotice(current, sentThreadId, commandText));
      if (activeThreadId.current === sentThreadId) {
        if (result.command?.openThreadId) setThreadId(result.command.openThreadId);
      }
      void loadSnapshot(sentThreadId);
    } catch (caught) {
      if (
        activeThreadId.current === sentThreadId &&
        (id === undefined || hasPendingMessageSubmission(pendingMessageIds.current, sentThreadId, id))
      ) {
        setError(messageSubmissionFailureMessage(caught));
      }
    } finally {
      markThreadSending(sentThreadId, false);
    }
  };

  const updateExecutor = async (): Promise<void> => {
    if (!selectedThread || selectedThread.executorKind === 'runtime' || executorUpdateBusy) return;
    const targetThreadId = selectedThread.id;
    setExecutorUpdateBusy(true);
    setExecutorUpdateError('');
    try {
      await api(`/api/threads/${encodeURIComponent(targetThreadId)}/executor/update`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const status = await api<{
        connected: boolean;
        error?: string;
        updateAvailable?: boolean;
        compatible?: boolean;
        executorVersion?: string | null;
        targetVersion?: string | null;
        updateSupported?: boolean;
      }>(`/api/threads/${encodeURIComponent(targetThreadId)}/executor`);
      if (activeThreadId.current === targetThreadId) {
        const checked = executorStatusFromProbe({ status: 'fulfilled', value: status });
        setExecutorConnected(checked.connected);
        setExecutorError(checked.error);
        setExecutorDetails(status);
      }
    } catch (caught) {
      if (activeThreadId.current === targetThreadId) {
        setExecutorUpdateError(caught instanceof Error ? caught.message : 'Could not update the Executor.');
      }
    } finally {
      setExecutorUpdateBusy(false);
    }
  };

  const recheckExecutor = async (): Promise<void> => {
    if (!selectedThread || selectedThread.executorKind === 'runtime') return;
    const targetThreadId = selectedThread.id;
    setExecutorUpdateBusy(true);
    setExecutorUpdateError('');
    try {
      const status = await api<{
        connected: boolean;
        error?: string;
        updateAvailable?: boolean;
        compatible?: boolean;
        executorVersion?: string | null;
        targetVersion?: string | null;
        updateSupported?: boolean;
      }>(`/api/threads/${encodeURIComponent(targetThreadId)}/executor`);
      const checked = executorStatusFromProbe({ status: 'fulfilled', value: status });
      if (activeThreadId.current === targetThreadId) {
        setExecutorConnected(checked.connected);
        setExecutorError(checked.error);
        setExecutorDetails(status);
      }
    } catch (caught) {
      if (activeThreadId.current === targetThreadId) {
        setExecutorUpdateError(caught instanceof Error ? caught.message : 'Could not check the Executor.');
      }
    } finally {
      setExecutorUpdateBusy(false);
    }
  };

  const createProject = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const workspacePath = newProjectPath || defaultWorkspace;
    try {
      const project = await api<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: newProjectName.trim() || workspaceDirectoryName(workspacePath), workspacePath }),
      });
      setProjects((items) => [project, ...items]);
      projectThreadLoads.current.add(project.id);
      setThreadsByProject((current) => ({ ...current, [project.id]: [] }));
      setProjectId(project.id);
      setExpandedProjectIds((current) => new Set(current).add(project.id));
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

  const updateThreadTitle = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selectedThread) return;
    setThreadInfoError('');
    setThreadTitleSaving(true);
    try {
      const updated = await api<Thread>(`/api/threads/${encodeURIComponent(selectedThread.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: threadTitleDraft }),
      });
      syncThreadLists(updated);
      setThreadInfoOpen(false);
    } catch (caught) {
      setThreadInfoError(caught instanceof Error ? caught.message : 'Could not rename this Thread.');
    } finally {
      setThreadTitleSaving(false);
    }
  };

  const archiveSelectedThread = async (): Promise<void> => {
    if (!selectedThread || threadTitleSaving) return;
    setThreadInfoError('');
    setThreadTitleSaving(true);
    try {
      const updated = await api<Thread>(`/api/threads/${encodeURIComponent(selectedThread.id)}/archive`, {
        method: 'POST',
        body: '{}',
      });
      syncThreadLists(updated);
      setThreadInfoOpen(false);
    } catch (caught) {
      setThreadInfoError(caught instanceof Error ? caught.message : 'Could not archive this Thread.');
    } finally {
      setThreadTitleSaving(false);
    }
  };

  const restoreArchivedThread = async (thread: Thread): Promise<void> => {
    setError('');
    setArchivedThreadActionId(thread.id);
    try {
      const updated = await api<Thread>(`/api/threads/${encodeURIComponent(thread.id)}/unarchive`, {
        method: 'POST',
        body: '{}',
      });
      syncThreadLists(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not restore this Thread.');
    } finally {
      setArchivedThreadActionId(null);
    }
  };

  const deleteArchivedThread = async (thread: Thread): Promise<void> => {
    const confirmed = window.confirm(
      `Delete “${thread.title}”? This hides the Thread from Pico. Its history records will remain retained.`,
    );
    if (!confirmed) return;
    setError('');
    setArchivedThreadActionId(thread.id);
    try {
      const response = await api<unknown>(`/api/threads/${encodeURIComponent(thread.id)}`, { method: 'DELETE' });
      const updated = response && typeof response === 'object' && 'id' in response ? (response as Thread) : null;
      if (updated) {
        syncThreadLists(updated);
      } else {
        archivedThreadVersion.current += 1;
        setArchivedThreads((current) => current.filter((item) => item.id !== thread.id));
        setThreadsByProject((current) => ({
          ...current,
          [thread.projectId]: (current[thread.projectId] ?? []).filter((item) => item.id !== thread.id),
        }));
        setThreads((current) => current.filter((item) => item.id !== thread.id));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not hide this Thread from Pico.');
    } finally {
      setArchivedThreadActionId(null);
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
      setThreadsByProject((current) => ({
        ...current,
        [projectId]: [thread, ...(current[projectId] ?? []).filter((item) => item.id !== thread.id)],
      }));
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
      setNewThreadRemoteConnectionId(connection.id);
      setNewThreadRemoteWorkspacePath(connection.workspaceRoot);
      setNewThreadExecutor('remote');
      setRemoteForm({ name: '', endpointUrl: '', accessToken: '' });
      setRemoteConnectionNotice(`Connected to ${connection.name}.`);
      setNotice(`Connected to ${connection.name}.`);
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
      if ((threadUpdateVersions.current.get(threadId) ?? 0) === updateVersion) {
        setThreadsByProject((current) => ({
          ...current,
          [updated.projectId]: (current[updated.projectId] ?? []).map((item) =>
            item.id === updated.id ? updated : item,
          ),
        }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const retryModelExecution = async (targetThreadId: string, sourceExecutionId: string): Promise<Execution> => {
    const updateVersion = threadUpdateVersions.current.get(targetThreadId) ?? 0;
    const result = await api<{ execution: Execution; thread: Thread }>(
      `/api/threads/${encodeURIComponent(targetThreadId)}/executions/${encodeURIComponent(sourceExecutionId)}/retry`,
      { method: 'POST', body: '{}' },
    );
    if (
      activeThreadId.current === targetThreadId &&
      (threadUpdateVersions.current.get(targetThreadId) ?? 0) === updateVersion
    ) {
      setSnapshot((current) =>
        current?.thread.id === targetThreadId
          ? {
              ...current,
              thread: result.thread,
              executions: [result.execution, ...current.executions.filter((item) => item.id !== result.execution.id)],
            }
          : current,
      );
      setThreads((items) => items.map((item) => (item.id === result.thread.id ? result.thread : item)));
      setThreadsByProject((current) => ({
        ...current,
        [result.thread.projectId]: (current[result.thread.projectId] ?? []).map((item) =>
          item.id === result.thread.id ? result.thread : item,
        ),
      }));
    }
    return result.execution;
  };

  const saveModelSettings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSettingsSaving(true);
    setError('');
    const body: Partial<ModelSettings> = {
      baseUrl: modelForm.baseUrl,
      provider: modelForm.provider,
    };
    // Switching providers must not carry the previous provider's model into its saved selection.
    if (modelForm.provider === 'openai-compatible') {
      body.model = modelForm.model;
    }
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

  const saveContextManagementSettings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const contextWindowTokens = Number(contextManagementForm.contextWindowTokens);
    const compactionThresholdTokens = Number(contextManagementForm.compactionThresholdTokens);
    const keepRecentTokens = Number(contextManagementForm.keepRecentTokens);
    if (
      !Number.isSafeInteger(contextWindowTokens) ||
      contextWindowTokens <= 0 ||
      !Number.isSafeInteger(compactionThresholdTokens) ||
      compactionThresholdTokens <= 0 ||
      !Number.isSafeInteger(keepRecentTokens) ||
      keepRecentTokens <= 0
    ) {
      setError('Enter positive whole numbers for all token limits.');
      return;
    }
    if (compactionThresholdTokens >= contextWindowTokens) {
      setError('The compaction threshold must be lower than the context window.');
      return;
    }
    setSettingsSaving(true);
    setError('');
    try {
      const saved = await api<ContextManagementSettings>('/api/settings/context-management', {
        method: 'PUT',
        body: JSON.stringify({ contextWindowTokens, compactionThresholdTokens, keepRecentTokens }),
      });
      setContextManagement(saved);
      setContextManagementForm({
        contextWindowTokens: String(saved.contextWindowTokens),
        compactionThresholdTokens: String(saved.compactionThresholdTokens),
        keepRecentTokens: String(saved.keepRecentTokens),
      });
      setNotice('Context management settings saved on this Pico Runtime.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateModelSettingsFromPlugin: PluginUiProps['updateModelSettings'] = async (update, targetThreadId) => {
    if (targetThreadId) {
      const current = await api<ThreadModelSelection>(
        `/api/threads/${encodeURIComponent(targetThreadId)}/model-selection`,
      );
      const provider = update.provider ?? current.provider;
      const model = update.model ?? current.model;
      const targetChanged = provider !== current.provider || model !== current.model;
      const saved = await api<ThreadModelSelection>(
        `/api/threads/${encodeURIComponent(targetThreadId)}/model-selection`,
        {
          method: 'PUT',
          body: JSON.stringify({
            ...current,
            provider,
            model,
            parameters: {
              ...current.parameters,
              ...(update.temperature === undefined ? {} : { temperature: update.temperature }),
              ...(targetChanged ? { options: {} } : {}),
            },
          }),
        },
      );
      if (activeThreadId.current === targetThreadId) {
        setSnapshot((snapshot) =>
          snapshot?.thread.id === targetThreadId ? { ...snapshot, modelSelection: saved } : snapshot,
        );
      }
      return;
    }
    const saved = await api<PublicSettings>('/api/settings/model', { method: 'PUT', body: JSON.stringify(update) });
    setSettings(saved);
    setModelForm((form) => ({ ...form, ...saved, apiKey: '' }));
  };

  const openCanonicalMessage: PluginUiProps['openMessage'] = async (seq) => {
    const targetThreadId = threadId;
    if (!targetThreadId || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('A canonical message in the active Thread must be selected.');
    }
    followLatest.current = false;
    listRef.current?.classList.remove('conversation-scroll-follow-latest');
    let target = document.getElementById(`canonical-message-${seq}`);
    let beforeSeq = activeSnapshot?.records[0]?.seq;
    let hasEarlier = activeSnapshot?.hasEarlierRecords ?? false;
    while (!target && hasEarlier && beforeSeq !== undefined) {
      const page = await api<ThreadSnapshot>(
        `/api/threads/${encodeURIComponent(targetThreadId)}?beforeSeq=${beforeSeq}`,
      );
      if (activeThreadId.current !== targetThreadId)
        throw new Error('The active Thread changed before history loaded.');
      historyExpandedThreads.current.add(targetThreadId);
      setSnapshot((current) =>
        current && current.thread.id === targetThreadId ? mergeEarlierSnapshot(current, page) : current,
      );
      beforeSeq = page.records[0]?.seq;
      hasEarlier = page.hasEarlierRecords;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      target = document.getElementById(`canonical-message-${seq}`);
    }
    if (!target) throw new Error(`Canonical message ${seq} is not available in the active Thread.`);
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const openProjectThread: PluginUiProps['openThread'] = async (targetThreadId) => {
    const currentProjectId = selectedThread?.projectId;
    if (!currentProjectId || !targetThreadId || targetThreadId.length > 200) {
      throw new Error('A Thread in the active Project must be selected.');
    }
    const target = await api<ThreadSnapshot>(`/api/threads/${encodeURIComponent(targetThreadId)}`);
    if (target.thread.projectId !== currentProjectId) {
      throw new Error('Plugin navigation is limited to Threads in the active Project.');
    }
    chooseThread(target.thread.id, currentProjectId);
  };

  const openPluginPage = (pluginId: string, pageId: string): void => {
    const page = pluginInfo?.pages.find((candidate) => candidate.pluginId === pluginId && candidate.id === pageId);
    if (page?.group === 'memory') {
      setPluginPageSelection({ pluginId, pageId });
      setMemoryManagerOpen(true);
      setPluginManagerOpen(false);
      setSettingsOpen(true);
      setError('');
      return;
    }
    setPluginPageSelection({ pluginId, pageId });
    setPluginManagerOpen(false);
    setMemoryManagerOpen(false);
    setSettingsOpen(true);
    setError('');
  };

  const updatePluginEnabled = async (pluginId: string, enabled: boolean): Promise<void> => {
    setPluginActionId(pluginId);
    setError('');
    let enabledStateChanged = false;
    try {
      await api<PluginInfo['catalog']>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      enabledStateChanged = true;
      setPluginInfo(await api<PluginInfo>('/api/plugins'));
      setNotice(`${pluginId} ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Plugin could not be updated.';
      setError(
        enabledStateChanged ? `Plugin state changed, but its settings could not be refreshed: ${message}` : message,
      );
      const refreshed = await api<PluginInfo>('/api/plugins').catch(() => null);
      if (refreshed) setPluginInfo(refreshed);
    } finally {
      setPluginActionId(null);
    }
  };

  const viewContext: PluginUiContext = {
    thread: selectedThread,
    ...(activeSnapshot && selectedThread && activeSnapshot.thread.id === selectedThread.id
      ? { modelSelection: activeSnapshot.modelSelection }
      : {}),
  };

  const runPluginCommand = async (
    pluginId: string,
    targetThreadId: string | null,
    command: string,
  ): Promise<unknown> => {
    if (!targetThreadId) throw new Error('This plugin command requires an active Thread.');
    return await api('/api/commands/execute', {
      method: 'POST',
      body: JSON.stringify({
        pluginId,
        threadId: targetThreadId,
        id: createRequestUuid(),
        command,
      }),
    });
  };

  const pluginUiProps = (): PluginHostUiProps | null => {
    if (!settings) return null;
    return {
      api,
      settings,
      context: viewContext,
      updateModelSettings: updateModelSettingsFromPlugin,
      openThread: openProjectThread,
      openMessage: openCanonicalMessage,
      openPage: openPluginPage,
      onError: setError,
      onNotice: setNotice,
    };
  };

  const pluginUiContext = pluginUiProps();
  const selectedPluginPage = pluginPageSelection
    ? pluginInfo?.pages.find(
        (page) => page.pluginId === pluginPageSelection.pluginId && page.id === pluginPageSelection.pageId,
      )
    : undefined;
  const memoryPages = pluginInfo?.pages.filter((page) => page.group === 'memory') ?? [];
  const selectedMemoryPage =
    memoryPages.find(
      (page) => page.pluginId === pluginPageSelection?.pluginId && page.id === pluginPageSelection.pageId,
    ) ?? memoryPages[0];
  const isRegisteredPluginPage = (pluginId: string, pageId: string): boolean =>
    Boolean(pluginInfo?.pages.some((page) => page.pluginId === pluginId && page.id === pageId));

  const renderToolView = (
    call: ToolCall,
    execution: Execution | undefined,
    result: ToolResultPayload | undefined,
  ): ReactNode => {
    const contribution =
      execution?.status === 'pending' ? toolResultForCall(toolResultContributions, call.name) : undefined;
    const resultActions =
      contribution?.entry && contribution.component && contribution.pluginId && pluginUiContext && selectedThread ? (
        <div className="plugin-tool-result" key={`tool-result-${execution?.id ?? call.id}`}>
          <PluginWebView
            pluginId={contribution.pluginId}
            entry={contribution.entry}
            viewType="component"
            viewId={contribution.component}
            uiSlot={contribution.slot}
            {...pluginUiContext}
            context={{
              thread: null,
              threadId: selectedThread.id,
              ...(execution ? { toolResult: { executionId: execution.id, status: execution.status } } : {}),
            }}
            events={pluginEvents}
            isRegisteredPage={isRegisteredPluginPage}
            runCommand={runPluginCommand}
          />
        </div>
      ) : undefined;
    return (
      <ToolCard
        key={execution?.id ?? call.id}
        call={call}
        execution={execution}
        result={result}
        resultActions={resultActions}
      />
    );
  };

  const clearApiKey = async (): Promise<void> => {
    try {
      const saved = await api<PublicSettings>('/api/settings/model', {
        method: 'PUT',
        body: JSON.stringify({
          baseUrl: modelForm.baseUrl,
          model: modelForm.model,
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

  const chooseThread = (id: string, targetProjectId = projectId): void => {
    if (!targetProjectId) return;
    setExpandedProjectIds((current) => new Set(current).add(targetProjectId));
    localStorage.setItem(`pico.thread.${targetProjectId}`, id);
    if (targetProjectId !== projectId) {
      setProjectId(targetProjectId);
      setThreadId(null);
      setSnapshot(null);
    } else if (id !== threadId) {
      setThreadId(id);
      setSnapshot(null);
    }
    setMobileSidebarOpen(false);
    setNotice('');
    setError('');
  };

  const startThreadInProject = (targetProjectId: string): void => {
    if (targetProjectId !== projectId) {
      setProjectId(targetProjectId);
      setThreads([]);
      setThreadId(null);
      setSnapshot(null);
    }
    setExpandedProjectIds((current) => new Set(current).add(targetProjectId));
    setNewThreadTitle('');
    setNewThreadExecutor('container');
    setNewThreadRemoteConnectionId('');
    setNewThreadRemoteWorkspacePath('');
    setNewThreadOpen(true);
  };

  const dismissNotice = (): void => {
    if (notice) {
      setNotice('');
      return;
    }
    if (threadId) setThreadNotices((current) => withoutThreadNotice(current, threadId));
  };

  const loadEarlierRecords = async (): Promise<void> => {
    const targetThreadId = threadId;
    const beforeSeq = activeSnapshot?.records[0]?.seq;
    if (!targetThreadId || beforeSeq === undefined || !activeSnapshot?.hasEarlierRecords) return;
    setLoadingEarlierThreadIds((current) => new Set(current).add(targetThreadId));
    followLatest.current = false;
    const scroll = listRef.current;
    scroll?.classList.remove('conversation-scroll-follow-latest');
    const previousScrollTop = scroll?.scrollTop ?? 0;
    const previousScrollHeight = scroll?.scrollHeight ?? 0;
    try {
      const page = await api<ThreadSnapshot>(
        `/api/threads/${encodeURIComponent(targetThreadId)}?beforeSeq=${beforeSeq}`,
      );
      if (activeThreadId.current !== targetThreadId) return;
      historyExpandedThreads.current.add(targetThreadId);
      setSnapshot((current) =>
        current && current.thread.id === targetThreadId ? mergeEarlierSnapshot(current, page) : current,
      );
      window.requestAnimationFrame(() => {
        const currentScroll = listRef.current;
        if (activeThreadId.current === targetThreadId && currentScroll) {
          currentScroll.scrollTop = previousScrollTop + (currentScroll.scrollHeight - previousScrollHeight);
        }
      });
    } catch (caught) {
      if (activeThreadId.current === targetThreadId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setLoadingEarlierThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThreadId);
        return next;
      });
    }
  };

  const records = activeSnapshot?.records ?? [];
  const executions = activeSnapshot?.executions ?? [];
  const { groups: executionGroups, groupedAssistantRecordIds } = modelExecutionGroups(records, executions);
  const renderProjectThreads = (project: Project): ReactNode => {
    const projectThreads = threadsByProject[project.id];
    if (projectThreads === undefined) {
      return <div className="sidebar-empty project-thread-empty">Loading Threads…</div>;
    }
    const visibleThreads = projectThreads.filter((thread) => !thread.archivedAt && !thread.deletedAt);
    const visibleThreadIds = new Set(visibleThreads.map((thread) => thread.id));
    const childrenByParent = new Map<string, Thread[]>();
    for (const thread of visibleThreads) {
      if (!thread.parentThreadId) continue;
      const children = childrenByParent.get(thread.parentThreadId) ?? [];
      children.push(thread);
      childrenByParent.set(thread.parentThreadId, children);
    }
    const renderThreadTree = (thread: Thread, child = false, depth = 0): ReactNode => (
      <div key={thread.id} style={depth > 1 ? { marginLeft: `${Math.min(depth - 1, 4) * 8}px` } : undefined}>
        <ThreadListItem
          thread={thread}
          active={thread.id === threadId && project.id === projectId}
          child={child}
          onSelect={() => chooseThread(thread.id, project.id)}
        />
        {(childrenByParent.get(thread.id) ?? []).map((nested) => renderThreadTree(nested, true, depth + 1))}
      </div>
    );
    const roots = visibleThreads.filter(
      (thread) => !thread.parentThreadId || !visibleThreadIds.has(thread.parentThreadId),
    );
    return roots.length ? (
      <div className="project-thread-list">{roots.map((thread) => renderThreadTree(thread))}</div>
    ) : (
      <div className="sidebar-empty project-thread-empty">No Threads yet. Start one with the + button.</div>
    );
  };
  const renderedRecords = records.filter(
    (record) => record.kind === 'message' || (record.kind === 'assistant' && !groupedAssistantRecordIds.has(record.id)),
  );
  const timeline = conversationTimeline(renderedRecords, executionGroups);
  const currentState = selectedThread?.state ?? 'idle';
  const pauseReason = visiblePauseReason(currentState, selectedThread?.pauseReason ?? null, [error, activeNotice]);
  const executorNoticeKey =
    selectedThread && executorConnected === false && executorError
      ? JSON.stringify([
          selectedThread.id,
          executorError,
          executorDetails.compatible ?? null,
          executorDetails.updateAvailable ?? null,
          executorDetails.executorVersion ?? null,
          executorDetails.targetVersion ?? null,
        ])
      : null;
  const pauseNoticeKey =
    selectedThread && (currentState === 'paused' || currentState === 'pausing') && selectedThread.pauseReason
      ? JSON.stringify([selectedThread.id, selectedThread.pauseReason])
      : null;
  const pluginNoticeKey = pluginInfo && pluginInfo.errors.length > 0 ? JSON.stringify(pluginInfo.errors) : null;
  const showPluginNotice = pluginNoticeKey !== null && dismissedPluginNoticeKey !== pluginNoticeKey;
  const showExecutorNotice = executorNoticeKey !== null && dismissedExecutorNoticeKey !== executorNoticeKey;
  const showPauseNotice = pauseReason !== null && pauseNoticeKey !== null && dismissedPauseNoticeKey !== pauseNoticeKey;

  useEffect(() => {
    if (dismissedPluginNoticeKey !== null && dismissedPluginNoticeKey !== pluginNoticeKey) {
      setDismissedPluginNoticeKey(null);
    }
  }, [dismissedPluginNoticeKey, pluginNoticeKey]);

  useEffect(() => {
    if (dismissedExecutorNoticeKey !== null && dismissedExecutorNoticeKey !== executorNoticeKey) {
      setDismissedExecutorNoticeKey(null);
    }
  }, [dismissedExecutorNoticeKey, executorNoticeKey]);

  useEffect(() => {
    if (dismissedPauseNoticeKey !== null && dismissedPauseNoticeKey !== pauseNoticeKey) {
      setDismissedPauseNoticeKey(null);
    }
  }, [dismissedPauseNoticeKey, pauseNoticeKey]);

  return (
    <div
      className={`app-shell ${desktopSidebarCollapsed ? 'desktop-sidebar-collapsed' : ''}${mobileSidebarOpen ? ' mobile-sidebar-open' : ''}`}
    >
      {mobileSidebarOpen ? (
        <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileSidebarOpen(false)} />
      ) : null}
      <aside className={`sidebar ${mobileSidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark">
            <Sparkles size={17} aria-hidden="true" />
          </div>
          <div className="brand-name">pico</div>
        </div>
        <div className="project-section-heading">
          <span className="eyebrow">PROJECTS</span>
          <button
            className="icon-button small"
            aria-label="Create Project"
            disabled={bootstrapping}
            title="Create Project"
            onClick={() => setNewProjectOpen(true)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="thread-list">
          {projects.length === 0 ? (
            <div className="sidebar-empty">No Projects yet. Create one to get started.</div>
          ) : null}
          {projects.map((project) => {
            const expanded = expandedProjectIds.has(project.id);
            const projectThreads = threadsByProject[project.id] ?? [];
            return (
              <section className="project-group" key={project.id}>
                <div className={`project-group-heading ${project.id === projectId ? 'active' : ''}`}>
                  <button
                    className="project-group-toggle"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => {
                      setExpandedProjectIds((current) => {
                        const next = new Set(current);
                        if (next.has(project.id)) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      });
                      if (!projectThreadLoads.current.has(project.id)) {
                        void loadProjectThreads(project.id).catch((caught: unknown) =>
                          setError(caught instanceof Error ? caught.message : String(caught)),
                        );
                      }
                    }}
                  >
                    <span className="project-folder-icon" aria-hidden="true">
                      {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                    </span>
                    <span className="project-group-name">{project.name}</span>
                    <span className="project-group-count">{projectThreads.length}</span>
                    <ChevronRight className={`project-group-chevron ${expanded ? 'expanded' : ''}`} size={14} />
                  </button>
                  <button
                    className="icon-button small project-new-thread"
                    type="button"
                    aria-label={`Create Thread in ${project.name}`}
                    title={`Create Thread in ${project.name}`}
                    disabled={bootstrapping}
                    onClick={() => startThreadInProject(project.id)}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                </div>
                {expanded ? renderProjectThreads(project) : null}
              </section>
            );
          })}
          {sidebarPanels.length > 0 ? (
            <section className="plugin-sidebar-panels" aria-label="Plugin panels">
              <span className="eyebrow">PLUGIN PANELS</span>
              {sidebarPanels.map((item) => (
                <div className="plugin-sidebar-panel" key={pluginUiContributionKey(item)}>
                  {item.entry && item.component ? (
                    <PluginContributionView
                      item={item}
                      pluginProps={pluginUiContext}
                      events={pluginEvents}
                      isRegisteredPage={isRegisteredPluginPage}
                      runCommand={runPluginCommand}
                      onActivate={(contribution) => {
                        executeContribution(contribution);
                        setMobileSidebarOpen(false);
                      }}
                      disabled={busy || selectedThreadSending}
                      buttonClassName="plugin-sidebar-action"
                    />
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              ))}
            </section>
          ) : null}
        </div>
        <div className="runtime-status-row">
          <div className="runtime-foot">
            <i className={socketConnected ? 'online' : 'offline'} />
            <span>Runtime {socketConnected ? 'connected' : 'reconnecting'}</span>
          </div>
        </div>
        <div className="sidebar-bottom">
          <button className="settings-link" disabled={bootstrapping} onClick={() => setSettingsOpen(true)}>
            <Settings size={15} aria-hidden="true" />
            <span>Settings</span>
          </button>
          {authRequired ? (
            <button className="session-logout" onClick={() => void onSignOut?.()} type="button">
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </button>
          ) : null}
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={() => {
              if (window.matchMedia('(max-width: 680px)').matches) {
                setMobileSidebarOpen((open) => !open);
              } else {
                setDesktopSidebarCollapsed((collapsed) => !collapsed);
              }
            }}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
          <div className="breadcrumbs">
            <span>{selectedProject?.name ?? 'Pico'}</span>
            <b>/</b>
            <strong>{selectedThread?.title ?? 'Your workspace'}</strong>
          </div>
          {selectedThread ? (
            <div className="topbar-status">
              <ExecutorPill thread={selectedThread} connected={executorConnected} error={executorError} />
            </div>
          ) : (
            <div className="topbar-status">
              <span className="connection-label" role="status">
                <i className={socketConnected ? 'online' : 'offline'} />
                {bootstrapping ? 'Loading workspace…' : socketConnected ? 'Runtime connected' : 'Connecting…'}
                {bootstrapping ? <i className="tiny-spinner" aria-hidden="true" /> : null}
              </span>
            </div>
          )}
        </header>

        {showPluginNotice && pluginNoticeKey && pluginInfo ? (
          <div className="banner banner-error plugin-load-notice" role="status">
            <span>A plugin could not be loaded: {pluginInfo.errors.join(' · ')}</span>
            <button type="button" onClick={() => setDismissedPluginNoticeKey(pluginNoticeKey)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {showExecutorNotice && selectedThread && executorError && executorNoticeKey ? (
          <div className="banner banner-error executor-error" role="status">
            <div className="executor-error-copy">
              <strong>
                {executorDetails.compatible === false && executorDetails.updateAvailable
                  ? 'Executor version is incompatible.'
                  : `${executorLabel(selectedThread)} Executor unavailable.`}
              </strong>
              <span>
                {executorDetails.compatible === false && executorDetails.updateAvailable
                  ? 'This Thread is unavailable until its Executor is updated.'
                  : `Continue in a new ${selectedThread.executorKind === 'container' ? 'Host' : 'Container'} Thread in this Project.`}
              </span>
            </div>
            <div className="executor-error-actions">
              {executorDetails.compatible === false && executorDetails.updateAvailable ? (
                <button type="button" onClick={() => setExecutorUpdateOpen(true)}>
                  Update Executor
                </button>
              ) : (
                <button type="button" onClick={startAlternateExecutorThread}>
                  New {selectedThread.executorKind === 'container' ? 'Host' : 'Container'} Thread
                </button>
              )}
              <details className="executor-error-details">
                <summary>Diagnostics</summary>
                <pre>{executorError}</pre>
              </details>
              <button type="button" onClick={() => setDismissedExecutorNoticeKey(executorNoticeKey)}>
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {pauseReason && showPauseNotice && pauseNoticeKey ? (
          <div className="banner banner-notice pause-reason" role="status">
            <span>{pauseReason}</span>
            <button type="button" onClick={() => setDismissedPauseNoticeKey(pauseNoticeKey)}>
              Dismiss
            </button>
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
              <Sparkles size={21} aria-hidden="true" />
            </div>
            <p className="eyebrow">A SMALL PLACE TO THINK WITH AGENTS</p>
            <h1>
              Make room for
              <br />
              <em>good work.</em>
            </h1>
            <p className="welcome-copy">
              {bootstrapping
                ? 'Loading your Projects, Threads, and Runtime settings…'
                : 'Pico keeps your conversations and execution state close, so you can pick up where you left off.'}
            </p>
            {settings?.model || selectedProject ? (
              <div className="welcome-actions">
                {settings?.model && !selectedProject ? (
                  <button
                    className="button button-primary"
                    disabled={bootstrapping}
                    onClick={() => setNewProjectOpen(true)}
                  >
                    Create a Project <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ) : null}
                {selectedProject ? (
                  <button
                    className="button button-soft"
                    disabled={bootstrapping}
                    onClick={() => setNewThreadOpen(true)}
                  >
                    Start a Thread
                  </button>
                ) : null}
              </div>
            ) : null}
            {!settings?.model ? (
              <button className="welcome-settings button button-primary" onClick={() => setSettingsOpen(true)}>
                <Settings size={14} aria-hidden="true" /> Configure a model connection
              </button>
            ) : null}
          </section>
        ) : (
          <>
            <div className="conversation-header">
              <div className="conversation-actions">
                <div className="native-tools-anchor" ref={toolsMenuRef}>
                  <button
                    type="button"
                    className="button button-quiet plugin-action native-tools-button"
                    aria-haspopup="dialog"
                    aria-expanded={toolsMenuOpen}
                    aria-label={`Tools, ${threadTools.filter((tool) => tool.enabled).length} enabled`}
                    onClick={() => {
                      const opening = !toolsMenuOpen;
                      setToolsMenuOpen(opening);
                      if (opening && selectedThreadId) void loadThreadTools(selectedThreadId);
                    }}
                  >
                    <span>Tools</span>
                    <span className="toolbar-count-badge" aria-hidden="true">
                      {threadTools.filter((tool) => tool.enabled).length}
                    </span>
                  </button>
                  {toolsMenuOpen ? (
                    <div className="native-tools-popover" role="dialog" aria-label="Thread tools">
                      <div className="native-tools-heading">
                        <div>
                          <strong>Available tools</strong>
                          <span>Choose which tools this Thread can use.</span>
                        </div>
                        <button
                          type="button"
                          className="native-tools-refresh"
                          disabled={threadToolsLoading}
                          onClick={() => selectedThreadId && void loadThreadTools(selectedThreadId)}
                        >
                          {threadToolsLoading ? 'Loading…' : 'Refresh'}
                        </button>
                      </div>
                      {threadToolsError ? (
                        <p className="native-tools-error" role="status">
                          {threadToolsError}
                        </p>
                      ) : null}
                      {threadToolsLoading && threadTools.length === 0 ? (
                        <p className="native-tools-empty">Loading Thread tools…</p>
                      ) : threadTools.length === 0 ? (
                        <p className="native-tools-empty">No tools are available in this Thread.</p>
                      ) : (
                        <div className="native-tools-list">
                          {threadTools.map((tool) => (
                            <div className="native-tool-row" key={tool.name}>
                              <div className="native-tool-copy">
                                <div className="native-tool-title">
                                  <strong>{tool.name}</strong>
                                  <span>{tool.source === 'runtime' ? 'Runtime' : 'Executor'}</span>
                                </div>
                                <p>{tool.description}</p>
                              </div>
                              <button
                                type="button"
                                className={`native-tool-switch ${tool.enabled ? 'is-enabled' : ''}`}
                                role="switch"
                                aria-checked={tool.enabled}
                                aria-label={`${tool.enabled ? 'Disable' : 'Enable'} ${tool.name}`}
                                disabled={savingToolName !== null}
                                onClick={() => void toggleThreadTool(tool)}
                              >
                                <span />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="button button-quiet plugin-action"
                  title="Thread info"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setThreadTitleDraft(selectedThread.title);
                    setThreadInfoError('');
                    setThreadInfoOpen(true);
                    setToolsMenuOpen(false);
                  }}
                >
                  <Info size={14} aria-hidden="true" />
                  Info
                </button>
                {toolbarContributions.map((item) => (
                  <PluginContributionView
                    key={pluginUiContributionKey(item)}
                    item={item}
                    pluginProps={pluginUiContext}
                    events={pluginEvents}
                    isRegisteredPage={isRegisteredPluginPage}
                    runCommand={runPluginCommand}
                    onActivate={executeContribution}
                    disabled={busy || selectedThreadSending}
                    buttonClassName="button button-quiet plugin-action"
                  />
                ))}
                {selectedThread.executorKind !== 'runtime' ? (
                  <button
                    type="button"
                    className="button button-quiet plugin-action executor-update-toolbar"
                    onClick={() => {
                      setExecutorUpdateError('');
                      setExecutorUpdateOpen(true);
                    }}
                  >
                    Update
                  </button>
                ) : null}
              </div>
            </div>

            <div className="thread-scroll-container">
              <div
                id="thread-message-scroll"
                className="conversation-scroll conversation-scroll-follow-latest"
                ref={listRef}
                role="region"
                aria-label="Thread messages"
                tabIndex={0}
                onScroll={(event) => {
                  const follow = isNearScrollEnd(event.currentTarget);
                  followLatest.current = follow;
                  event.currentTarget.classList.toggle('conversation-scroll-follow-latest', follow);
                  syncThreadScrollbar();
                }}
              >
                <ThinkingDisclosureContext.Provider value={thinkingDisclosure}>
                  <div className="timeline">
                    {activeSnapshot?.hasEarlierRecords ? (
                      <button
                        className="history-load-more"
                        type="button"
                        disabled={loadingEarlierThreadIds.has(selectedThread.id)}
                        onClick={() => void loadEarlierRecords()}
                      >
                        {loadingEarlierThreadIds.has(selectedThread.id)
                          ? 'Loading earlier messages…'
                          : 'Load earlier history'}
                      </button>
                    ) : null}
                    {timeline.map((item) =>
                      item.type === 'group' ? (
                        <ModelExecutionBranchGroup
                          key={`group:${item.group.projectionThrough}`}
                          group={item.group}
                          threadId={selectedThread.id}
                          unavailableModelExecutionIds={unavailableModelExecutionIds}
                          executions={executions}
                          records={records}
                          renderTool={renderToolView}
                          onRetryModelExecution={retryModelExecution}
                          retryDisabled={currentState === 'running' || currentState === 'pausing'}
                        />
                      ) : item.record.kind === 'message' ? (
                        <MessageBubble
                          key={item.record.id}
                          record={item.record}
                          thread={selectedThread}
                          threadId={selectedThread.id}
                          modelExecutionGroups={[]}
                          unavailableModelExecutionIds={unavailableModelExecutionIds}
                          executions={executions}
                          records={records}
                          renderTool={renderToolView}
                          onOpenThread={chooseThread}
                          onRetryModelExecution={retryModelExecution}
                          retryDisabled={currentState === 'running' || currentState === 'pausing'}
                        />
                      ) : (
                        <AssistantBubble
                          key={item.record.id}
                          record={item.record}
                          executions={executions}
                          records={records}
                          threadId={selectedThread.id}
                          renderTool={renderToolView}
                        />
                      ),
                    )}
                    <AssistantDraftMessage threadId={selectedThread.id} />
                    {renderedRecords.length === 0 ? (
                      <EmptyThreadPlaceholder
                        threadId={selectedThread.id}
                        executorName={executorLabel(selectedThread)}
                      />
                    ) : null}
                  </div>
                </ThinkingDisclosureContext.Provider>
              </div>
              <div
                ref={threadScrollbarRef}
                className="thread-scrollbar"
                role="scrollbar"
                aria-label="Thread scroll position"
                aria-controls="thread-message-scroll"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  threadScrollbar.maxScroll > 0
                    ? Math.round((threadScrollbar.scrollTop / threadScrollbar.maxScroll) * 100)
                    : 0
                }
                aria-valuetext={`${threadScrollbar.maxScroll > 0 ? Math.round((threadScrollbar.scrollTop / threadScrollbar.maxScroll) * 100) : 0}%`}
                aria-hidden={threadScrollbar.maxScroll === 0}
                tabIndex={threadScrollbar.maxScroll > 0 ? 0 : -1}
                onPointerDown={(event) => {
                  if (threadScrollbar.maxScroll === 0) return;
                  const thumb = threadScrollbarThumbRef.current;
                  const onThumb = thumb?.contains(event.target as Node) ?? false;
                  const pointerOffset = onThumb
                    ? event.clientY - thumb!.getBoundingClientRect().top
                    : (thumb?.clientHeight ?? 0) / 2;
                  threadScrollbarDrag.current = { pointerId: event.pointerId, pointerOffset };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  if (!onThumb) scrollThreadFromPointer(event.clientY, pointerOffset);
                  event.preventDefault();
                }}
                onPointerMove={(event) => {
                  const drag = threadScrollbarDrag.current;
                  if (drag?.pointerId === event.pointerId) {
                    scrollThreadFromPointer(event.clientY, drag.pointerOffset);
                  }
                }}
                onPointerUp={(event) => {
                  if (threadScrollbarDrag.current?.pointerId === event.pointerId) {
                    threadScrollbarDrag.current = null;
                  }
                }}
                onPointerCancel={() => {
                  threadScrollbarDrag.current = null;
                }}
                onKeyDown={(event) => {
                  const scroll = listRef.current;
                  if (!scroll) return;
                  const page = Math.max(40, scroll.clientHeight);
                  let nextScrollTop: number;
                  switch (event.key) {
                    case 'ArrowDown':
                      nextScrollTop = scroll.scrollTop + 40;
                      break;
                    case 'ArrowUp':
                      nextScrollTop = scroll.scrollTop - 40;
                      break;
                    case 'PageDown':
                      nextScrollTop = scroll.scrollTop + page;
                      break;
                    case 'PageUp':
                      nextScrollTop = scroll.scrollTop - page;
                      break;
                    case 'Home':
                      nextScrollTop = 0;
                      break;
                    case 'End':
                      nextScrollTop = threadScrollbar.maxScroll;
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  scroll.scrollTop = nextScrollTop;
                }}
              >
                <div
                  ref={threadScrollbarThumbRef}
                  className="thread-scrollbar-thumb"
                  style={{
                    height: `${threadScrollbar.thumbHeight}px`,
                    transform: `translateY(${threadScrollbar.thumbTop}px)`,
                  }}
                />
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
              <div className="composer-entry-row">
                <div
                  className="composer-box"
                  style={
                    {
                      '--pico-composer-control-height': `${PLUGIN_COMPOSER_CONTROL_HEIGHT_PX}px`,
                    } as CSSProperties
                  }
                >
                  <textarea
                    ref={messageTextareaRef}
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
                    rows={1}
                    aria-label="Message"
                  />
                  <div className="composer-footer">
                    {pluginUiContext && composerModelContributions.length > 0 ? (
                      <div className="composer-plugin-controls" aria-label="Model controls">
                        {composerModelContributions.map((item) => {
                          return item.pluginId && item.entry && item.component ? (
                            <PluginWebView
                              key={pluginUiContributionKey(item)}
                              pluginId={item.pluginId}
                              entry={item.entry}
                              viewType="component"
                              viewId={item.component}
                              uiSlot={item.slot}
                              controlLabel={item.label}
                              controlClassName="composer-plugin-action"
                              supportsPopover={item.supportsPopover}
                              externalAuthOrigins={item.externalAuthOrigins}
                              events={pluginEvents}
                              {...pluginUiContext}
                              isRegisteredPage={isRegisteredPluginPage}
                              runCommand={runPluginCommand}
                            />
                          ) : (
                            <span className="field-note" key={pluginUiContributionKey(item)}>
                              {item.label} requires a plugin Web UI entry.
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="composer-footer-actions">
                      {composerActions.map((item) => (
                        <PluginContributionView
                          key={pluginUiContributionKey(item)}
                          item={item}
                          pluginProps={pluginUiContext}
                          events={pluginEvents}
                          isRegisteredPage={isRegisteredPluginPage}
                          runCommand={runPluginCommand}
                          onActivate={executeContribution}
                          disabled={busy || selectedThreadSending}
                          buttonClassName="composer-plugin-action"
                        />
                      ))}
                      <ThreadStateControl
                        state={currentState}
                        canInterrupt={threadCanBeInterrupted(currentState, executions)}
                        onAction={(action) => void controlThread(action)}
                      />
                      <button
                        className="send-button"
                        aria-label="Send message"
                        disabled={
                          !draft.trim() ||
                          busy ||
                          selectedThreadSending ||
                          (selectedThread.executorKind !== 'runtime' && executorConnected !== true)
                        }
                        title={
                          selectedThread.executorKind !== 'runtime' && executorConnected !== true
                            ? executorConnected === null
                              ? 'Checking Executor connection…'
                              : 'Executor disconnected'
                            : 'Send message'
                        }
                        onClick={() => void sendMessage()}
                      >
                        {selectedThreadSending ? <i className="tiny-spinner" /> : <Send size={15} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="composer-caption composer-meta">
                {pluginUiContext &&
                  composerStatusContributions.map((item) =>
                    item.pluginId && item.entry && item.component ? (
                      <PluginWebView
                        key={pluginUiContributionKey(item)}
                        pluginId={item.pluginId}
                        entry={item.entry}
                        viewType="component"
                        viewId={item.component}
                        uiSlot={item.slot}
                        events={pluginEvents}
                        {...pluginUiContext}
                        isRegisteredPage={isRegisteredPluginPage}
                        runCommand={runPluginCommand}
                      />
                    ) : null,
                  )}
                <div className="composer-status-info">
                  {activeSnapshot?.thread.id === selectedThread.id && activeSnapshot.modelSelection.model ? (
                    <span className="composer-model-name">{activeSnapshot.modelSelection.model}</span>
                  ) : settings?.model ? (
                    <span className="composer-model-name">{settings.model}</span>
                  ) : (
                    <button className="setup-caption composer-model-name" onClick={() => setSettingsOpen(true)}>
                      Choose a model <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  )}
                  {activeSnapshot?.thread.id === selectedThread.id && contextManagement ? (
                    <span
                      className="composer-context-usage"
                      title={
                        activeSnapshot.contextUsage.source === 'provider'
                          ? 'Provider-reported input tokens for the latest model request.'
                          : activeSnapshot.contextUsage.source === 'provider+estimate'
                            ? 'Provider-reported input tokens for the latest model request plus an estimate of newer conversation content. System prompt and tool schemas may not be included.'
                            : 'Estimated from conversation content because provider input usage is unavailable. System prompt and tool schemas may not be included.'
                      }
                      aria-label={`Context usage ${formatTokenCount(activeSnapshot.contextUsage.inputTokens)} of ${formatTokenCount(contextManagement.contextWindowTokens)} tokens`}
                    >
                      {formatTokenCount(activeSnapshot.contextUsage.inputTokens)}/
                      {formatTokenCount(contextManagement.contextWindowTokens)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {executorUpdateOpen && selectedThread && selectedThread.executorKind !== 'runtime' ? (
        <Modal
          title="Executor update"
          contextLabel="PICO · EXECUTOR"
          onClose={() => {
            if (!executorUpdateBusy) setExecutorUpdateOpen(false);
          }}
          error={executorUpdateError}
          onDismissError={() => setExecutorUpdateError('')}
        >
          <div className="executor-update-content">
            {executorConnected === null ? (
              <p>Checking the Executor version…</p>
            ) : (
              <p>
                {executorDetails.executorVersion
                  ? `Installed version: ${executorDetails.executorVersion}.`
                  : 'Could not read the installed Executor version.'}
                {executorDetails.targetVersion ? ` Available version: ${executorDetails.targetVersion}.` : ''}
              </p>
            )}
            {executorConnected === null ? null : executorConnected === false && !executorDetails.updateAvailable ? (
              <p className="executor-update-warning">
                Could not check the Executor version: {executorError ?? 'the Executor is disconnected.'}
              </p>
            ) : executorDetails.compatible === false ? (
              <p className="executor-update-warning">
                This version is incompatible. The Executor remains disconnected until it is updated.
              </p>
            ) : executorDetails.updateAvailable ? (
              <p>A newer Executor version is available. You can close this window and continue using the Thread.</p>
            ) : (
              <p>The Executor is up to date.</p>
            )}
            {executorDetails.updateAvailable && executorDetails.updateSupported === false ? (
              <p>
                Update this standalone Executor from its installation machine, then check again here. This installation
                cannot update it through the current connection.
              </p>
            ) : null}
            <div className="executor-update-actions">
              {executorDetails.updateAvailable && executorDetails.updateSupported !== false ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={executorUpdateBusy}
                  onClick={() => void updateExecutor()}
                >
                  {executorUpdateBusy ? 'Updating…' : 'Update Executor'}
                </button>
              ) : null}
              <button
                type="button"
                className="button button-quiet"
                disabled={executorUpdateBusy}
                onClick={() => void recheckExecutor()}
              >
                {executorUpdateBusy ? 'Checking…' : 'Check again'}
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={executorUpdateBusy}
                onClick={() => setExecutorUpdateOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {settingsOpen ? (
        <Modal
          title={
            developerMenuOpen
              ? 'Developer'
              : archivedThreadsOpen
                ? 'Archived Threads'
                : memoryManagerOpen
                  ? 'Memory'
                  : pluginManagerOpen
                    ? 'Plugins'
                    : contextManagerOpen
                      ? 'Context management'
                      : pluginPageSelection
                        ? 'Plugin settings'
                        : 'Model connections'
          }
          onClose={() => {
            setSettingsOpen(false);
            setPluginPageSelection(null);
            setContextManagerOpen(false);
            setPluginManagerOpen(false);
            setMemoryManagerOpen(false);
            setArchivedThreadsOpen(false);
            setDeveloperMenuOpen(false);
          }}
          error={error}
          onDismissError={() => setError('')}
        >
          <nav className="plugin-settings-pages" aria-label="Settings pages">
            {pluginInfo ? (
              <>
                <button
                  type="button"
                  className={`button ${!pluginPageSelection && !contextManagerOpen && !pluginManagerOpen && !memoryManagerOpen && !archivedThreadsOpen && !developerMenuOpen ? 'button-soft' : 'button-quiet'}`}
                  onClick={() => {
                    setPluginPageSelection(null);
                    setContextManagerOpen(false);
                    setPluginManagerOpen(false);
                    setMemoryManagerOpen(false);
                    setArchivedThreadsOpen(false);
                    setDeveloperMenuOpen(false);
                  }}
                >
                  Provider
                </button>
                <button
                  type="button"
                  className={`button ${contextManagerOpen ? 'button-soft' : 'button-quiet'}`}
                  onClick={() => {
                    setPluginPageSelection(null);
                    setContextManagerOpen(true);
                    setPluginManagerOpen(false);
                    setMemoryManagerOpen(false);
                    setArchivedThreadsOpen(false);
                    setDeveloperMenuOpen(false);
                  }}
                >
                  Context management
                </button>
                <button
                  type="button"
                  className={`button ${pluginManagerOpen ? 'button-soft' : 'button-quiet'}`}
                  onClick={() => {
                    setPluginPageSelection(null);
                    setContextManagerOpen(false);
                    setPluginManagerOpen(true);
                    setMemoryManagerOpen(false);
                    setArchivedThreadsOpen(false);
                    setDeveloperMenuOpen(false);
                  }}
                >
                  Plugins
                </button>
                {memoryPages.length > 0 ? (
                  <button
                    type="button"
                    className={`button ${memoryManagerOpen ? 'button-soft' : 'button-quiet'}`}
                    onClick={() => {
                      setPluginManagerOpen(false);
                      setPluginPageSelection(null);
                      setContextManagerOpen(false);
                      setMemoryManagerOpen(true);
                      setArchivedThreadsOpen(false);
                      setDeveloperMenuOpen(false);
                    }}
                  >
                    Memory
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`button ${archivedThreadsOpen ? 'button-soft' : 'button-quiet'}`}
                  onClick={() => {
                    setPluginManagerOpen(false);
                    setPluginPageSelection(null);
                    setContextManagerOpen(false);
                    setMemoryManagerOpen(false);
                    setArchivedThreadsOpen(true);
                    setDeveloperMenuOpen(false);
                  }}
                >
                  Archived Threads
                </button>
                {pluginInfo.pages
                  .filter((page) => page.group !== 'memory')
                  .map((page) => (
                    <button
                      type="button"
                      className={`button ${!contextManagerOpen && !pluginManagerOpen && !memoryManagerOpen && !archivedThreadsOpen && !developerMenuOpen && pluginPageSelection?.pluginId === page.pluginId && pluginPageSelection.pageId === page.id ? 'button-soft' : 'button-quiet'}`}
                      key={`${page.pluginId}:${page.id}`}
                      onClick={() => {
                        setPluginManagerOpen(false);
                        setContextManagerOpen(false);
                        setMemoryManagerOpen(false);
                        setArchivedThreadsOpen(false);
                        setDeveloperMenuOpen(false);
                        setPluginPageSelection({ pluginId: page.pluginId, pageId: page.id });
                      }}
                      title={page.description}
                    >
                      {page.label}
                    </button>
                  ))}
              </>
            ) : null}
            <button
              type="button"
              className={`button ${developerMenuOpen ? 'button-soft' : 'button-quiet'}`}
              onClick={() => {
                setPluginPageSelection(null);
                setContextManagerOpen(false);
                setPluginManagerOpen(false);
                setMemoryManagerOpen(false);
                setArchivedThreadsOpen(false);
                setDeveloperMenuOpen(true);
              }}
            >
              Developer
            </button>
          </nav>
          {developerMenuOpen ? (
            <DeveloperSettings
              plugins={pluginInfo?.plugins ?? []}
              catalog={pluginInfo?.catalog ?? []}
              pluginErrors={pluginInfo?.errors ?? []}
            />
          ) : archivedThreadsOpen ? (
            <section className="plugin-settings-page archived-threads-page" aria-label="Archived Threads">
              <p className="form-intro">Archived Threads are hidden from the active project lists.</p>
              <p className="field-note archived-threads-retention">
                Delete hides a Thread from Pico. Its history records remain retained.
              </p>
              {archivedThreadsLoading && archivedThreads.length === 0 ? (
                <p className="field-note">Loading archived Threads…</p>
              ) : archivedThreads.length === 0 ? (
                <p className="field-note">No archived Threads.</p>
              ) : (
                <div className="archived-thread-list">
                  {archivedThreads.map((thread) => {
                    const projectName = projects.find((project) => project.id === thread.projectId)?.name ?? 'Project';
                    return (
                      <article className="archived-thread-card" key={thread.id}>
                        <div className="archived-thread-copy">
                          <strong>{thread.title}</strong>
                          <span>{projectName}</span>
                          <small>
                            {executorLabel(thread)} · {thread.workspacePath || 'No workspace'}
                          </small>
                          {thread.archivedAt ? (
                            <small>Archived {new Date(thread.archivedAt).toLocaleString()}</small>
                          ) : null}
                        </div>
                        <div className="archived-thread-actions">
                          <button
                            type="button"
                            className="button button-quiet"
                            disabled={archivedThreadActionId !== null}
                            onClick={() => void restoreArchivedThread(thread)}
                          >
                            <RotateCcw size={12} aria-hidden="true" />
                            Restore
                          </button>
                          <button
                            type="button"
                            className="button button-quiet archived-thread-delete"
                            disabled={archivedThreadActionId !== null}
                            onClick={() => void deleteArchivedThread(thread)}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                            Delete
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : contextManagerOpen ? (
            <form
              className="form-stack context-management-form"
              onSubmit={(event) => void saveContextManagementSettings(event)}
            >
              <p className="form-intro">
                Pico will compact Runtime Threads before a model request when their context reaches the threshold.
              </p>
              <label>
                Context window (tokens)
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={contextManagementForm.contextWindowTokens}
                  onChange={(event) =>
                    setContextManagementForm((form) => ({ ...form, contextWindowTokens: event.target.value }))
                  }
                />
              </label>
              <label>
                Compaction threshold (tokens)
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={contextManagementForm.compactionThresholdTokens}
                  onChange={(event) =>
                    setContextManagementForm((form) => ({ ...form, compactionThresholdTokens: event.target.value }))
                  }
                />
              </label>
              <label>
                Recent history kept after compaction (tokens)
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={contextManagementForm.keepRecentTokens}
                  onChange={(event) =>
                    setContextManagementForm((form) => ({ ...form, keepRecentTokens: event.target.value }))
                  }
                />
              </label>
              <p className="field-note">
                Defaults are a 272,000-token context window, a 256,000-token compaction threshold, and 16,000 tokens
                of recent history. Pico keeps complete model invocations until this recent-history budget is met, with
                at least two invocations retained. It uses differences between provider input-token reports and a
                conservative estimate of the retained invocation content.
              </p>
              <div className="form-actions">
                <span />
                <button className="button button-primary" disabled={settingsSaving || !contextManagement}>
                  {settingsSaving ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </form>
          ) : pluginManagerOpen ? (
            <section className="plugin-settings-page plugin-manager" aria-label="Plugin management">
              <p className="form-intro">
                Turning a plugin off unloads it. Turn it back on to reload it; plugin state is preserved.
              </p>
              <div className="plugin-manager-list">
                {pluginInfo?.catalog.map((plugin) => (
                  <article className="plugin-manager-card" key={plugin.id}>
                    <div className="plugin-manager-copy">
                      <div className="plugin-manager-title-row">
                        <h3>{plugin.name}</h3>
                        <span className={`plugin-manager-status ${plugin.loaded ? 'is-loaded' : ''}`}>
                          {plugin.loaded ? 'Loaded' : plugin.enabled ? 'Load failed' : 'Disabled'}
                        </span>
                      </div>
                      <p>
                        {plugin.id} · v{plugin.version} · {plugin.source}
                      </p>
                      {plugin.error ? <p className="plugin-manager-error">{plugin.error}</p> : null}
                      {plugin.required ? <p className="field-note">Required by Pico</p> : null}
                    </div>
                    <div className="plugin-manager-actions">
                      <button
                        type="button"
                        className={`native-tool-switch ${plugin.enabled ? 'is-enabled' : ''}`}
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                        title={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                        disabled={plugin.required || pluginActionId !== null}
                        onClick={() => void updatePluginEnabled(plugin.id, !plugin.enabled)}
                      >
                        <span />
                      </button>
                    </div>
                  </article>
                ))}
                {pluginInfo?.catalog.length === 0 ? <p className="field-note">No runtime plugins were found.</p> : null}
              </div>
            </section>
          ) : memoryManagerOpen ? (
            <section className="plugin-settings-page memory-settings-page" aria-label="Memory management">
              {selectedMemoryPage && pluginUiContext ? (
                <PluginWebView
                  key={`${selectedMemoryPage.pluginId}:${selectedMemoryPage.entry}:${selectedMemoryPage.id}`}
                  pluginId={selectedMemoryPage.pluginId}
                  entry={selectedMemoryPage.entry}
                  viewType="page"
                  viewId={selectedMemoryPage.id}
                  externalAuthOrigins={selectedMemoryPage.externalAuthOrigins}
                  {...pluginUiContext}
                  isRegisteredPage={isRegisteredPluginPage}
                  runCommand={runPluginCommand}
                />
              ) : (
                <p className="field-note">Enable Global Memory in Plugins to manage global memories.</p>
              )}
            </section>
          ) : pluginPageSelection ? (
            <section className="plugin-settings-page">
              {selectedPluginPage && pluginUiContext ? (
                <PluginWebView
                  key={`${selectedPluginPage.pluginId}:${selectedPluginPage.entry}:${selectedPluginPage.id}`}
                  pluginId={selectedPluginPage.pluginId}
                  entry={selectedPluginPage.entry}
                  viewType="page"
                  viewId={selectedPluginPage.id}
                  externalAuthOrigins={selectedPluginPage.externalAuthOrigins}
                  {...pluginUiContext}
                  isRegisteredPage={isRegisteredPluginPage}
                  runCommand={runPluginCommand}
                />
              ) : (
                <p className="field-note">
                  This plugin page is registered by {selectedPluginPage?.pluginId ?? pluginPageSelection.pluginId}, but
                  its Web UI entry is not available.
                </p>
              )}
            </section>
          ) : (
            <>
              <form className="form-stack" onSubmit={(event) => void saveModelSettings(event)}>
                <p className="form-intro">Choose how this Runtime connects to its model provider.</p>
                <label>
                  Provider
                  <PluginUiSelect
                    label="Provider"
                    value={modelForm.provider}
                    compact={false}
                    options={
                      pluginInfo?.providers.map((provider) => ({ value: provider.id, label: provider.label })) ?? []
                    }
                    onChange={(provider) =>
                      setModelForm((form) => ({
                        ...form,
                        provider,
                        model: settings?.modelsByProvider?.[provider] ?? '',
                      }))
                    }
                  />
                </label>
                {modelForm.provider === 'openai-compatible' ? (
                  <>
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
                  </>
                ) : (
                  <p className="field-note">
                    Provider-specific sign-in and model choices are contributed by the provider plugin. Choose its
                    controls below the message composer, or open its settings page above. Save to use this provider.
                  </p>
                )}
                <div className="form-actions">
                  {modelForm.provider === 'openai-compatible' ? (
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => void clearApiKey()}
                      disabled={!settings?.hasApiKey}
                    >
                      Clear saved key
                    </button>
                  ) : (
                    <span />
                  )}
                  <button className="button button-primary" disabled={settingsSaving}>
                    {settingsSaving ? 'Saving…' : 'Save settings'}
                  </button>
                </div>
              </form>
            </>
          )}
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
                value={newProjectName || suggestedNewProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
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
              <button className="button button-primary" disabled={busy || !newProjectWorkspacePath.trim()}>
                {busy ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {threadInfoOpen && selectedThread ? (
        <Modal
          title="Thread info"
          contextLabel="PICO · THREAD DETAILS"
          onClose={() => setThreadInfoOpen(false)}
          error={threadInfoError}
          onDismissError={() => setThreadInfoError('')}
        >
          <form className="form-stack" onSubmit={(event) => void updateThreadTitle(event)}>
            <div className="thread-info-name-field">
              <label htmlFor="thread-info-name">Thread name</label>
              <div className="thread-info-name-row">
                <input
                  id="thread-info-name"
                  value={threadTitleDraft}
                  onChange={(event) => setThreadTitleDraft(event.target.value)}
                  autoFocus
                />
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={threadTitleSaving || !threadTitleDraft.trim()}
                >
                  {threadTitleSaving ? 'Saving…' : 'Save name'}
                </button>
              </div>
            </div>
            <div className="thread-info-details">
              <div>
                <span>Project</span>
                <strong>{selectedProject?.name ?? '—'}</strong>
              </div>
              <div>
                <span>Executor</span>
                <strong>{executorLabel(selectedThread)}</strong>
              </div>
              <div>
                <span>Workspace folder</span>
                <code>{selectedThread.workspacePath || 'No workspace'}</code>
              </div>
            </div>
            <div className="thread-info-secondary-actions">
              <button
                type="button"
                className="button button-quiet thread-info-archive"
                disabled={threadTitleSaving || Boolean(selectedThread.archivedAt) || Boolean(selectedThread.deletedAt)}
                onClick={() => void archiveSelectedThread()}
              >
                <Archive size={13} aria-hidden="true" />
                Archive Thread
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={threadTitleSaving}
                onClick={() => setThreadInfoOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {newThreadOpen ? (
        <Modal
          title="Start a Thread"
          contextLabel="PICO · NEW THREAD"
          onClose={() => setNewThreadOpen(false)}
          error={error}
          onDismissError={() => setError('')}
        >
          <form className="form-stack" onSubmit={(event) => void createThread(event)}>
            <p className="form-intro">Choose how this Thread runs. Its execution mode stays fixed for its lifetime.</p>
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
                className={`executor-choice ${newThreadExecutor === 'runtime' ? 'chosen' : ''}`}
                onClick={() => setNewThreadExecutor('runtime')}
              >
                <span className="choice-icon">
                  <MessageSquare size={15} aria-hidden="true" />
                </span>
                <strong>Chat</strong>
                <small>Runtime thread tools, without a workspace or shell</small>
                <i>{newThreadExecutor === 'runtime' ? 'Selected' : 'Choose'}</i>
              </button>
              <button
                type="button"
                className={`executor-choice ${newThreadExecutor === 'container' ? 'chosen' : ''}`}
                onClick={() => setNewThreadExecutor('container')}
              >
                <span className="choice-icon">
                  <Box size={15} aria-hidden="true" />
                </span>
                <strong>Container</strong>
                <small>Isolated workspace, root inside the container</small>
                <i>{newThreadExecutor === 'container' ? 'Selected' : 'Choose'}</i>
              </button>
              <button
                type="button"
                className={`executor-choice ${newThreadExecutor === 'host' ? 'chosen' : ''}`}
                onClick={() => setNewThreadExecutor('host')}
              >
                <span className="choice-icon">
                  <Monitor size={15} aria-hidden="true" />
                </span>
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
              >
                <span className="choice-icon">
                  <Cloud size={15} aria-hidden="true" />
                </span>
                <strong>Remote</strong>
                <small>Configure a machine and run tools there</small>
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
                <p className="form-intro">Connect a Remote Executor below to use it for this Thread.</p>
              )
            ) : null}
            <div className="form-actions">
              <span className="field-note">
                {newThreadExecutor === 'runtime'
                  ? 'Chat mode can coordinate Threads but cannot access project files or run shell commands.'
                  : newThreadExecutor === 'container'
                    ? 'Container is the default and runs tools inside the selected workspace.'
                    : newThreadExecutor === 'remote'
                      ? 'Tools run on the selected Remote Executor and use a workspace under its configured root.'
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
          {newThreadExecutor === 'remote' ? (
            <section className="form-stack remote-connections-section">
              <div>
                <p className="eyebrow">REMOTE EXECUTOR</p>
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
              <form
                className="form-stack remote-connection-add-form"
                onSubmit={(event) => void addRemoteExecutorConnection(event)}
              >
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
                  <span className="field-note">
                    Use an address reachable from the Pico Runtime, not the Web UI address.
                  </span>
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
                <div className="form-actions remote-executor-form-actions">
                  <span className="field-note remote-executor-footnote">
                    Remote workspaces are limited to the Executor’s configured root.
                  </span>
                  <button className="button button-primary" disabled={remoteConnectionSaving}>
                    {remoteConnectionSaving ? 'Connecting…' : 'Connect Executor'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

function MessageBubble({
  record,
  thread,
  threadId,
  modelExecutionGroups,
  unavailableModelExecutionIds,
  executions,
  records,
  renderTool,
  onOpenThread,
  onRetryModelExecution,
  retryDisabled,
}: {
  record: CanonicalRecord;
  thread: Thread;
  threadId: string;
  modelExecutionGroups: ModelExecutionGroup[];
  unavailableModelExecutionIds: ReadonlySet<string>;
  executions: Execution[];
  records: CanonicalRecord[];
  renderTool(call: ToolCall, execution: Execution | undefined, result: ToolResultPayload | undefined): ReactNode;
  onOpenThread(id: string): void;
  onRetryModelExecution(threadId: string, executionId: string): Promise<Execution>;
  retryDisabled: boolean;
}) {
  const message = recordPayload<MessagePayload>(record);
  const incoming = message.source !== 'user';
  const messageSource =
    thread.parentThreadId && message.senderThreadId === thread.parentThreadId
      ? 'Parent Thread'
      : message.source === 'child'
        ? 'Child Thread'
        : 'Agent';
  return (
    <div
      id={`canonical-message-${record.seq}`}
      className={`user-message ${incoming ? 'incoming-message' : ''} ${
        modelExecutionGroups.length > 0 ? 'has-model-execution-groups' : ''
      }`}
    >
      <div className="message-body">
        <div className="message-author">
          {incoming ? (
            <>
              {messageSource} <span>·</span> {message.senderLabel ?? 'another Thread'}
            </>
          ) : (
            'You'
          )}
          {incoming && message.senderThreadId ? (
            <button className="inline-link" onClick={() => onOpenThread(message.senderThreadId!)}>
              Open Thread <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="user-bubble">{message.content}</div>
        {modelExecutionGroups.map((group) => (
          <ModelExecutionBranchGroup
            key={`${threadId}:${group.projectionThrough}`}
            group={group}
            threadId={threadId}
            unavailableModelExecutionIds={unavailableModelExecutionIds}
            executions={executions}
            records={records}
            renderTool={renderTool}
            onRetryModelExecution={onRetryModelExecution}
            retryDisabled={retryDisabled}
          />
        ))}
      </div>
      <div className="user-avatar">
        {incoming ? <GitBranch size={13} aria-hidden="true" /> : <UserRound size={13} aria-hidden="true" />}
      </div>
    </div>
  );
}

function useAssistantDraftContent(threadId: string) {
  const subscribe = useCallback(
    (listener: () => void) => assistantDraftStore.subscribeContent(threadId, listener),
    [threadId],
  );
  const getSnapshot = useCallback(() => assistantDraftStore.getContent(threadId), [threadId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function useAssistantExecutionId(threadId: string) {
  const subscribe = useCallback(
    (listener: () => void) => assistantDraftStore.subscribeExecution(threadId, listener),
    [threadId],
  );
  const getSnapshot = useCallback(() => assistantDraftStore.getExecutionId(threadId), [threadId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function AssistantDraftMessage({ threadId }: { threadId: string }) {
  const draft = useAssistantDraftContent(threadId);
  if (!draft) return null;
  return (
    <div className="assistant-message draft-message">
      <div className="assistant-avatar">
        <Sparkles size={13} aria-hidden="true" />
      </div>
      <div className="message-body">
        <div className="message-author">
          Pico <span className="typing-label">writing</span>
        </div>
        {draft.reasoningSummary ? <Reasoning text={draft.reasoningSummary} /> : null}
        {draft.text ? <Markdown>{draft.text}</Markdown> : null}
        <AssistantToolPreviewSection threadId={threadId} executionId={draft.executionId} />
      </div>
    </div>
  );
}

const AssistantToolPreviewSection = memo(function AssistantToolPreviewSection({
  threadId,
  executionId,
}: {
  threadId: string;
  executionId: string;
}) {
  const subscribe = useCallback(
    (listener: () => void) => assistantDraftStore.subscribeToolSlots(threadId, executionId, listener),
    [executionId, threadId],
  );
  const getSnapshot = useCallback(
    () => assistantDraftStore.getToolSlots(threadId, executionId),
    [executionId, threadId],
  );
  const slots = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <>
      {slots.map((slot) => (
        <AssistantToolPreviewCard
          key={`${executionId}:${slot.index}`}
          threadId={threadId}
          executionId={executionId}
          index={slot.index}
        />
      ))}
      {!slots.some((slot) => slot.name === 'shell') ? <span className="cursor-block" /> : null}
    </>
  );
});

const AssistantToolPreviewCard = memo(function AssistantToolPreviewCard({
  threadId,
  executionId,
  index,
}: {
  threadId: string;
  executionId: string;
  index: number;
}) {
  const subscribe = useCallback(
    (listener: () => void) => assistantDraftStore.subscribeToolPreview(threadId, executionId, index, listener),
    [executionId, index, threadId],
  );
  const getSnapshot = useCallback(
    () => assistantDraftStore.getToolPreview(threadId, executionId, index),
    [executionId, index, threadId],
  );
  const call = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!call) return null;
  return (
    <ToolCard
      call={{
        id: call.id ?? `preview:${executionId}:${call.index}`,
        name: call.name ?? 'Tool call',
        arguments: {},
      }}
      execution={undefined}
      result={undefined}
      preview={{ argumentsText: call.argumentsText }}
    />
  );
});

function EmptyThreadPlaceholder({ threadId, executorName }: { threadId: string; executorName: string }) {
  const executionId = useAssistantExecutionId(threadId);
  if (executionId) return null;
  return (
    <div className="empty-thread">
      <div className="empty-orbit">
        <Sparkles size={19} aria-hidden="true" />
      </div>
      <h2>A fresh Thread</h2>
      <p>Send a message to begin. This Thread is bound to the {executorName} environment.</p>
    </div>
  );
}

function ModelExecutionBranchGroup({
  group,
  threadId,
  unavailableModelExecutionIds,
  executions,
  records,
  renderTool,
  onRetryModelExecution,
  retryDisabled,
}: {
  group: ModelExecutionGroup;
  threadId: string;
  unavailableModelExecutionIds: ReadonlySet<string>;
  executions: Execution[];
  records: CanonicalRecord[];
  renderTool(call: ToolCall, execution: Execution | undefined, result: ToolResultPayload | undefined): ReactNode;
  onRetryModelExecution(threadId: string, executionId: string): Promise<Execution>;
  retryDisabled: boolean;
}) {
  const draftExecutionId = useAssistantExecutionId(threadId);
  const [attemptSelection, setAttemptSelection] = useState<{ id: string; latestId: string } | null>(null);
  const [retryingExecutionId, setRetryingExecutionId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState('');
  const currentIndex = selectedAttemptIndex(group, attemptSelection);
  const selectAttempt = (id: string): void =>
    setAttemptSelection({ id, latestId: group.variants.at(-1)!.execution.id });
  const variant = group.variants[currentIndex];
  if (!variant) return null;
  const requestThrough = modelExecutionProjectionThrough(variant.execution) ?? group.projectionThrough;
  const retryable =
    modelExecutionCanRetry(variant) &&
    !records.some((record) => record.kind === 'message' && record.seq > requestThrough) &&
    !executions.some((execution) => {
      const laterProjection = modelExecutionProjectionThrough(execution);
      return execution.kind === 'model' && laterProjection !== null && laterProjection > requestThrough;
    });
  const handleRetry = async (): Promise<void> => {
    setRetryingExecutionId(variant.execution.id);
    setRetryError('');
    try {
      const nextExecution = await onRetryModelExecution(threadId, variant.execution.id);
      setAttemptSelection({ id: nextExecution.id, latestId: nextExecution.id });
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRetryingExecutionId(null);
    }
  };
  const attemptActions = (
    <div className="model-attempt-actions">
      {group.variants.length > 1 ? (
        <div className="model-attempt-switcher" role="group" aria-label="Generation attempts">
          <button
            type="button"
            aria-label="Previous generation attempt"
            title="Previous generation attempt"
            disabled={currentIndex === 0 || retryingExecutionId !== null}
            onClick={() => selectAttempt(group.variants[currentIndex - 1]!.execution.id)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span>
            {currentIndex + 1}/{group.variants.length}
          </span>
          <button
            type="button"
            aria-label="Next generation attempt"
            title="Next generation attempt"
            disabled={currentIndex === group.variants.length - 1 || retryingExecutionId !== null}
            onClick={() => selectAttempt(group.variants[currentIndex + 1]!.execution.id)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {retryable ? (
        <button
          type="button"
          className="model-retry-button"
          aria-label="Retry this model step"
          title="Start a new attempt for this Model Step"
          disabled={retryDisabled || retryingExecutionId !== null}
          onClick={() => void handleRetry()}
        >
          <RotateCcw size={12} aria-hidden="true" />
          <span>{retryingExecutionId === variant.execution.id ? 'Retrying…' : 'Retry'}</span>
        </button>
      ) : null}
      {retryError ? (
        <span className="model-retry-error" role="alert">
          {retryError}
        </span>
      ) : null}
    </div>
  );

  if (!variant.assistantRecord && variant.execution.id === draftExecutionId) {
    if (group.variants.length === 1) return null;
    return <div className="model-execution-branch-group live-attempt-controls">{attemptActions}</div>;
  }

  return (
    <div className="model-execution-branch-group">
      <ModelExecutionVariantView
        key={variant.execution.id}
        variant={variant}
        attemptActions={attemptActions}
        emptyOutput={
          variant.execution.status === 'completed' &&
          Boolean(variant.assistantRecord) &&
          !assistantRecordHasVisibleResult(variant.assistantRecord)
        }
        threadId={threadId}
        outputUnavailable={unavailableModelExecutionIds.has(variant.execution.id)}
        executions={executions}
        records={records}
        renderTool={renderTool}
      />
    </div>
  );
}

function ModelExecutionVariantView({
  variant,
  attemptActions,
  emptyOutput,
  threadId,
  outputUnavailable,
  executions,
  records,
  renderTool,
}: {
  variant: ModelExecutionVariant;
  attemptActions: ReactNode;
  emptyOutput: boolean;
  threadId: string;
  outputUnavailable: boolean;
  executions: Execution[];
  records: CanonicalRecord[];
  renderTool(call: ToolCall, execution: Execution | undefined, result: ToolResultPayload | undefined): ReactNode;
}) {
  const record = variant.assistantRecord;
  if (!record) {
    return (
      <ModelExecutionRecord
        execution={variant.execution}
        threadId={threadId}
        outputUnavailable={outputUnavailable}
        attemptActions={attemptActions}
      />
    );
  }
  return (
    <AssistantBubble
      record={record}
      executions={executions}
      records={records}
      threadId={threadId}
      renderTool={renderTool}
      attemptActions={attemptActions}
      emptyOutput={emptyOutput}
    />
  );
}

function ModelInputDisclosure({
  threadId,
  executionId,
  executionStatus,
}: {
  threadId: string;
  executionId: string;
  executionStatus: Execution['status'];
}) {
  const [modelInputs, setModelInputs] = useState<ModelInputAttempt[] | null>(null);
  const [modelInputsLoading, setModelInputsLoading] = useState(false);
  const [modelInputsError, setModelInputsError] = useState('');
  return (
    <details
      className="conversation-detail-card projection-card"
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
      <summary>
        <ChevronRight className="detail-chevron projection-chevron" size={13} aria-hidden="true" /> Model input
      </summary>
      <p className="projection-note">
        The recorded text-bearing prompt and provider request metadata are shown for inspection and compaction tooling.
        Inline image bytes and opaque provider reasoning replay data are summarized or omitted.
      </p>
      {modelInputsLoading ? <p className="projection-state">Loading model input…</p> : null}
      {modelInputsError ? <p className="projection-error">{modelInputsError}</p> : null}
      {modelInputs?.length === 0 ? (
        <p className="projection-state">
          {executionStatus === 'pending' || executionStatus === 'running'
            ? 'Model input has not been recorded yet.'
            : executionStatus === 'completed'
              ? 'The model pipeline completed this step without calling the adapter.'
              : 'The model adapter was not called before this step ended.'}
        </p>
      ) : null}
      {modelInputs?.map((attempt, index) => (
        <details className="conversation-detail-row projection-attempt" key={attempt.id}>
          <summary>
            <ChevronRight className="detail-chevron projection-chevron" size={13} aria-hidden="true" />
            Attempt {index + 1} · {attempt.status}
          </summary>
          {attempt.error ? <p className="projection-error">{attempt.error}</p> : null}
          {attempt.result ? (
            <p className="projection-note">
              Result: {attempt.result.textCharacters} text characters · {attempt.result.toolCallCount} tool calls ·{' '}
              {attempt.result.finishReason ?? 'no finish reason'} ·{' '}
              {attempt.result.empty ? 'empty output' : 'has output'}
              {attempt.result.usage?.totalTokens === undefined ? '' : ` · ${attempt.result.usage.totalTokens} tokens`}
            </p>
          ) : null}
          {attempt.partialOutputCharacters ? (
            <p className="projection-note">Discarded partial stream: {attempt.partialOutputCharacters} characters.</p>
          ) : null}
          {(attempt.providerRequests ?? []).map((request, requestIndex) => (
            <details className="conversation-detail-row projection-attempt" key={request.id}>
              <summary>
                <ChevronRight className="detail-chevron projection-chevron" size={13} aria-hidden="true" />
                Provider request {requestIndex + 1} · {request.outcome}
                {request.status ? ` · HTTP ${request.status}` : ''}
              </summary>
              <pre className="projection-view">
                {toJson({
                  provider: request.provider,
                  protocol: request.protocol,
                  endpoint: request.endpoint,
                  attempt: request.attempt,
                  status: request.status,
                  contentType: request.contentType,
                  providerRequestId: request.providerRequestId,
                  durationMs: request.durationMs,
                  terminalEvent: request.terminalEvent,
                  errorCategory: request.errorCategory,
                  errorCode: request.errorCode,
                  eventCounts: request.eventCounts,
                  firstTextMs: request.firstTextMs,
                  deltaTextCharacters: request.deltaTextCharacters,
                  outputTextCharacters: request.outputTextCharacters,
                  outputItemCounts: request.outputItemCounts,
                  toolCallCount: request.toolCallCount,
                  finishReason: request.finishReason,
                  responseId: request.responseId,
                  usage: request.usage,
                })}
              </pre>
            </details>
          ))}
          {!attempt.prompt ? (
            <p className="projection-note">
              The full prompt was not retained for this historical attempt; showing its summary.
            </p>
          ) : null}
          <pre className="projection-view">{toJson(attempt.prompt ?? attempt.promptSummary)}</pre>
          {attempt.prompt ? (
            <details className="conversation-detail-row projection-attempt">
              <summary>
                <ChevronRight className="detail-chevron projection-chevron" size={13} aria-hidden="true" /> Prompt
                diagnostics
              </summary>
              <pre className="projection-view">{toJson(attempt.promptSummary)}</pre>
            </details>
          ) : null}
        </details>
      ))}
    </details>
  );
}

function ModelExecutionRecord({
  execution,
  threadId,
  outputUnavailable = false,
  attemptActions,
}: {
  execution: Execution;
  threadId: string;
  outputUnavailable?: boolean;
  attemptActions: ReactNode;
}) {
  const [showModelDetails, setShowModelDetails] = useState(false);
  return (
    <div className="assistant-message model-execution-notice">
      <button
        type="button"
        className="assistant-avatar assistant-avatar-toggle"
        aria-label={showModelDetails ? 'Hide model input and attempts' : 'Show model input and attempts'}
        aria-expanded={showModelDetails}
        title={showModelDetails ? 'Hide model input and attempts' : 'Show model input and attempts'}
        onClick={() => setShowModelDetails((visible) => !visible)}
      >
        <Sparkles size={13} aria-hidden="true" />
      </button>
      <div className="message-body">
        <div className="message-author">
          Pico <span className="model-label">· {modelExecutionModelId(execution) ?? 'Model step'}</span>
          <span className="subtle-inline">· {new Date(execution.updatedAt).toLocaleTimeString()}</span>
          <span className={`tool-status status-${execution.status}`}>{execution.status}</span>
        </div>
        {execution.error ? (
          <details className="model-execution-error">
            <summary>
              <ChevronRight className="projection-chevron" size={13} aria-hidden="true" />
              <span>Failure details</span>
            </summary>
            <p>{execution.error}</p>
          </details>
        ) : outputUnavailable ? (
          <p className="projection-state">
            The connection dropped during this Model Step. Partial text is unavailable; the final reply will appear when
            the step commits.
          </p>
        ) : execution.status === 'pending' || execution.status === 'running' ? (
          <p className="model-execution-status-note">Starting a new attempt…</p>
        ) : (
          <p className="projection-state">This Model Step has not committed an assistant message.</p>
        )}
        {showModelDetails ? (
          <div className="model-input-attempt-controls">
            <ModelInputDisclosure threadId={threadId} executionId={execution.id} executionStatus={execution.status} />
            {attemptActions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Reasoning({ text, label = 'Thinking' }: { text: string; label?: string }) {
  const disclosure = useContext(ThinkingDisclosureContext);
  const expanded = disclosure?.expanded ?? true;
  return (
    <details className="reasoning-summary" open={expanded}>
      <summary
        onClick={
          disclosure
            ? (event) => {
                event.preventDefault();
                disclosure.toggle(!expanded, event.currentTarget);
              }
            : undefined
        }
      >
        {label}
      </summary>
      <Markdown>{reasoningSummaryMarkdown(text)}</Markdown>
    </details>
  );
}

function AssistantBubble({
  record,
  executions,
  records,
  threadId,
  renderTool,
  attemptActions,
  emptyOutput = false,
}: {
  record: CanonicalRecord;
  executions: Execution[];
  records: CanonicalRecord[];
  threadId: string;
  renderTool(call: ToolCall, execution: Execution | undefined, result: ToolResultPayload | undefined): ReactNode;
  attemptActions?: ReactNode;
  emptyOutput?: boolean;
}) {
  const [showModelDetails, setShowModelDetails] = useState(false);
  const assistant = recordPayload<AssistantPayload>(record);
  const calls = assistant.toolCalls ?? [];
  const executionId = record.id.replace(/:assistant$/, '');
  const completionNote = assistant.finishReason === 'length' ? '· output limit reached' : null;
  return (
    <div className="assistant-message">
      <button
        type="button"
        className="assistant-avatar assistant-avatar-toggle"
        aria-label={showModelDetails ? 'Hide model input and attempts' : 'Show model input and attempts'}
        aria-expanded={showModelDetails}
        title={showModelDetails ? 'Hide model input and attempts' : 'Show model input and attempts'}
        onClick={() => setShowModelDetails((visible) => !visible)}
      >
        <Sparkles size={13} aria-hidden="true" />
      </button>
      <div className="message-body">
        <div className="message-author">
          Pico {assistant.model ? <span className="model-label">· {assistant.model}</span> : null}
          {completionNote ? <span className="completion-label">{completionNote}</span> : null}
        </div>
        {emptyOutput ? (
          <p className="model-execution-empty-output">This Model Step completed without a visible response.</p>
        ) : null}
        {assistant.reasoningSummary ? (
          <Reasoning
            text={assistant.reasoningSummary}
            label={
              assistant.reasoningContent && assistant.reasoningContent !== assistant.reasoningSummary
                ? 'Thinking summary'
                : 'Thinking'
            }
          />
        ) : null}
        {assistant.reasoningContent && assistant.reasoningContent !== assistant.reasoningSummary ? (
          <Reasoning
            text={assistant.reasoningContent}
            label={assistant.reasoningSummary ? 'Reasoning content' : 'Thinking'}
          />
        ) : null}
        {assistant.content ? <Markdown>{assistant.content}</Markdown> : null}
        {calls.length > 0 ? (
          <div className="tool-group">
            <div className="tool-group-label">
              <Sparkles size={12} aria-hidden="true" /> {calls.length} tool {calls.length === 1 ? 'call' : 'calls'} ·
              parallel batch
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
              return renderTool(call, execution, result);
            })}
          </div>
        ) : null}
        {showModelDetails ? (
          <div className="model-input-attempt-controls">
            <ModelInputDisclosure
              threadId={threadId}
              executionId={executionId}
              executionStatus={executions.find((execution) => execution.id === executionId)?.status ?? 'completed'}
            />
            {attemptActions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
