import type { Execution, ToolCall, ToolResultPayload } from '../core/types.js';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import './tool-card.css';

type JsonRecord = Record<string, unknown>;

const toolTitles: Record<string, string> = {
  shell: 'Shell',
  read_file: 'Read file',
  search_files: 'Search files',
  apply_patch: 'Apply patch',
  workspace_info: 'Workspace info',
  todo_list: 'Todo · List',
  todo_add: 'Todo · Add',
  todo_update: 'Todo · Update',
  todo_complete: 'Todo · Complete',
  goal_checkpoint: 'Goal · Checkpoint',
  rolling_segments: 'Rolling Context · Segments',
  rolling_recall: 'Rolling Context · Recall',
  rolling_pin: 'Rolling Context · Pin',
  rolling_warm: 'Rolling Context · Warm',
  project_memory_record: 'Project Memory · Record',
  project_memory_search: 'Project Memory · Search',
  memory_search: 'Global Memory · Search',
  memory_save: 'Global Memory · Save',
  memory_replace: 'Global Memory · Replace',
  memory_delete: 'Global Memory · Delete',
  spawn_thread: 'Thread · Create child',
  send_thread_message: 'Thread · Send message',
  list_child_threads: 'Thread · List children',
  read_thread_history: 'Thread · Read history',
};

const argumentLabels: Record<string, string> = {
  command: 'Command',
  timeout_ms: 'Timeout',
  path: 'File path',
  pattern: 'Search pattern',
  patch: 'Patch',
  title: 'Title',
  next_action: 'Next action',
  priority: 'Priority',
  goal_id: 'Goal',
  id: 'Item ID',
  status: 'Status',
  progress: 'Progress',
  blocker: 'Blocker',
  verificationExecutionId: 'Verification execution',
  verificationRecordId: 'Verification record',
  verificationSummary: 'Verification',
  segment_id: 'Segment ID',
  query: 'Search query',
  category: 'Category',
  text: 'Text',
  source_seq: 'Source sequence',
  confidence: 'Confidence',
  expires_at: 'Expires at',
  supersedes: 'Replaces entries',
  applicability: 'Applies to',
  sources: 'Sources',
  thread_id: 'Thread ID',
  prompt: 'Task',
  message: 'Message',
  after_seq: 'After sequence',
  limit: 'Limit',
  operation_id: 'Operation ID',
  project: 'Project',
  workspace: 'Workspace',
  executor: 'Executor',
  callsFromThisPlugin: 'Calls from this plugin',
  state: 'State',
  tier: 'Context tier',
  startSeq: 'Starts at',
  endSeq: 'Ends at',
  summary: 'Summary',
  records: 'History records',
  items: 'Items',
  openCount: 'Open items',
  matches: 'Matches',
  changed: 'Changed files',
  threadId: 'Thread ID',
  parentThreadId: 'Parent Thread',
  initialMessageDelivered: 'Initial message delivered',
  delivered: 'Delivered',
  pauseReason: 'Pause reason',
  createdAt: 'Created',
  updatedAt: 'Updated',
  seq: 'Sequence',
  kind: 'Record type',
  payload: 'Record',
  evidence: 'Evidence',
  source: 'Source',
  sourceHash: 'Source hash',
  summaryStatus: 'Summary status',
  truncated: 'Truncated',
  exitCode: 'Exit code',
  stdout: 'stdout',
  stderr: 'stderr',
};

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const defaultShellTimeoutMs = 120_000;

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatClock(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (typeof value === 'undefined') return 'Not provided';
  if (typeof value === 'object') return toJson(value);
  return String(value);
}

function getPartialStringField(text: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)(?:"|$)`));
  if (!match) return null;
  const raw = match[1] ?? '';
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function previewArguments(call: ToolCall, preview?: { argumentsText: string }): JsonRecord {
  if (preview) {
    try {
      const parsed: unknown = JSON.parse(preview.argumentsText);
      return isRecord(parsed) ? parsed : {};
    } catch {
      const fields = [
        'command',
        'path',
        'pattern',
        'patch',
        'title',
        'next_action',
        'query',
        'text',
        'prompt',
        'message',
        'thread_id',
        'segment_id',
        'progress',
        'blocker',
        'verificationSummary',
        'verificationExecutionId',
        'verificationRecordId',
        'category',
        'applicability',
        'id',
      ];
      return Object.fromEntries(
        fields.flatMap((field) => {
          const value = getPartialStringField(preview.argumentsText, field);
          return value === null ? [] : [[field, value]];
        }),
      );
    }
  }
  return isRecord(call.arguments) ? call.arguments : {};
}

function readableArguments(name: string, args: JsonRecord, preview?: { argumentsText: string }): ReactNode {
  if (name === 'shell') {
    const command = typeof args.command === 'string' ? args.command : '';
    return (
      <pre className="tool-command-preview">
        {command || (preview ? 'Generating command…' : 'No command provided')}
        {preview ? <span className="tool-command-caret" aria-hidden="true" /> : null}
      </pre>
    );
  }

  const preferredOrder: Record<string, string[]> = {
    read_file: ['path'],
    search_files: ['pattern'],
    apply_patch: ['patch'],
    workspace_info: [],
    todo_list: [],
    todo_add: ['title', 'next_action', 'priority', 'goal_id'],
    todo_update: ['id', 'title', 'next_action', 'priority'],
    todo_complete: ['id'],
    goal_checkpoint: [
      'progress',
      'status',
      'blocker',
      'verificationSummary',
      'verificationExecutionId',
      'verificationRecordId',
    ],
    rolling_segments: [],
    rolling_recall: ['segment_id'],
    rolling_pin: ['segment_id'],
    rolling_warm: ['segment_id'],
    project_memory_record: ['category', 'text', 'source_seq', 'confidence', 'expires_at', 'supersedes'],
    project_memory_search: ['query'],
    memory_search: ['query'],
    memory_save: ['text', 'category', 'applicability', 'confidence', 'sources', 'id'],
    memory_replace: ['id', 'text', 'category', 'applicability', 'confidence'],
    memory_delete: ['id'],
    spawn_thread: ['title', 'prompt'],
    send_thread_message: ['thread_id', 'message'],
    list_child_threads: [],
    read_thread_history: ['thread_id', 'after_seq', 'limit'],
  };
  const order = preferredOrder[name];
  const keys = order
    ? [...order.filter((key) => key in args), ...Object.keys(args).filter((key) => !order.includes(key))]
    : Object.keys(args);
  if (keys.length === 0) {
    return <div className="tool-empty-input">{preview ? 'Generating arguments…' : 'No input required.'}</div>;
  }
  return (
    <div className="tool-readable-fields">
      {keys.map((key) => (
        <div
          className={`tool-readable-field${key === 'patch' || key === 'prompt' || key === 'message' || key === 'text' ? ' tool-long-field' : ''}`}
          key={key}
        >
          <span className="tool-field-label">{argumentLabels[key] ?? key}</span>
          <pre>{displayValue(args[key])}</pre>
        </div>
      ))}
    </div>
  );
}

function renderNestedValue(value: unknown, keyPrefix: string): ReactNode {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="tool-nested-empty">No items.</span>;
    return (
      <div className="tool-nested-list">
        {value.map((item, index) => (
          <div className="tool-nested-item" key={`${keyPrefix}-${index}`}>
            {isRecord(item) || Array.isArray(item) ? (
              renderNestedValue(item, `${keyPrefix}-${index}`)
            ) : (
              <pre>{displayValue(item)}</pre>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([key]) => key !== 'modelGuidance');
    if (!entries.length) return <span className="tool-nested-empty">No details.</span>;
    return (
      <div className="tool-nested-fields">
        {entries.map(([key, item]) => (
          <div className="tool-nested-field" key={`${keyPrefix}-${key}`}>
            <span className="tool-field-label">{argumentLabels[key] ?? key}</span>
            {renderNestedValue(item, `${keyPrefix}-${key}`)}
          </div>
        ))}
      </div>
    );
  }
  return <pre>{displayValue(value)}</pre>;
}

function resultSummary(name: string, value: unknown): string | null {
  if (name === 'read_file' && isRecord(value) && typeof value.path === 'string') return `Read ${value.path}`;
  if (name === 'search_files' && isRecord(value) && Array.isArray(value.matches)) {
    return `Found ${value.matches.length} matching result${value.matches.length === 1 ? '' : 's'}.`;
  }
  if (name === 'apply_patch' && isRecord(value) && Array.isArray(value.changed)) {
    return value.changed.length
      ? `Updated ${value.changed.length} file${value.changed.length === 1 ? '' : 's'}.`
      : 'No files changed.';
  }
  if (name === 'todo_list' && isRecord(value) && Array.isArray(value.items))
    return `Listed ${value.items.length} Todo item${value.items.length === 1 ? '' : 's'}.`;
  if (name === 'goal_checkpoint' && isRecord(value))
    return `Checkpoint recorded${typeof value.status === 'string' ? ` · ${value.status}` : ''}.`;
  if (name === 'rolling_segments' && Array.isArray(value))
    return `Listed ${value.length} Rolling Context segment${value.length === 1 ? '' : 's'}.`;
  if ((name === 'memory_search' || name === 'project_memory_search') && Array.isArray(value)) {
    return `Found ${value.length} memory entr${value.length === 1 ? 'y' : 'ies'}.`;
  }
  if (name === 'list_child_threads' && Array.isArray(value))
    return `Listed ${value.length} child Thread${value.length === 1 ? '' : 's'}.`;
  if (name === 'read_thread_history' && isRecord(value) && Array.isArray(value.records)) {
    return `Read ${value.records.length} history record${value.records.length === 1 ? '' : 's'}.`;
  }
  if (name === 'spawn_thread' && isRecord(value))
    return `Created child Thread${value.title ? ` · ${String(value.title)}` : ''}.`;
  if (name === 'send_thread_message' && isRecord(value))
    return value.delivered === true ? 'Message delivered.' : 'Message queued.';
  if (name.startsWith('todo_')) return 'Todo updated.';
  if (name === 'project_memory_record') return 'Project Memory entry recorded.';
  if (name === 'memory_save') return 'Global Memory entry saved.';
  if (name === 'memory_replace') return 'Global Memory entry replaced.';
  if (name === 'memory_delete')
    return isRecord(value) && value.deleted === false ? 'No entry was deleted.' : 'Global Memory entry deleted.';
  if (name === 'rolling_recall') return 'Retrieved the exact source for this segment.';
  if (name === 'rolling_pin') return 'Segment pinned in the hot context.';
  if (name === 'rolling_warm') return 'Segment compacted to its saved summary.';
  return null;
}

function readableShellResult(
  value: unknown,
  outcome: 'success' | 'failure' | 'running' | 'pending',
): ReactNode {
  if (!isRecord(value)) return <div className="tool-result-note">No output.</div>;
  const stdout = typeof value.stdout === 'string' && value.stdout.trim() ? value.stdout : null;
  const stderr = typeof value.stderr === 'string' && value.stderr.trim() ? value.stderr : null;
  const streams =
    outcome === 'success'
      ? stdout
        ? [{ label: null, text: stdout }]
        : stderr
          ? [{ label: 'stderr', text: stderr }]
          : []
      : outcome === 'failure' && stdout && stderr
        ? [
            { label: 'stdout', text: stdout },
            { label: 'stderr', text: stderr },
          ]
        : stderr
          ? [{ label: 'stderr', text: stderr }]
          : stdout
            ? [{ label: null, text: stdout }]
            : [];
  if (!streams.length) return <div className="tool-result-note">No output.</div>;
  return (
    <div className="tool-shell-streams">
      {streams.map((stream, index) => (
        <div className="tool-shell-stream" key={`${stream.label ?? 'stdout'}-${index}`}>
          {stream.label ? <span className="tool-field-label">{stream.label}</span> : null}
          <pre className={`tool-shell-stream-text${stream.label === 'stderr' ? ' tool-shell-stream-stderr' : ''}`}>
            {stream.text}
          </pre>
        </div>
      ))}
    </div>
  );
}

function readableResult(name: string, value: unknown): ReactNode {
  const summary = resultSummary(name, value);
  if (name === 'read_file' && isRecord(value)) {
    return (
      <div className="tool-readable-fields">
        {summary ? <div className="tool-result-note">{summary}</div> : null}
        {typeof value.path === 'string' ? <div className="tool-result-location">{value.path}</div> : null}
        {typeof value.contents === 'string' ? (
          <pre className="tool-result-content">{value.contents}</pre>
        ) : (
          <pre>{toJson(value)}</pre>
        )}
        {value.truncated === true ? <div className="tool-result-note">Output was truncated.</div> : null}
      </div>
    );
  }

  if (name === 'search_files' && isRecord(value) && Array.isArray(value.matches)) {
    return (
      <div className="tool-readable-fields">
        {summary ? <div className="tool-result-note">{summary}</div> : null}
        <div className="tool-result-note">
          {value.matches.length} match{value.matches.length === 1 ? '' : 'es'}
          {value.truncated === true ? ' · results truncated' : ''}
        </div>
        {value.matches.map((match, index) => (
          <div className="tool-search-match" key={index}>
            {renderNestedValue(match, `match-${index}`)}
          </div>
        ))}
      </div>
    );
  }

  if (name === 'apply_patch' && isRecord(value) && Array.isArray(value.changed)) {
    return value.changed.length ? (
      <div className="tool-readable-fields">
        {summary ? <div className="tool-result-note">{summary}</div> : null}
        <div className="tool-result-note">
          Updated {value.changed.length} file{value.changed.length === 1 ? '' : 's'}
        </div>
        {value.changed.map((path, index) => (
          <div className="tool-result-item" key={index}>
            {displayValue(path)}
          </div>
        ))}
      </div>
    ) : (
      <div className="tool-result-note">No files changed.</div>
    );
  }

  if (Array.isArray(value)) {
    return value.length ? (
      <div className="tool-readable-fields">
        {summary ? <div className="tool-result-note">{summary}</div> : null}
        {renderNestedValue(value, name)}
      </div>
    ) : (
      <div className="tool-result-note">No items.</div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([key]) => key !== 'modelGuidance');
    if (!entries.length) return <div className="tool-result-note">Completed with no details.</div>;
    return (
      <div className="tool-readable-fields">
        {summary ? <div className="tool-result-note">{summary}</div> : null}
        {entries.map(([key, item]) => (
          <div
            className={`tool-readable-field${typeof item === 'string' && item.length > 180 ? ' tool-long-field' : ''}`}
            key={key}
          >
            <span className="tool-field-label">{argumentLabels[key] ?? key}</span>
            {renderNestedValue(item, key)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="tool-readable-fields">
      {summary ? <div className="tool-result-note">{summary}</div> : null}
      <pre>{displayValue(value)}</pre>
    </div>
  );
}

function Toggle({
  value,
  onChange,
  label,
}: {
  value: 'readable' | 'raw';
  onChange: (value: 'readable' | 'raw') => void;
  label: string;
}) {
  return (
    <div className="tool-view-toggle" role="group" aria-label={`${label} display`}>
      <button type="button" aria-pressed={value === 'readable'} onClick={() => onChange('readable')}>
        Readable
      </button>
      <button type="button" aria-pressed={value === 'raw'} onClick={() => onChange('raw')}>
        Raw
      </button>
    </div>
  );
}

export function ToolCard({
  call,
  execution,
  result,
  preview,
  resultActions,
}: {
  call: ToolCall;
  execution: Execution | undefined;
  result: ToolResultPayload | undefined;
  preview?: { argumentsText: string };
  resultActions?: ReactNode;
}) {
  const [view, setView] = useState<'readable' | 'raw'>('readable');
  const status = execution?.status ?? result?.status ?? 'pending';
  const shellResult = result?.result ?? execution?.result;
  const shellExitCode = isRecord(shellResult) && typeof shellResult.exitCode === 'number' ? shellResult.exitCode : null;
  const shellExitFailure = call.name === 'shell' && status === 'completed' && shellExitCode !== null && shellExitCode !== 0;
  const hasError = Boolean(
    execution?.error || result?.status === 'failed' || result?.status === 'interrupted' || shellExitFailure,
  );
  const resultStatusMessage =
    status === 'interrupted' || result?.status === 'interrupted'
      ? 'The tool was interrupted. Its side effects may be partial or unknown.'
      : status === 'failed' || result?.status === 'failed'
        ? 'The tool failed.'
        : null;
  const outcomeUnconfirmed = execution?.error?.includes('The Executor did not confirm an outcome.') ?? false;
  const args = previewArguments(call, preview);
  const structuredResult = isRecord(result?.result)
    ? result.result
    : isRecord(execution?.result)
      ? execution.result
      : undefined;
  const modelGuidance = typeof structuredResult?.modelGuidance === 'string' ? structuredResult.modelGuidance : null;
  const resultErrors = result
    ? [...new Set([result.error, execution?.error].filter((error): error is string => Boolean(error)))]
    : [];
  const resultText = preview
    ? 'Waiting for the model to finish this call…'
    : result?.status === 'interrupted'
      ? `The tool was interrupted. Its side effects may be partial or unknown. Inspect the workspace before retrying.${result.error ? `\n\n${result.error}` : ''}`
      : result?.status === 'failed'
        ? (result.error ?? 'Tool failed.')
        : result
          ? toJson(result.result)
          : execution?.error
            ? `${execution.error}${execution.status === 'pending' && !outcomeUnconfirmed ? '\n\nContinue this Thread to retry the same Execution.' : ''}`
            : execution?.status === 'running'
              ? 'Running in the selected Executor…'
              : 'Waiting for the Executor…';
  const fullResult = result
    ? toJson(result)
    : execution?.result !== null && execution?.result !== undefined
      ? toJson(execution.result)
      : resultText;
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (call.name !== 'shell' || status !== 'running') return undefined;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call.name, execution?.updatedAt, status]);

  const shellTimeoutMs =
    typeof args.timeout_ms === 'number' ? args.timeout_ms : preview ? null : defaultShellTimeoutMs;
  const shellStartedAt = execution?.updatedAt ? Date.parse(execution.updatedAt) : Number.NaN;
  const shellElapsed = Number.isFinite(shellStartedAt) ? formatDuration(clockNow - shellStartedAt) : null;
  const terminalTime =
    status === 'completed' || status === 'failed' || status === 'interrupted'
      ? execution?.updatedAt
        ? formatClock(execution.updatedAt)
        : null
      : null;
  const shellMeta =
    call.name !== 'shell'
      ? null
      : status === 'pending' || status === 'running'
        ? [
            shellTimeoutMs === null ? null : `timeout ${formatDuration(shellTimeoutMs)}`,
            status === 'running' && shellElapsed ? `running ${shellElapsed}` : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · ')
        : terminalTime;
  const shellOutcome =
    status === 'failed' || status === 'interrupted' || shellExitFailure
      ? 'failure'
      : status === 'completed' && shellExitCode === 0
        ? 'success'
        : status === 'running'
          ? 'running'
          : 'pending';

  return (
    <article
      className={`conversation-detail-card pico-ui-card tool-card tool-${status}${hasError ? ' tool-has-error' : ''}${call.name === 'shell' ? ' tool-shell-card' : ''}`}
      data-phase={preview ? 'generating' : status}
      data-outcome={call.name === 'shell' ? shellOutcome : undefined}
    >
      <div className="tool-card-heading pico-ui-heading">
        <span className="tool-name">{toolTitles[call.name] ?? call.name}</span>
        <span
          className={`tool-status pico-ui-status status-${shellExitFailure ? 'failed' : status}`}
          data-status={shellExitFailure ? 'failed' : status}
        >
          {preview ? 'Generating' : shellExitFailure ? `Exit ${shellExitCode}` : status}
        </span>
        {(shellMeta ?? terminalTime) ? <span className="tool-card-meta">{shellMeta ?? terminalTime}</span> : null}
        <Toggle value={view} onChange={setView} label={`${toolTitles[call.name] ?? call.name} card`} />
      </div>
      {call.name === 'shell' ? (
        <div className={`tool-card-body tool-shell-body${view === 'readable' ? ' tool-shell-body-readable' : ''}`}>
          <div className="tool-shell-command">
            {view === 'raw' ? (
              <pre className="pico-ui-preview">
                {preview ? preview.argumentsText || 'Waiting for arguments…' : toJson(call.arguments)}
              </pre>
            ) : (
              readableArguments(call.name, args, preview)
            )}
          </div>
          <section className={`tool-shell-output tool-shell-output-${shellOutcome}`}>
            {view === 'raw' ? (
              <pre className={`pico-ui-preview tool-output${hasError ? ' tool-output-error' : ''}`}>{fullResult}</pre>
            ) : preview || !result || (result.status !== 'completed' && result.result === undefined) ? (
              <div className={`tool-shell-state${hasError ? ' tool-output-error' : ''}`}>
                {resultText}
              </div>
            ) : (
              readableShellResult(structuredResult, shellOutcome)
            )}
            {view === 'readable' && result?.result !== undefined && resultStatusMessage ? (
              <div className="tool-result-note tool-result-status-message" role="status">
                {resultStatusMessage}
              </div>
            ) : null}
            {view === 'readable' && result?.result !== undefined && resultErrors.length ? (
              <div className="tool-readable-errors" role="alert">
                {resultErrors.map((error, index) => (
                  <pre key={`${index}-${error}`}>{error}</pre>
                ))}
              </div>
            ) : null}
            {view === 'readable' && modelGuidance ? (
              <>
                <div className="tool-detail-heading tool-model-guidance-heading">Model guidance</div>
                <pre className="pico-ui-preview tool-model-guidance">{modelGuidance}</pre>
              </>
            ) : null}
            {view === 'readable' ? resultActions : null}
          </section>
        </div>
      ) : (
        <div className="tool-card-body">
          <section className="conversation-detail-row tool-detail">
            <div className="tool-detail-toolbar">
              <div className="tool-detail-heading">Arguments</div>
            </div>
            {view === 'raw' ? (
              <pre className="pico-ui-preview">
                {preview ? preview.argumentsText || 'Waiting for arguments…' : toJson(call.arguments)}
              </pre>
            ) : (
              readableArguments(call.name, args, preview)
            )}
          </section>
          <section className="conversation-detail-row tool-detail">
            <div className="tool-detail-toolbar">
              <div className="tool-detail-heading">Result</div>
            </div>
            {view === 'raw' ? (
              <pre className={`pico-ui-preview tool-output${hasError ? ' tool-output-error' : ''}`}>{fullResult}</pre>
            ) : preview || !result ? (
              <pre className={`pico-ui-preview tool-output${hasError ? ' tool-output-error' : ''}`}>{resultText}</pre>
            ) : (
              readableResult(call.name, result.result)
            )}
            {view === 'readable' && resultStatusMessage ? (
              <div className="tool-result-note tool-result-status-message" role="status">
                {resultStatusMessage}
              </div>
            ) : null}
            {view === 'readable' && resultErrors.length ? (
              <div className="tool-readable-errors" role="alert">
                {resultErrors.map((error, index) => (
                  <pre key={`${index}-${error}`}>{error}</pre>
                ))}
              </div>
            ) : null}
            {view === 'readable' && modelGuidance ? (
              <>
                <div className="tool-detail-heading tool-model-guidance-heading">Model guidance</div>
                <pre className="pico-ui-preview tool-model-guidance">{modelGuidance}</pre>
              </>
            ) : null}
            {resultActions}
          </section>
        </div>
      )}
    </article>
  );
}
