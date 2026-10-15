import { migrateLegacyPermissions } from './migrations/legacy-permissions.js';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AssistantPayload,
  CanonicalKind,
  CanonicalRecord,
  Execution,
  ExecutionKind,
  ExecutionStatus,
  ExecutorBinding,
  ExecutorKind,
  MessagePayload,
  Project,
  RemoteExecutorConnection,
  RemoteExecutorConnectionView,
  Thread,
  ToolCall,
  ToolResultPayload,
} from './types.js';

type SqlRow = Record<string, unknown>;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

export interface AppendResult<T extends object> {
  record: CanonicalRecord<T>;
  inserted: boolean;
}

export interface ExecutionLogEntry {
  id: string;
  executionId: string;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface CanonicalRecordPage {
  records: CanonicalRecord[];
  hasEarlierRecords: boolean;
}

export interface CommitStepInput {
  assistantRecordId: string;
  modelExecutionId: string;
  threadId: string;
  payload: AssistantPayload;
  toolCalls: Array<{ call: ToolCall; executionId: string }>;
  createdAt?: string;
}

export class PicoStore {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;
  private readonly canonicalListeners = new Set<(record: CanonicalRecord) => void>();
  private readonly stateListeners = new Set<(pluginId: string) => void>();
  private pendingNotifications: Array<() => void> = [];

  subscribeCanonical(listener: (record: CanonicalRecord) => void): () => void {
    this.canonicalListeners.add(listener);
    return () => this.canonicalListeners.delete(listener);
  }

  subscribePluginState(listener: (pluginId: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private notifyAfterCommit(notification: () => void): void {
    if (this.transactionDepth > 0) this.pendingNotifications.push(notification);
    else notification();
  }

  private dispatchNotification(notification: () => void): void {
    try {
      notification();
    } catch (error) {
      // Observers cannot turn a committed fact into an apparent write failure.
      console.error('Pico Store observer failed:', error);
    }
  }

  constructor(filename = process.env.PICO_DB_PATH ?? join(process.cwd(), 'data', 'pico.sqlite')) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') {
      try {
        chmodSync(filename, 0o600);
      } catch {
        /* The data directory may be managed by the host. */
      }
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_executor_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        access_token TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('container', 'host', 'runtime')),
        label TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        remote_connection_id TEXT REFERENCES remote_executor_connections(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        executor_id TEXT NOT NULL REFERENCES executors(id),
        title TEXT NOT NULL,
        parent_thread_id TEXT REFERENCES threads(id),
        created_by_agent INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS threads_project_created ON threads(project_id, created_at);
      CREATE TABLE IF NOT EXISTS canonical_records (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS canonical_thread_seq ON canonical_records(thread_id, seq);
      CREATE INDEX IF NOT EXISTS canonical_thread_kind_seq ON canonical_records(thread_id, kind, seq);
      CREATE TRIGGER IF NOT EXISTS canonical_records_no_update
      BEFORE UPDATE ON canonical_records BEGIN
        SELECT RAISE(ABORT, 'canonical records are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS canonical_records_no_delete
      BEFORE DELETE ON canonical_records BEGIN
        SELECT RAISE(ABORT, 'canonical records are append-only');
      END;
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        batch_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'tool')),
        tool_name TEXT,
        arguments_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS executions_thread_status ON executions(thread_id, status);
      CREATE INDEX IF NOT EXISTS executions_batch ON executions(batch_id);
      CREATE TABLE IF NOT EXISTS execution_log (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id),
        kind TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS execution_log_no_update
      BEFORE UPDATE ON execution_log BEGIN
        SELECT RAISE(ABORT, 'execution log is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS execution_log_no_delete
      BEFORE DELETE ON execution_log BEGIN
        SELECT RAISE(ABORT, 'execution log is append-only');
      END;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS auth_session_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token_fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );
    `);
    this.migrateRemoteExecutorBindings();
    this.migrateRuntimeExecutorKind();
    migrateLegacyPermissions(this.db);
  }

  ensureAuthTokenFingerprint(fingerprint: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT token_fingerprint FROM auth_session_config WHERE id = 1').get() as
        SqlRow | undefined;
      if (!row) {
        this.db.prepare('INSERT INTO auth_session_config (id, token_fingerprint) VALUES (1, ?)').run(fingerprint);
      } else if (row.token_fingerprint !== fingerprint) {
        this.db.prepare('DELETE FROM auth_sessions').run();
        this.db.prepare('UPDATE auth_session_config SET token_fingerprint = ? WHERE id = 1').run(fingerprint);
      }
    });
  }

  createAuthSession(tokenHash: string, expiresAt: number, now: number): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as SqlRow | undefined;
      const count = Number(row?.count ?? 0);
      if (count >= 256) {
        this.db
          .prepare(
            `DELETE FROM auth_sessions WHERE token_hash IN (
              SELECT token_hash FROM auth_sessions ORDER BY expires_at ASC, token_hash ASC LIMIT ?
            )`,
          )
          .run(count - 255);
      }
      this.db.prepare('INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt);
    });
  }

  getAuthSessionExpiry(tokenHash: string): number | null {
    const row = this.db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as
      SqlRow | undefined;
    return row ? Number(row.expires_at) : null;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  private migrateRemoteExecutorBindings(): void {
    const columns = this.db.prepare('PRAGMA table_info(executors)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'remote_connection_id')) return;
    this.db.exec(
      'ALTER TABLE executors ADD COLUMN remote_connection_id TEXT REFERENCES remote_executor_connections(id);',
    );
  }

  private migrateRuntimeExecutorKind(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'executors'")
      .get() as SqlRow | undefined;
    if (typeof schema?.sql !== 'string' || schema.sql.includes("'runtime'")) return;

    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE executors_new (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('container', 'host', 'runtime')),
            label TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            remote_connection_id TEXT REFERENCES remote_executor_connections(id),
            created_at TEXT NOT NULL
          );
          INSERT INTO executors_new (id, kind, label, workspace_path, remote_connection_id, created_at)
            SELECT id, kind, label, workspace_path, remote_connection_id, created_at FROM executors;
          DROP TABLE executors;
          ALTER TABLE executors_new RENAME TO executors;
        `);
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
    const violations = this.db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error('Executor migration left foreign-key violations.');
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(run: () => T): T {
    const outermost = this.transactionDepth === 0;
    const savepoint = `pico_savepoint_${++this.savepointSequence}`;
    const notificationStart = this.pendingNotifications.length;
    this.db.exec(outermost ? 'BEGIN IMMEDIATE;' : `SAVEPOINT ${savepoint};`);
    this.transactionDepth += 1;
    let value: T;
    try {
      value = run();
      this.db.exec(outermost ? 'COMMIT;' : `RELEASE SAVEPOINT ${savepoint};`);
    } catch (error) {
      this.pendingNotifications.splice(notificationStart);
      try {
        this.db.exec(outermost ? 'ROLLBACK;' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint};`);
      } catch {
        // Preserve the original failure; the outer transaction may still roll back.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
    if (outermost) {
      const notifications = this.pendingNotifications.splice(0);
      for (const notification of notifications) this.dispatchNotification(notification);
    }
    return value;
  }

  createProject(name: string, workspacePath: string, id = randomUUID()): Project {
    const createdAt = isoNow();
    this.db
      .prepare('INSERT INTO projects (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, workspacePath, createdAt);
    return { id, name, workspacePath, createdAt };
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as SqlRow[]).map((row) =>
      this.projectFromRow(row),
    );
  }

  private projectFromRow(row: SqlRow): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      workspacePath: String(row.workspace_path),
      createdAt: String(row.created_at),
    };
  }

  createThread(
    projectId: string,
    executorKind: ExecutorKind,
    title = 'New thread',
    options: {
      parentThreadId?: string | null;
      createdByAgent?: boolean;
      remoteConnectionId?: string | null;
      workspacePath?: string;
    } = {},
  ): Thread {
    const project = this.getProject(projectId);
    if (!project) throw new Error('Project not found');
    const remoteConnection = options.remoteConnectionId
      ? this.getRemoteExecutorConnection(options.remoteConnectionId)
      : null;
    if (options.remoteConnectionId && !remoteConnection) throw new Error('Remote Executor connection not found');
    if (remoteConnection && executorKind !== 'host')
      throw new Error('Remote Host Executor must use Host execution kind');
    const id = randomUUID();
    const executorId = randomUUID();
    const createdAt = isoNow();
    const workspacePath = executorKind === 'runtime' ? '' : (options.workspacePath ?? project.workspacePath);
    const kindLabel = remoteConnection
      ? `Remote Host · ${remoteConnection.name}`
      : executorKind === 'container'
        ? 'Container'
        : executorKind === 'runtime'
          ? 'Chat'
          : 'Host';
    const label = `${kindLabel} · ${project.name}`;
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO executors (id, kind, label, workspace_path, remote_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(executorId, executorKind, label, workspacePath, remoteConnection?.id ?? null, createdAt);
      this.db
        .prepare(
          `
        INSERT INTO threads (
          id, project_id, executor_id, title, parent_thread_id,
          created_by_agent, pause_requested, pause_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
      `,
        )
        .run(
          id,
          projectId,
          executorId,
          title,
          options.parentThreadId ?? null,
          options.createdByAgent ? 1 : 0,
          createdAt,
        );
    });
    return {
      id,
      projectId,
      executorId,
      executorKind,
      executorRemote: Boolean(remoteConnection),
      executorLabel: label,
      workspacePath,
      title,
      parentThreadId: options.parentThreadId ?? null,
      createdByAgent: options.createdByAgent ?? false,
      pauseRequested: false,
      pauseReason: null,
      createdAt,
      state: 'idle',
    };
  }

  getThread(id: string): Thread | null {
    const row = this.db
      .prepare(
        `
      SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
             e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
      FROM threads t JOIN executors e ON e.id = t.executor_id WHERE t.id = ?
    `,
      )
      .get(id) as SqlRow | undefined;
    return row ? this.threadFromRow(row) : null;
  }

  listThreads(projectId?: string): Thread[] {
    const rows = (
      projectId
        ? this.db
            .prepare(
              `
          SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
                 e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
          FROM threads t JOIN executors e ON e.id = t.executor_id
          WHERE t.project_id = ? ORDER BY t.created_at DESC
        `,
            )
            .all(projectId)
        : this.db
            .prepare(
              `
          SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
                 e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
          FROM threads t JOIN executors e ON e.id = t.executor_id
          ORDER BY t.created_at DESC
        `,
            )
            .all()
    ) as SqlRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  private threadFromRow(row: SqlRow): Thread {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      executorId: String(row.executor_id),
      executorKind: row.executor_kind as ExecutorKind,
      executorRemote: typeof row.executor_remote === 'string' && row.executor_remote.length > 0,
      executorLabel: String(row.executor_label),
      workspacePath: String(row.workspace_path),
      title: String(row.title),
      parentThreadId: typeof row.parent_thread_id === 'string' ? row.parent_thread_id : null,
      createdByAgent: row.created_by_agent === 1,
      pauseRequested: row.pause_requested === 1,
      pauseReason: typeof row.pause_reason === 'string' ? row.pause_reason : null,
      createdAt: String(row.created_at),
      state: row.pause_requested === 1 ? 'paused' : 'idle',
    };
  }

  setPause(threadId: string, paused: boolean, reason: string | null = null): void {
    const result = this.db
      .prepare('UPDATE threads SET pause_requested = ?, pause_reason = ? WHERE id = ?')
      .run(paused ? 1 : 0, paused ? reason : null, threadId);
    if (result.changes === 0) throw new Error('Thread not found');
  }

  appendMessage(threadId: string, id: string, payload: MessagePayload): AppendResult<MessagePayload> {
    return this.appendCanonical(threadId, id, 'message', payload);
  }

  appendPluginRecord(
    threadId: string,
    pluginId: string,
    payload: Record<string, unknown>,
    id: string = randomUUID(),
  ): CanonicalRecord {
    return this.appendCanonical(threadId, id, 'plugin', { ...payload, pluginId }).record;
  }

  appendCanonical<T extends object>(
    threadId: string,
    id: string,
    kind: CanonicalKind,
    payload: T,
    createdAt = isoNow(),
  ): AppendResult<T> {
    return this.transaction(() => this.appendCanonicalInternal(threadId, id, kind, payload, createdAt));
  }

  private appendCanonicalInternal<T extends object>(
    threadId: string,
    id: string,
    kind: CanonicalKind,
    payload: T,
    createdAt = isoNow(),
  ): AppendResult<T> {
    const existing = this.db.prepare('SELECT * FROM canonical_records WHERE id = ?').get(id) as SqlRow | undefined;
    if (existing) {
      const oldPayload = String(existing.payload_json);
      if (
        existing.thread_id !== threadId ||
        existing.kind !== kind ||
        JSON.stringify(JSON.parse(oldPayload)) !== JSON.stringify(payload)
      ) {
        throw new Error(`Canonical record ID ${id} was reused with different content`);
      }
      return { record: this.recordFromRow(existing) as CanonicalRecord<T>, inserted: false };
    }
    const sequenceRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM canonical_records WHERE thread_id = ?')
      .get(threadId) as SqlRow;
    const seq = Number(sequenceRow.next_seq);
    this.db
      .prepare(
        `
      INSERT INTO canonical_records (id, thread_id, seq, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, threadId, seq, kind, JSON.stringify(payload), createdAt);
    const record = { id, threadId, seq, kind, payload, createdAt };
    const snapshot = structuredClone(record) as CanonicalRecord;
    this.notifyAfterCommit(() => {
      for (const listener of this.canonicalListeners) {
        this.dispatchNotification(() => listener(structuredClone(snapshot)));
      }
    });
    return { record, inserted: true };
  }

  private recordFromRow(row: SqlRow): CanonicalRecord {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      seq: Number(row.seq),
      kind: row.kind as CanonicalKind,
      payload: json(row.payload_json, {}),
      createdAt: String(row.created_at),
    };
  }

  listRecords(threadId: string): CanonicalRecord[] {
    return (
      this.db.prepare('SELECT * FROM canonical_records WHERE thread_id = ? ORDER BY seq').all(threadId) as SqlRow[]
    ).map((row) => this.recordFromRow(row));
  }

  readCanonical(threadId: string, afterSeq = 0, limit = 100): CanonicalRecord[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid canonical cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Canonical page limit must be 1..1000');
    return (
      this.db
        .prepare('SELECT * FROM canonical_records WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(threadId, afterSeq, limit) as SqlRow[]
    ).map((row) => this.recordFromRow(row));
  }

  getCanonicalRecordById(id: string): CanonicalRecord | null {
    const row = this.db.prepare('SELECT * FROM canonical_records WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.recordFromRow(row) : null;
  }

  hasMessage(threadId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM canonical_records WHERE thread_id = ? AND kind = 'message' LIMIT 1").get(threadId),
    );
  }

  hasMessageAfter(threadId: string, sequence: number): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM canonical_records WHERE thread_id = ? AND kind = 'message' AND seq > ? LIMIT 1")
        .get(threadId, sequence),
    );
  }

  listRecordPage(threadId: string, beforeSeq?: number, limit = 100): CanonicalRecordPage {
    const pageSize = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = (
      beforeSeq === undefined
        ? this.db
            .prepare('SELECT * FROM canonical_records WHERE thread_id = ? ORDER BY seq DESC LIMIT ?')
            .all(threadId, pageSize)
        : this.db
            .prepare('SELECT * FROM canonical_records WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
            .all(threadId, beforeSeq, pageSize)
    ) as SqlRow[];
    let records = rows.reverse().map((row) => this.recordFromRow(row));

    // Keep the parent Model Step visible when an old Tool Batch is still active.
    // The range remains contiguous so the UI can continue paging from its first record.
    if (beforeSeq === undefined && records.length > 0) {
      const activeBatches = this.db
        .prepare(
          `SELECT DISTINCT batch_id FROM executions
           WHERE thread_id = ? AND kind = 'tool' AND status IN ('pending', 'running') AND batch_id IS NOT NULL`,
        )
        .all(threadId) as SqlRow[];
      const assistantIds = activeBatches
        .map((row) => String(row.batch_id).replace(/:batch$/, '') + ':assistant')
        .filter((id) => !records.some((record) => record.id === id));
      if (assistantIds.length > 0) {
        const placeholders = assistantIds.map(() => '?').join(', ');
        const parentRows = this.db
          .prepare(`SELECT * FROM canonical_records WHERE thread_id = ? AND id IN (${placeholders})`)
          .all(threadId, ...assistantIds) as SqlRow[];
        const firstPageSeq = records[0]!.seq;
        const olderParents = parentRows
          .map((row) => this.recordFromRow(row))
          .filter((record) => record.seq < firstPageSeq);
        if (olderParents.length > 0) {
          const firstRequiredSeq = Math.min(...olderParents.map((record) => record.seq));
          const contiguousRows = this.db
            .prepare('SELECT * FROM canonical_records WHERE thread_id = ? AND seq >= ? ORDER BY seq')
            .all(threadId, firstRequiredSeq) as SqlRow[];
          records = contiguousRows.map((row) => this.recordFromRow(row));
        }
      }
    }

    const firstSeq = records[0]?.seq;
    const hasEarlierRecords =
      firstSeq !== undefined &&
      Boolean(
        this.db
          .prepare('SELECT 1 FROM canonical_records WHERE thread_id = ? AND seq < ? LIMIT 1')
          .get(threadId, firstSeq),
      );
    return { records, hasEarlierRecords };
  }

  listSnapshotExecutions(threadId: string, records: readonly CanonicalRecord[]): Execution[] {
    const assistantRecords = records.filter((record) => record.kind === 'assistant');
    const modelIds = assistantRecords.map((record) => record.id.replace(/:assistant$/, ''));
    const batchIds = assistantRecords
      .map((record) => (record.payload as unknown as AssistantPayload).batchId)
      .filter((batchId): batchId is string => Boolean(batchId));
    const clauses = ["e.status IN ('pending', 'running')"];
    const params: Array<string | number> = [threadId];
    if (modelIds.length > 0) {
      clauses.push(`e.id IN (${modelIds.map(() => '?').join(', ')})`);
      params.push(...modelIds);
    }
    if (batchIds.length > 0) {
      clauses.push(`e.batch_id IN (${batchIds.map(() => '?').join(', ')})`);
      params.push(...batchIds);
    }
    clauses.push(`e.id IN (
      SELECT candidate.id FROM executions candidate
      WHERE candidate.thread_id = ? AND candidate.kind = 'model'
        AND candidate.status IN ('failed', 'interrupted')
        AND NOT EXISTS (
          SELECT 1 FROM canonical_records committed
          WHERE committed.thread_id = candidate.thread_id
            AND committed.id = candidate.id || ':assistant'
        )
      ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 50
    )`);
    params.push(threadId);
    return (
      this.db
        .prepare(
          `SELECT e.* FROM executions e WHERE e.thread_id = ? AND (${clauses.join(' OR ')}) ORDER BY e.created_at, e.id`,
        )
        .all(...params) as SqlRow[]
    ).map((row) => this.executionFromRow(row));
  }

  commitModelStep(input: CommitStepInput): CanonicalRecord<AssistantPayload> {
    const createdAt = input.createdAt ?? isoNow();
    return this.transaction(() => {
      const assistant = this.appendCanonicalInternal(
        input.threadId,
        input.assistantRecordId,
        'assistant',
        input.payload,
        createdAt,
      ).record;
      for (const { call, executionId } of input.toolCalls) {
        const existing = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId) as
          SqlRow | undefined;
        if (existing) continue;
        this.db
          .prepare(
            `
          INSERT INTO executions (
            id, thread_id, batch_id, kind, tool_name, arguments_json, status,
            result_json, error, created_at, updated_at
          ) VALUES (?, ?, ?, 'tool', ?, ?, 'pending', NULL, NULL, ?, ?)
        `,
          )
          .run(
            executionId,
            input.threadId,
            input.payload.batchId,
            call.name,
            JSON.stringify(call.arguments),
            createdAt,
            createdAt,
          );
        this.logExecution(executionId, 'created', { status: 'pending' }, createdAt);
      }
      const modelExecution = this.getExecution(input.modelExecutionId);
      if (modelExecution && (modelExecution.status === 'pending' || modelExecution.status === 'running')) {
        this.db
          .prepare(
            `
          UPDATE executions SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ?
        `,
          )
          .run(
            JSON.stringify({
              model: input.payload.model,
              usage: input.payload.usage,
              finishReason: input.payload.finishReason ?? null,
            }),
            createdAt,
            input.modelExecutionId,
          );
        this.logExecution(
          input.modelExecutionId,
          'completed',
          {
            model: input.payload.model,
            usage: input.payload.usage,
            finishReason: input.payload.finishReason ?? null,
          },
          createdAt,
        );
      }
      return assistant;
    });
  }

  createModelExecution(
    id: string,
    threadId: string,
    projectionThrough: number,
    retryOf?: string,
    model?: string,
  ): Execution {
    const now = isoNow();
    return this.transaction(() => {
      const existing = this.getExecution(id);
      if (existing) return existing;
      this.db
        .prepare(
          `
      INSERT INTO executions (
        id, thread_id, batch_id, kind, tool_name, arguments_json, status,
        result_json, error, created_at, updated_at
      ) VALUES (?, ?, NULL, 'model', NULL, ?, 'pending', NULL, NULL, ?, ?)
    `,
        )
        .run(
          id,
          threadId,
          JSON.stringify({
            projectionThrough,
            ...(retryOf ? { retryOf } : {}),
            ...(model?.trim() ? { model: model.trim() } : {}),
          }),
          now,
          now,
        );
      this.logExecution(
        id,
        'created',
        {
          status: 'pending',
          projectionThrough,
          ...(retryOf ? { retryOf } : {}),
          ...(model?.trim() ? { model: model.trim() } : {}),
        },
        now,
      );
      return this.getExecution(id)!;
    });
  }

  setModelExecutionModel(id: string, model: string): Execution {
    const cleanedModel = model.trim();
    return this.transaction(() => {
      const current = this.getExecution(id);
      if (!current || current.kind !== 'model') throw new Error(`Model Execution ${id} not found`);
      if (!cleanedModel) return current;
      const args = current.arguments && typeof current.arguments === 'object' ? current.arguments : {};
      if (args.model === cleanedModel) return current;
      const now = isoNow();
      this.db
        .prepare('UPDATE executions SET arguments_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ ...args, model: cleanedModel }), now, id);
      this.logExecution(id, 'model-selected', { model: cleanedModel }, now);
      return this.getExecution(id)!;
    });
  }

  transitionExecution(
    id: string,
    status: ExecutionStatus,
    data: { result?: unknown; error?: string; detail?: Record<string, unknown> } = {},
  ): Execution {
    return this.transaction(() => this.transitionExecutionInternal(id, status, data));
  }

  recordRetryableExecutionFailure(id: string, error: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(id);
      if (!current) throw new Error(`Execution ${id} not found`);
      if (current.kind !== 'tool' || current.status !== 'pending') {
        throw new Error(`Execution ${id} is not a pending Tool Execution`);
      }
      const now = isoNow();
      this.db.prepare('UPDATE executions SET error = ?, updated_at = ? WHERE id = ?').run(error, now, id);
      this.logExecution(id, 'retryable-setup-failure', { error }, now);
      return this.getExecution(id)!;
    });
  }

  private transitionExecutionInternal(
    id: string,
    status: ExecutionStatus,
    data: { result?: unknown; error?: string; detail?: Record<string, unknown> },
  ): Execution {
    const current = this.getExecution(id);
    if (!current) throw new Error(`Execution ${id} not found`);
    if (current.status === status) return current;
    const allowed: Record<ExecutionStatus, ExecutionStatus[]> = {
      pending: ['running', 'completed', 'failed', 'interrupted'],
      running: ['completed', 'failed', 'interrupted'],
      completed: [],
      failed: [],
      interrupted: [],
    };
    if (!allowed[current.status].includes(status)) {
      throw new Error(`Invalid execution transition ${current.status} → ${status}`);
    }
    const now = isoNow();
    const resultJson = Object.hasOwn(data, 'result') ? JSON.stringify(data.result) : null;
    this.db
      .prepare(
        `
      UPDATE executions SET status = ?, result_json = COALESCE(?, result_json),
        error = ?, updated_at = ? WHERE id = ?
    `,
      )
      .run(status, resultJson, data.error ?? null, now, id);
    this.logExecution(id, status, data.detail ?? { error: data.error ?? null }, now);
    return this.getExecution(id)!;
  }

  private logExecution(id: string, kind: string, detail: Record<string, unknown>, createdAt = isoNow()): void {
    this.db
      .prepare(
        `
      INSERT INTO execution_log (id, execution_id, kind, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(randomUUID(), id, kind, JSON.stringify(detail), createdAt);
  }

  appendExecutionLog(executionId: string, kind: string, detail: Record<string, unknown>): void {
    if (!this.getExecution(executionId)) throw new Error(`Execution ${executionId} not found`);
    this.logExecution(executionId, kind, detail);
  }

  listExecutionLog(executionId: string, kind: string): ExecutionLogEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM execution_log WHERE execution_id = ? AND kind = ? ORDER BY created_at, id')
        .all(executionId, kind) as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      executionId: String(row.execution_id),
      kind: String(row.kind),
      detail: json<Record<string, unknown>>(row.detail_json, {}),
      createdAt: String(row.created_at),
    }));
  }

  getExecution(id: string): Execution | null {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.executionFromRow(row) : null;
  }

  listExecutions(threadId: string): Execution[] {
    return (
      this.db.prepare('SELECT * FROM executions WHERE thread_id = ? ORDER BY created_at, id').all(threadId) as SqlRow[]
    ).map((row) => this.executionFromRow(row));
  }

  listExecutionsByBatch(batchId: string): Execution[] {
    return (
      this.db.prepare('SELECT * FROM executions WHERE batch_id = ? ORDER BY created_at, id').all(batchId) as SqlRow[]
    ).map((row) => this.executionFromRow(row));
  }

  listActiveExecutions(threadId: string): Execution[] {
    return (
      this.db
        .prepare(
          `
      SELECT * FROM executions WHERE thread_id = ? AND status IN ('pending', 'running')
      ORDER BY created_at, id
    `,
        )
        .all(threadId) as SqlRow[]
    ).map((row) => this.executionFromRow(row));
  }

  private executionFromRow(row: SqlRow): Execution {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      batchId: typeof row.batch_id === 'string' ? row.batch_id : null,
      kind: row.kind as ExecutionKind,
      toolName: typeof row.tool_name === 'string' ? row.tool_name : null,
      arguments: json(row.arguments_json, null),
      status: row.status as ExecutionStatus,
      result: json(row.result_json, null),
      error: typeof row.error === 'string' ? row.error : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  appendToolResult(
    threadId: string,
    payload: ToolResultPayload,
    id = `${payload.executionId}:result`,
  ): CanonicalRecord<ToolResultPayload> {
    return this.appendCanonical(threadId, id, 'tool_result', payload).record;
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as SqlRow | undefined;
    return row ? json(row.value_json, fallback) : fallback;
  }

  setSetting<T>(key: string, value: T): void {
    this.db
      .prepare(
        `
      INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(value), isoNow());
  }

  getPluginState<T>(pluginId: string, key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as SqlRow | undefined;
    return row ? json(row.value_json, fallback) : fallback;
  }

  setPluginState<T>(pluginId: string, key: string, value: T): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Plugin State must be JSON serializable');
    const previous = this.db
      .prepare('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as SqlRow | undefined;
    if (previous?.value_json === serialized) return;
    this.db
      .prepare(
        `
      INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE
        SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
      )
      .run(pluginId, key, serialized, isoNow());
    this.notifyAfterCommit(() => {
      for (const listener of this.stateListeners) this.dispatchNotification(() => listener(pluginId));
    });
  }

  currentSequence(threadId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM canonical_records WHERE thread_id = ?')
      .get(threadId) as SqlRow;
    return Number(row.seq);
  }

  hasToolResult(executionId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM canonical_records WHERE id = ? LIMIT 1').get(`${executionId}:result`);
    return Boolean(row);
  }

  modelOutputForThread(threadId: string): CanonicalRecord<AssistantPayload> | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM canonical_records WHERE thread_id = ? AND kind = 'assistant'
      ORDER BY seq DESC LIMIT 1
    `,
      )
      .get(threadId) as SqlRow | undefined;
    return row ? (this.recordFromRow(row) as unknown as CanonicalRecord<AssistantPayload>) : null;
  }

  executorForThread(threadId: string): ExecutorBinding | null {
    const row = this.db
      .prepare(
        `
      SELECT e.*, r.endpoint_url AS remote_endpoint_url, r.access_token AS remote_access_token
      FROM executors e JOIN threads t ON t.executor_id = e.id
      LEFT JOIN remote_executor_connections r ON r.id = e.remote_connection_id
      WHERE t.id = ?
    `,
      )
      .get(threadId) as SqlRow | undefined;
    return row
      ? {
          id: String(row.id),
          kind: row.kind as ExecutorKind,
          label: String(row.label),
          workspacePath: String(row.workspace_path),
          remoteConnectionId: typeof row.remote_connection_id === 'string' ? row.remote_connection_id : null,
          remoteEndpointUrl: typeof row.remote_endpoint_url === 'string' ? row.remote_endpoint_url : null,
          remoteAccessToken: typeof row.remote_access_token === 'string' ? row.remote_access_token : null,
          createdAt: String(row.created_at),
        }
      : null;
  }

  createRemoteExecutorConnection(
    name: string,
    endpointUrl: string,
    accessToken: string,
    workspaceRoot: string,
  ): RemoteExecutorConnectionView {
    const connection: RemoteExecutorConnection = {
      id: randomUUID(),
      name,
      endpointUrl,
      accessToken,
      workspaceRoot,
      createdAt: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO remote_executor_connections
          (id, name, endpoint_url, access_token, workspace_root, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        connection.id,
        connection.name,
        connection.endpointUrl,
        connection.accessToken,
        connection.workspaceRoot,
        connection.createdAt,
      );
    return this.remoteExecutorConnectionView(connection);
  }

  updateRemoteExecutorConnection(
    id: string,
    name: string,
    endpointUrl: string,
    accessToken: string,
    workspaceRoot: string,
  ): RemoteExecutorConnectionView {
    const result = this.db
      .prepare(
        `UPDATE remote_executor_connections
         SET name = ?, endpoint_url = ?, access_token = ?, workspace_root = ? WHERE id = ?`,
      )
      .run(name, endpointUrl, accessToken, workspaceRoot, id);
    if (result.changes === 0) throw new Error('Remote Executor connection not found');
    return this.listRemoteExecutorConnections().find((connection) => connection.id === id)!;
  }

  listRemoteExecutorConnections(): RemoteExecutorConnectionView[] {
    const rows = this.db
      .prepare('SELECT * FROM remote_executor_connections ORDER BY created_at DESC')
      .all() as SqlRow[];
    return rows.map((row) =>
      this.remoteExecutorConnectionView({
        id: String(row.id),
        name: String(row.name),
        endpointUrl: String(row.endpoint_url),
        accessToken: String(row.access_token),
        workspaceRoot: String(row.workspace_root),
        createdAt: String(row.created_at),
      }),
    );
  }

  getRemoteExecutorConnection(id: string): RemoteExecutorConnection | null {
    const row = this.db.prepare('SELECT * FROM remote_executor_connections WHERE id = ?').get(id) as SqlRow | undefined;
    return row
      ? {
          id: String(row.id),
          name: String(row.name),
          endpointUrl: String(row.endpoint_url),
          accessToken: String(row.access_token),
          workspaceRoot: String(row.workspace_root),
          createdAt: String(row.created_at),
        }
      : null;
  }

  private remoteExecutorConnectionView(connection: RemoteExecutorConnection): RemoteExecutorConnectionView {
    return {
      id: connection.id,
      name: connection.name,
      endpointUrl: connection.endpointUrl,
      workspaceRoot: connection.workspaceRoot,
      createdAt: connection.createdAt,
      hasAccessToken: connection.accessToken.length > 0,
    };
  }
}
