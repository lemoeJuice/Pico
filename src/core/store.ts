import { ServiceError } from '../contracts/service-error.js';
import { migrateLegacyPermissions } from './migrations/legacy-permissions.js';
import { migrateLegacyChatGptPreferences } from './migrations/legacy-chatgpt-preferences.js';
import { assertPluginStateWriteAllowed, migrateLegacyPluginStorage } from './migrations/legacy-plugin-storage.js';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_THREAD_TITLE } from './types.js';
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
  ThreadModelSelection,
  TokenUsage,
  ToolCall,
  ToolResultPayload,
} from './types.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import type { McpToolTarget } from '../executor/tool-catalog.js';
export type { PluginModelCallRecord } from '../contracts/store.js';

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
  toolCalls: Array<{
    call: ToolCall;
    executionId: string;
    source?: 'runtime' | 'executor' | 'mcp';
    mcpTarget?: McpToolTarget;
  }>;
  createdAt?: string;
}

export class PicoStore {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;
  private readonly canonicalListeners = new Set<(record: CanonicalRecord) => void>();
  private readonly stateListeners = new Set<(pluginId: string) => void>();
  private readonly pluginModelCallListeners = new Set<(call: PluginModelCallRecord) => void>();
  private pendingNotifications: Array<() => void> = [];

  subscribeCanonical(listener: (record: CanonicalRecord) => void): () => void {
    this.canonicalListeners.add(listener);
    return () => this.canonicalListeners.delete(listener);
  }

  subscribePluginState(listener: (pluginId: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribePluginModelCalls(listener: (call: PluginModelCallRecord) => void): () => void {
    this.pluginModelCallListeners.add(listener);
    return () => this.pluginModelCallListeners.delete(listener);
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
        created_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS threads_project_created ON threads(project_id, created_at);
      CREATE TABLE IF NOT EXISTS thread_create_requests (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canonical_records (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id),
        scope_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scope_key, seq)
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
      CREATE TABLE IF NOT EXISTS tool_execution_routes (
        execution_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('runtime', 'executor', 'mcp')),
        mcp_target_json TEXT
      );
      CREATE TABLE IF NOT EXISTS store_migrations (name TEXT PRIMARY KEY);
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
      CREATE TABLE IF NOT EXISTS plugin_model_calls (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT,
        thread_id TEXT,
        project_id TEXT,
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        response_json TEXT,
        usage_json TEXT,
        attempts_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(plugin_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS plugin_model_calls_thread_created
        ON plugin_model_calls(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS plugin_model_calls_project_created
        ON plugin_model_calls(project_id, created_at);
      CREATE TABLE IF NOT EXISTS thread_model_selections (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        selection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS private_secrets (
        owner TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(owner, key)
      );
      CREATE TABLE IF NOT EXISTS plugin_cache (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(plugin_id, key)
      );
    `);
    this.migrateCanonicalScopes();
    this.migrateExecutionLogIndependence();
    this.migrateRemoteExecutorBindings();
    this.migrateRuntimeExecutorKind();
    this.migrateThreadVisibility();
    this.migratePluginModelCallFingerprint();
    migrateLegacyPermissions(this.db);
    migrateLegacyChatGptPreferences(this.db);
    this.importLegacyWorkflowViews();
    this.migrateToolExecutionRoutes();
  }

  private migrateToolExecutionRoutes(): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM store_migrations WHERE name = 'tool-execution-routes-v1'").get()) return;
      const rows = this.db
        .prepare(
          `SELECT x.id, x.thread_id, l.detail_json, l.created_at
        FROM executions x JOIN execution_log l ON l.execution_id = x.id AND l.kind = 'tool-source'
        WHERE x.kind = 'tool' ORDER BY l.created_at DESC, l.id DESC`,
        )
        .all() as SqlRow[];
      const seen = new Set<string>();
      for (const row of rows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        const detail = json<Record<string, unknown>>(row.detail_json, {});
        if (detail.source !== 'runtime' && detail.source !== 'executor' && detail.source !== 'mcp') continue;
        const target = detail.mcpTarget as McpToolTarget | undefined;
        if (
          detail.source === 'mcp' &&
          (!target ||
            typeof target.serverId !== 'string' ||
            !target.serverId.trim() ||
            typeof target.toolKey !== 'string' ||
            !target.toolKey.trim())
        )
          continue;
        if (detail.source !== 'mcp' && target) continue;
        const normalizedTarget = target ? { serverId: target.serverId, toolKey: target.toolKey } : undefined;
        this.saveToolExecutionRouting(
          id,
          String(row.thread_id),
          detail.source,
          normalizedTarget,
          String(row.created_at),
        );
      }
      this.db.prepare("INSERT INTO store_migrations (name) VALUES ('tool-execution-routes-v1')").run();
    });
  }

  getToolExecutionRouting(
    executionId: string,
  ): { source: 'runtime' | 'executor' | 'mcp'; mcpTarget?: McpToolTarget } | null {
    const row = this.db
      .prepare('SELECT source, mcp_target_json FROM tool_execution_routes WHERE execution_id = ?')
      .get(executionId) as SqlRow | undefined;
    if (!row) return null;
    const target = json<McpToolTarget | null>(row.mcp_target_json, null);
    return {
      source: row.source as 'runtime' | 'executor' | 'mcp',
      ...(target ? { mcpTarget: { serverId: target.serverId, toolKey: target.toolKey } } : {}),
    };
  }

  private saveToolExecutionRouting(
    executionId: string,
    threadId: string,
    source: 'runtime' | 'executor' | 'mcp',
    mcpTarget: McpToolTarget | undefined,
    createdAt: string,
  ): void {
    if (source === 'mcp') {
      if (
        !mcpTarget ||
        typeof mcpTarget.serverId !== 'string' ||
        !mcpTarget.serverId.trim() ||
        typeof mcpTarget.toolKey !== 'string' ||
        !mcpTarget.toolKey.trim()
      ) {
        throw new Error(`Tool execution ${executionId} requires a valid MCP target.`);
      }
    } else if (mcpTarget) {
      throw new Error(`Tool execution ${executionId} cannot have an MCP target for source ${source}.`);
    }
    const current = this.getToolExecutionRouting(executionId);
    if (current) {
      if (
        current.source !== source ||
        current.mcpTarget?.serverId !== mcpTarget?.serverId ||
        current.mcpTarget?.toolKey !== mcpTarget?.toolKey
      ) {
        throw new Error(`Tool execution ${executionId} routing changed on retry.`);
      }
      return;
    }
    const normalizedTarget = mcpTarget ? { serverId: mcpTarget.serverId, toolKey: mcpTarget.toolKey } : undefined;
    const value = { executionId, source, ...(normalizedTarget ? { mcpTarget: normalizedTarget } : {}) };
    this.workflowFact(`thread:${threadId}`, `tool-routing:${executionId}`, value, randomUUID(), createdAt);
    this.db
      .prepare('INSERT INTO tool_execution_routes (execution_id, source, mcp_target_json) VALUES (?, ?, ?)')
      .run(executionId, source, normalizedTarget ? JSON.stringify(normalizedTarget) : null);
  }

  private migrateCanonicalScopes(): void {
    const columns = this.db.prepare('PRAGMA table_info(canonical_records)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'scope_key')) return;
    this.db.exec(`
      DROP TRIGGER IF EXISTS canonical_records_no_update;
      DROP TRIGGER IF EXISTS canonical_records_no_delete;
      DROP INDEX IF EXISTS canonical_thread_seq;
      DROP INDEX IF EXISTS canonical_thread_kind_seq;
      ALTER TABLE canonical_records RENAME TO canonical_records_legacy_scope;
      CREATE TABLE canonical_records (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES threads(id),
        scope_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scope_key, seq)
      );
      INSERT INTO canonical_records (id, thread_id, scope_key, seq, kind, payload_json, created_at)
        SELECT id, thread_id, 'thread:' || thread_id, seq, kind, payload_json, created_at
        FROM canonical_records_legacy_scope;
      DROP TABLE canonical_records_legacy_scope;
      CREATE INDEX canonical_thread_seq ON canonical_records(thread_id, seq);
      CREATE INDEX canonical_thread_kind_seq ON canonical_records(thread_id, kind, seq);
      CREATE TRIGGER canonical_records_no_update BEFORE UPDATE ON canonical_records BEGIN
        SELECT RAISE(ABORT, 'canonical records are append-only');
      END;
      CREATE TRIGGER canonical_records_no_delete BEFORE DELETE ON canonical_records BEGIN
        SELECT RAISE(ABORT, 'canonical records are append-only');
      END;
    `);
  }

  private migrateExecutionLogIndependence(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_log'")
      .get() as SqlRow | undefined;
    if (typeof schema?.sql !== 'string' || !schema.sql.includes('REFERENCES executions')) return;
    this.db.exec(`
      DROP TRIGGER IF EXISTS execution_log_no_update;
      DROP TRIGGER IF EXISTS execution_log_no_delete;
      ALTER TABLE execution_log RENAME TO execution_log_legacy_fk;
      CREATE TABLE execution_log (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO execution_log SELECT * FROM execution_log_legacy_fk;
      DROP TABLE execution_log_legacy_fk;
      CREATE TRIGGER execution_log_no_update BEFORE UPDATE ON execution_log BEGIN
        SELECT RAISE(ABORT, 'execution log is append-only');
      END;
      CREATE TRIGGER execution_log_no_delete BEFORE DELETE ON execution_log BEGIN
        SELECT RAISE(ABORT, 'execution log is append-only');
      END;
    `);
  }

  private workflowFact(
    scope: string,
    key: string,
    value: unknown,
    id: string = randomUUID(),
    createdAt = isoNow(),
  ): void {
    this.appendCanonicalInternal(
      null,
      id,
      'plugin',
      {
        __picoWorkflow: { version: 1, scope, key, value },
      },
      createdAt,
      `workflow:${scope}`,
    );
  }

  private importLegacyWorkflowViews(): void {
    this.transaction(() => {
      const legacyId = (scope: string, key: string): string =>
        `legacy-import:${createHash('sha256').update(`${scope}\0${key}`).digest('hex')}`;
      const threads = this.db.prepare('SELECT id, pause_requested, pause_reason FROM threads').all() as SqlRow[];
      for (const row of threads) {
        const id = String(row.id);
        const value = { pauseRequested: row.pause_requested === 1, pauseReason: row.pause_reason ?? null };
        const key = `pause:${id}`;
        if (!this.getCanonicalRecordById(legacyId(`thread:${id}`, key))) {
          this.workflowFact(`thread:${id}`, key, value, legacyId(`thread:${id}`, key));
        }
      }
      const executions = this.db.prepare('SELECT * FROM executions ORDER BY created_at, id').all() as SqlRow[];
      for (const row of executions) {
        const execution = this.executionFromRow(row);
        const key = `execution:${execution.id}`;
        const scope = `thread:${execution.threadId}`;
        if (!this.getCanonicalRecordById(legacyId(scope, key))) {
          this.workflowFact(scope, key, execution, legacyId(scope, key), execution.createdAt);
        }
      }
      const states = this.db.prepare('SELECT * FROM plugin_state ORDER BY plugin_id, key').all() as SqlRow[];
      for (const row of states) {
        const pluginId = String(row.plugin_id);
        const keyName = String(row.key);
        if (
          migrateLegacyPluginStorage(pluginId, keyName, json(row.value_json, null), {
            setPrivateSecret: (owner, key, value) => this.setPrivateSecret(owner, key, value),
            setPluginCache: (id, key, value) => this.setPluginCache(id, key, value),
            deleteLegacyState: (id, key) => {
              this.db.prepare('DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?').run(id, key);
            },
          })
        ) {
          continue;
        }
        const scope = 'global';
        const key = `plugin-state:${pluginId}:${keyName}`;
        if (!this.getCanonicalRecordById(legacyId(scope, key))) {
          this.workflowFact(
            scope,
            key,
            { pluginId, key: keyName, value: json(row.value_json, null) },
            legacyId(scope, key),
          );
        }
      }
      const calls = this.db.prepare('SELECT * FROM plugin_model_calls ORDER BY created_at, id').all() as SqlRow[];
      for (const row of calls) {
        const call = this.pluginModelCallFromRow(row);
        const scope = call.threadId
          ? `thread:${call.threadId}`
          : call.projectId
            ? `project:${call.projectId}`
            : 'global';
        const key = `plugin-model-call:${call.pluginId}:${call.idempotencyKey}`;
        if (!this.getCanonicalRecordById(legacyId(scope, key))) {
          this.workflowFact(scope, key, { ...call, prompt: null, attempts: [] }, legacyId(scope, key), call.createdAt);
        }
      }
    });
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

  private migrateThreadVisibility(): void {
    const columns = this.db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'archived_at')) {
      this.db.exec('ALTER TABLE threads ADD COLUMN archived_at TEXT;');
    }
    if (!columns.some((column) => column.name === 'deleted_at')) {
      this.db.exec('ALTER TABLE threads ADD COLUMN deleted_at TEXT;');
    }
  }

  private migratePluginModelCallFingerprint(): void {
    const columns = this.db.prepare('PRAGMA table_info(plugin_model_calls)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'request_fingerprint')) {
      this.db.exec('ALTER TABLE plugin_model_calls ADD COLUMN request_fingerprint TEXT;');
    }
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

  createThread(...args: Parameters<PicoStore['createThreadWithResult']>): Thread {
    return this.createThreadWithResult(...args).thread;
  }

  createThreadWithResult(
    projectId: string,
    executorKind: ExecutorKind,
    title = DEFAULT_THREAD_TITLE,
    options: {
      parentThreadId?: string | null;
      createdByAgent?: boolean;
      remoteConnectionId?: string | null;
      workspacePath?: string;
      idempotencyKey?: string;
      modelSelection?: ThreadModelSelection;
      toolOverrides?: Record<string, boolean>;
    } = {},
  ): { thread: Thread; created: boolean } {
    const project = this.getProject(projectId);
    if (!project) throw new ServiceError(404, 'Project not found');
    const remoteConnection = options.remoteConnectionId
      ? this.getRemoteExecutorConnection(options.remoteConnectionId)
      : null;
    if (options.remoteConnectionId && !remoteConnection) throw new ServiceError(404, 'Remote Executor connection not found');
    if (remoteConnection && executorKind !== 'host')
      throw new ServiceError(400, 'Remote Host Executor must use Host execution kind');
    const workspacePath = executorKind === 'runtime' ? '' : (options.workspacePath ?? project.workspacePath);
    const idempotencyKey = options.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 240) throw new ServiceError(400, 'Thread creation idempotency key is too long.');
    const requestHash = idempotencyKey
      ? createHash('sha256')
          .update(
            JSON.stringify({
              projectId,
              executorKind,
              title,
              parentThreadId: options.parentThreadId ?? null,
              createdByAgent: options.createdByAgent ?? false,
              remoteConnectionId: remoteConnection?.id ?? null,
              workspacePath,
              modelSelection: options.modelSelection ?? null,
              toolOverrides: options.toolOverrides
                ? Object.fromEntries(
                    Object.entries(options.toolOverrides).sort(([left], [right]) => left.localeCompare(right)),
                  )
                : null,
            }),
          )
          .digest('hex')
      : null;
    const kindLabel = remoteConnection
      ? `Remote Host · ${remoteConnection.name}`
      : executorKind === 'container'
        ? 'Container'
        : executorKind === 'runtime'
          ? 'Chat'
          : 'Host';
    const label = `${kindLabel} · ${project.name}`;
    return this.transaction(() => {
      if (idempotencyKey && requestHash) {
        const existing = this.db
          .prepare('SELECT request_hash, thread_id FROM thread_create_requests WHERE idempotency_key = ?')
          .get(idempotencyKey) as SqlRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new ServiceError(409, 'Thread creation idempotency key was already used with different parameters.');
          }
          const previous = this.getThread(String(existing.thread_id));
          if (!previous) throw new Error('The Thread created for this idempotency key no longer exists.');
          return { thread: previous, created: false };
        }
      }
      const id = randomUUID();
      const executorId = randomUUID();
      const createdAt = isoNow();
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
      if (idempotencyKey && requestHash) {
        this.db
          .prepare(
            'INSERT INTO thread_create_requests (idempotency_key, request_hash, thread_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(idempotencyKey, requestHash, id, createdAt);
      }
      if (options.modelSelection) {
        this.db
          .prepare('INSERT INTO thread_model_selections (thread_id, selection_json, updated_at) VALUES (?, ?, ?)')
          .run(id, JSON.stringify(options.modelSelection), createdAt);
        this.workflowFact(
          `thread:${id}`,
          `thread-model-selection:${id}`,
          options.modelSelection,
          randomUUID(),
          createdAt,
        );
      }
      const thread: Thread = {
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
        archivedAt: null,
        deletedAt: null,
        state: 'idle',
      };
      return { thread, created: true };
    });
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

  updateThreadTitle(threadId: string, title: string): Thread | null {
    const result = this.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, threadId);
    if (Number(result.changes) === 0) return null;
    return this.getThread(threadId);
  }

  listThreadTree(threadId: string): Thread[] {
    const rows = this.db
      .prepare(
        `
        WITH RECURSIVE thread_tree(id) AS (
          SELECT id FROM threads WHERE id = ?
          UNION
          SELECT child.id FROM threads child JOIN thread_tree parent ON child.parent_thread_id = parent.id
        )
        SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
               e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
        FROM thread_tree tree
        JOIN threads t ON t.id = tree.id
        JOIN executors e ON e.id = t.executor_id
      `,
      )
      .all(threadId) as SqlRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  archiveThreadTree(threadId: string, archivedAt = isoNow()): Thread[] {
    return this.transaction(() => {
      const tree = this.listThreadTree(threadId);
      const update = this.db.prepare(
        'UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL',
      );
      const archived: Thread[] = [];
      for (const candidate of tree) {
        if (candidate.archivedAt || candidate.deletedAt) continue;
        const result = update.run(archivedAt, candidate.id);
        if (Number(result.changes) > 0) {
          const thread = this.getThread(candidate.id);
          if (thread) archived.push(thread);
        }
      }
      return archived;
    });
  }

  archiveThread(threadId: string, archivedAt = isoNow()): Thread | null {
    this.archiveThreadTree(threadId, archivedAt);
    return this.getThread(threadId);
  }

  unarchiveThread(threadId: string): Thread | null {
    this.db.prepare('UPDATE threads SET archived_at = NULL WHERE id = ? AND deleted_at IS NULL').run(threadId);
    return this.getThread(threadId);
  }

  hideArchivedThread(threadId: string, deletedAt = isoNow()): Thread | null {
    this.db
      .prepare('UPDATE threads SET deleted_at = ? WHERE id = ? AND archived_at IS NOT NULL AND deleted_at IS NULL')
      .run(deletedAt, threadId);
    return this.getThread(threadId);
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
          WHERE t.project_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
          ORDER BY t.created_at DESC
        `,
            )
            .all(projectId)
        : this.db
            .prepare(
              `
          SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
                 e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
          FROM threads t JOIN executors e ON e.id = t.executor_id
          WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
          ORDER BY t.created_at DESC
        `,
            )
            .all()
    ) as SqlRow[];
    return rows.map((row) => this.threadFromRow(row));
  }

  listArchivedThreads(): Thread[] {
    const rows = this.db
      .prepare(
        `
        SELECT t.*, e.kind AS executor_kind, e.label AS executor_label,
               e.workspace_path AS workspace_path, e.remote_connection_id AS executor_remote
        FROM threads t JOIN executors e ON e.id = t.executor_id
        WHERE t.archived_at IS NOT NULL AND t.deleted_at IS NULL
        ORDER BY t.archived_at DESC, t.created_at DESC
      `,
      )
      .all() as SqlRow[];
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
      archivedAt: typeof row.archived_at === 'string' ? row.archived_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
      state: row.pause_requested === 1 ? 'paused' : 'idle',
    };
  }

  setPause(threadId: string, paused: boolean, reason: string | null = null): void {
    this.transaction(() => {
      const result = this.db
        .prepare('UPDATE threads SET pause_requested = ?, pause_reason = ? WHERE id = ?')
        .run(paused ? 1 : 0, paused ? reason : null, threadId);
      if (result.changes === 0) throw new ServiceError(404, 'Thread not found');
      this.workflowFact(`thread:${threadId}`, `pause:${threadId}`, {
        pauseRequested: paused,
        pauseReason: paused ? reason : null,
      });
    });
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

  listScopedCanonical(scope: string): CanonicalRecord[] {
    return (
      this.db.prepare('SELECT * FROM canonical_records WHERE scope_key = ? ORDER BY seq').all(scope) as SqlRow[]
    ).map((row) => this.recordFromRow(row));
  }

  getPrivateSecret<T>(owner: string, key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value_json FROM private_secrets WHERE owner = ? AND key = ?')
      .get(owner, key) as SqlRow | undefined;
    return row ? json(row.value_json, fallback) : fallback;
  }

  setPrivateSecret<T>(owner: string, key: string, value: T): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Private secret must be JSON serializable');
    this.db
      .prepare(
        `INSERT INTO private_secrets (owner, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(owner, key, serialized, isoNow());
  }

  deletePrivateSecret(owner: string, key: string): void {
    this.db.prepare('DELETE FROM private_secrets WHERE owner = ? AND key = ?').run(owner, key);
  }

  getPluginCache<T>(pluginId: string, key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value_json FROM plugin_cache WHERE plugin_id = ? AND key = ?')
      .get(pluginId, key) as SqlRow | undefined;
    return row ? json(row.value_json, fallback) : fallback;
  }

  setPluginCache<T>(pluginId: string, key: string, value: T): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Plugin cache must be JSON serializable');
    this.db
      .prepare(
        `INSERT INTO plugin_cache (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(pluginId, key, serialized, isoNow());
  }

  rebuildWorkflowViews(): void {
    this.transaction(() => {
      this.db.exec(
        'DELETE FROM tool_execution_routes; DELETE FROM executions; DELETE FROM plugin_state; DELETE FROM plugin_model_calls; DELETE FROM thread_model_selections;',
      );
      this.db.prepare('UPDATE threads SET pause_requested = 0, pause_reason = NULL').run();
      const facts = this.db
        .prepare(
          `SELECT * FROM canonical_records
        WHERE scope_key LIKE 'workflow:%' AND kind = 'plugin' ORDER BY scope_key, seq`,
        )
        .all() as SqlRow[];
      for (const row of facts) {
        const envelope = json<Record<string, unknown>>(row.payload_json, {}).__picoWorkflow as
          Record<string, unknown> | undefined;
        if (
          !envelope ||
          envelope.version !== 1 ||
          typeof envelope.scope !== 'string' ||
          typeof envelope.key !== 'string'
        )
          continue;
        const value = envelope.value as Record<string, unknown> | null;
        if (!value) continue;
        if (envelope.key.startsWith('pause:')) {
          const threadId = envelope.key.slice('pause:'.length);
          this.db
            .prepare('UPDATE threads SET pause_requested = ?, pause_reason = ? WHERE id = ?')
            .run(
              value.pauseRequested ? 1 : 0,
              value.pauseRequested ? String(value.pauseReason ?? '') || null : null,
              threadId,
            );
        } else if (envelope.key.startsWith('execution:')) {
          const e = value as unknown as Execution;
          this.db
            .prepare(
              `INSERT OR REPLACE INTO executions
            (id, thread_id, batch_id, kind, tool_name, arguments_json, status, result_json, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              e.id,
              e.threadId,
              e.batchId,
              e.kind,
              e.toolName,
              JSON.stringify(e.arguments),
              e.status,
              e.result === null ? null : JSON.stringify(e.result),
              e.error,
              e.createdAt,
              e.updatedAt,
            );
        } else if (envelope.key.startsWith('tool-routing:')) {
          const route = value as { executionId: string; source: string; mcpTarget?: McpToolTarget };
          this.db
            .prepare('INSERT INTO tool_execution_routes (execution_id, source, mcp_target_json) VALUES (?, ?, ?)')
            .run(route.executionId, route.source, route.mcpTarget ? JSON.stringify(route.mcpTarget) : null);
        } else if (envelope.key.startsWith('plugin-state:')) {
          const s = value as { pluginId?: unknown; key?: unknown; value?: unknown };
          if (typeof s.pluginId !== 'string' || typeof s.key !== 'string') continue;
          this.db
            .prepare('INSERT OR REPLACE INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
            .run(s.pluginId, s.key, JSON.stringify(s.value), String(row.created_at));
        } else if (envelope.key.startsWith('thread-model-selection:')) {
          const threadId = envelope.key.slice('thread-model-selection:'.length);
          this.db
            .prepare(
              'INSERT OR REPLACE INTO thread_model_selections (thread_id, selection_json, updated_at) VALUES (?, ?, ?)',
            )
            .run(threadId, JSON.stringify(value), String(row.created_at));
        } else if (envelope.key.startsWith('plugin-model-call:')) {
          const c = value as unknown as PluginModelCallRecord;
          this.db
            .prepare(
              `INSERT OR REPLACE INTO plugin_model_calls
            (id, plugin_id, idempotency_key, request_fingerprint, thread_id, project_id, purpose, provider, model, prompt_json, status,
             response_json, usage_json, attempts_json, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              c.id,
              c.pluginId,
              c.idempotencyKey,
              c.requestFingerprint ?? null,
              c.threadId,
              c.projectId,
              c.purpose,
              c.provider,
              c.model,
              'null',
              c.status,
              c.response === null ? null : JSON.stringify(c.response),
              c.usage === null ? null : JSON.stringify(c.usage),
              '[]',
              c.error,
              c.createdAt,
              c.updatedAt,
            );
        }
      }
    });
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

  appendScopedCanonical<T extends object>(
    scope: string,
    id: string,
    kind: CanonicalKind,
    payload: T,
    createdAt = isoNow(),
  ): AppendResult<T> {
    const cleanedScope = scope.trim();
    if (!cleanedScope || cleanedScope.length > 240 || cleanedScope.startsWith('thread:')) {
      throw new Error('A non-Thread canonical scope is required.');
    }
    return this.transaction(() => this.appendCanonicalInternal(null, id, kind, payload, createdAt, cleanedScope));
  }

  private appendCanonicalInternal<T extends object>(
    threadId: string | null,
    id: string,
    kind: CanonicalKind,
    payload: T,
    createdAt = isoNow(),
    explicitScope?: string,
  ): AppendResult<T> {
    const scope = explicitScope ?? `thread:${threadId}`;
    const existing = this.db.prepare('SELECT * FROM canonical_records WHERE id = ?').get(id) as SqlRow | undefined;
    if (existing) {
      const oldPayload = String(existing.payload_json);
      if (
        (existing.thread_id ?? null) !== threadId ||
        existing.scope_key !== scope ||
        existing.kind !== kind ||
        JSON.stringify(JSON.parse(oldPayload)) !== JSON.stringify(payload)
      ) {
        throw new Error(`Canonical record ID ${id} was reused with different content`);
      }
      return { record: this.recordFromRow(existing) as CanonicalRecord<T>, inserted: false };
    }
    const sequenceRow = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM canonical_records WHERE scope_key = ?')
      .get(scope) as SqlRow;
    const seq = Number(sequenceRow.next_seq);
    this.db
      .prepare(
        `
      INSERT INTO canonical_records (id, thread_id, scope_key, seq, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(id, threadId, scope, seq, kind, JSON.stringify(payload), createdAt);
    const record = { id, threadId, scope, seq, kind, payload, createdAt };
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
      threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
      scope: typeof row.scope_key === 'string' ? row.scope_key : `thread:${String(row.thread_id)}`,
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

  latestCanonicalSeq(threadId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM canonical_records WHERE thread_id = ?')
      .get(threadId) as SqlRow;
    return Number(row.seq);
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

  hasContextBranchFacts(threadId: string): boolean {
    // Any matching marker triggers the full projection path. Search conservatively so even
    // malformed or legacy payloads that mention a branch operation cannot be shown as active.
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM canonical_records
          WHERE thread_id = ? AND kind = 'plugin'
            AND (instr(payload_json, 'context-rewound') > 0 OR instr(payload_json, 'context-restored') > 0)
          LIMIT 1`)
        .get(threadId),
    );
  }

  listRecordPage(
    threadId: string,
    beforeSeq?: number,
    limit = 100,
    includeActiveBatchParents = true,
  ): CanonicalRecordPage {
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

    // Full snapshots keep the parent Model Step visible when an old Tool Batch is active.
    // The initial lightweight endpoint disables this compatibility behavior to stay bounded.
    if (includeActiveBatchParents && beforeSeq === undefined && records.length > 0) {
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
      for (const { call, executionId, source, mcpTarget } of input.toolCalls) {
        const existing = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId) as
          SqlRow | undefined;
        if (existing) {
          const routing = this.getToolExecutionRouting(executionId);
          if (source && !routing) throw new Error(`Tool execution ${executionId} routing is missing on retry.`);
          if (source) this.saveToolExecutionRouting(executionId, input.threadId, source, mcpTarget, createdAt);
          else if (routing) throw new Error(`Tool execution ${executionId} routing changed on retry.`);
          continue;
        }
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
        if (source) {
          this.saveToolExecutionRouting(executionId, input.threadId, source, mcpTarget, createdAt);
          this.logExecution(executionId, 'tool-source', { source, ...(mcpTarget ? { mcpTarget } : {}) }, createdAt);
        }
        const createdExecution = this.getExecution(executionId);
        if (createdExecution) this.snapshotExecution(createdExecution);
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
        const completedExecution = this.getExecution(input.modelExecutionId);
        if (completedExecution) this.snapshotExecution(completedExecution);
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
    activePathRewindId?: string | null,
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
            ...(activePathRewindId === undefined ? {} : { activePathRewindId }),
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
          ...(activePathRewindId === undefined ? {} : { activePathRewindId }),
        },
        now,
      );
      const execution = this.getExecution(id)!;
      this.snapshotExecution(execution);
      return execution;
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
      const updated = this.getExecution(id)!;
      this.snapshotExecution(updated);
      return updated;
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
      const updated = this.getExecution(id)!;
      this.snapshotExecution(updated);
      return updated;
    });
  }

  recordExecutionError(id: string, error: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(id);
      if (!current) throw new Error(`Execution ${id} not found`);
      if (current.status !== 'pending' && current.status !== 'running') return current;
      const now = isoNow();
      this.db.prepare('UPDATE executions SET error = ?, updated_at = ? WHERE id = ?').run(error, now, id);
      this.logExecution(id, 'execution-error', { error }, now);
      const updated = this.getExecution(id)!;
      this.snapshotExecution(updated);
      return updated;
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
    const updated = this.getExecution(id)!;
    this.snapshotExecution(updated);
    return updated;
  }

  private snapshotExecution(execution: Execution): void {
    this.workflowFact(
      `thread:${execution.threadId}`,
      `execution:${execution.id}`,
      execution,
      randomUUID(),
      execution.updatedAt,
    );
  }

  private logExecution(id: string, kind: string, detail: Record<string, unknown>, createdAt = isoNow()): void {
    try {
      this.db
        .prepare(
          `
      INSERT INTO execution_log (id, execution_id, kind, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
        )
        .run(randomUUID(), id, kind, JSON.stringify(detail), createdAt);
    } catch {
      // Diagnostics are best effort; workflow facts and views remain authoritative.
    }
  }

  appendExecutionLog(executionId: string, kind: string, detail: Record<string, unknown>): void {
    if (!this.getExecution(executionId)) throw new Error(`Execution ${executionId} not found`);
    try {
      this.logExecution(executionId, kind, detail);
    } catch {
      // Keep the explicit public diagnostic API best effort too.
    }
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

  getPluginModelCall(id: string): PluginModelCallRecord | null {
    const row = this.db.prepare('SELECT * FROM plugin_model_calls WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.pluginModelCallFromRow(row) : null;
  }

  findPluginModelCall(pluginId: string, idempotencyKey: string): PluginModelCallRecord | null {
    const row = this.db
      .prepare('SELECT * FROM plugin_model_calls WHERE plugin_id = ? AND idempotency_key = ?')
      .get(pluginId, idempotencyKey) as SqlRow | undefined;
    return row ? this.pluginModelCallFromRow(row) : null;
  }

  savePluginModelCall(call: PluginModelCallRecord): PluginModelCallRecord {
    return this.transaction(() => {
      const current = this.findPluginModelCall(call.pluginId, call.idempotencyKey);
      const createdAt = current?.createdAt ?? call.createdAt;
      this.db
        .prepare(
          `INSERT INTO plugin_model_calls (
          id, plugin_id, idempotency_key, request_fingerprint, thread_id, project_id, purpose, provider, model,
          prompt_json, status, response_json, usage_json, attempts_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id, idempotency_key) DO UPDATE SET
          request_fingerprint = excluded.request_fingerprint,
          thread_id = excluded.thread_id, project_id = excluded.project_id, purpose = excluded.purpose,
          provider = excluded.provider, model = excluded.model, prompt_json = excluded.prompt_json,
          status = excluded.status, response_json = excluded.response_json, usage_json = excluded.usage_json,
          attempts_json = excluded.attempts_json, error = excluded.error, updated_at = excluded.updated_at`,
        )
        .run(
          current?.id ?? call.id,
          call.pluginId,
          call.idempotencyKey,
          call.requestFingerprint ?? null,
          call.threadId,
          call.projectId,
          call.purpose,
          call.provider,
          call.model,
          JSON.stringify(call.prompt),
          call.status,
          call.response === null ? null : JSON.stringify(call.response),
          call.usage === null ? null : JSON.stringify(call.usage),
          JSON.stringify(call.attempts),
          call.error,
          createdAt,
          call.updatedAt,
        );
      const saved = this.findPluginModelCall(call.pluginId, call.idempotencyKey)!;
      const scope = saved.threadId
        ? `thread:${saved.threadId}`
        : saved.projectId
          ? `project:${saved.projectId}`
          : 'global';
      this.workflowFact(
        scope,
        `plugin-model-call:${saved.pluginId}:${saved.idempotencyKey}`,
        {
          ...saved,
          prompt: null,
          attempts: [],
        },
        randomUUID(),
        saved.updatedAt,
      );
      this.notifyAfterCommit(() => {
        for (const listener of this.pluginModelCallListeners) this.dispatchNotification(() => listener(saved));
      });
      return saved;
    });
  }

  listPluginModelCalls(
    filter: { pluginId?: string; threadId?: string; projectId?: string } = {},
  ): PluginModelCallRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.pluginId !== undefined) {
      clauses.push('plugin_id = ?');
      values.push(filter.pluginId);
    }
    if (filter.threadId !== undefined) {
      clauses.push('thread_id = ?');
      values.push(filter.threadId);
    }
    if (filter.projectId !== undefined) {
      clauses.push('project_id = ?');
      values.push(filter.projectId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.db.prepare(`SELECT * FROM plugin_model_calls${where} ORDER BY created_at, id`).all(...values) as SqlRow[]
    ).map((row) => this.pluginModelCallFromRow(row));
  }

  private pluginModelCallFromRow(row: SqlRow): PluginModelCallRecord {
    return {
      id: String(row.id),
      pluginId: String(row.plugin_id),
      idempotencyKey: String(row.idempotency_key),
      requestFingerprint: typeof row.request_fingerprint === 'string' ? row.request_fingerprint : null,
      threadId: typeof row.thread_id === 'string' ? row.thread_id : null,
      projectId: typeof row.project_id === 'string' ? row.project_id : null,
      purpose: String(row.purpose),
      provider: String(row.provider),
      model: String(row.model),
      prompt: json<unknown>(row.prompt_json, null),
      status: row.status as PluginModelCallRecord['status'],
      response: json<unknown>(row.response_json, null),
      usage: json<TokenUsage | null>(row.usage_json, null),
      attempts: json<Array<Record<string, unknown>>>(row.attempts_json, []),
      error: typeof row.error === 'string' ? row.error : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getExecution(id: string): Execution | null {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? this.executionFromRow(row) : null;
  }

  getModelExecutionHandoffStates(
    threadId: string,
    executionIds: string[],
  ): Array<{
    executionId: string;
    status: ExecutionStatus | null;
    assistantSeq: number | null;
  }> {
    if (executionIds.length > 50) throw new Error('At most 50 execution IDs may be queried');
    const executionQuery = this.db.prepare(
      "SELECT status FROM executions WHERE id = ? AND thread_id = ? AND kind = 'model'",
    );
    const assistantQuery = this.db.prepare(
      "SELECT seq FROM canonical_records WHERE id = ? AND thread_id = ? AND kind = 'assistant'",
    );
    return executionIds.map((executionId) => {
      const execution = executionQuery.get(executionId, threadId) as SqlRow | undefined;
      if (!execution) return { executionId, status: null, assistantSeq: null };
      const assistant = assistantQuery.get(`${executionId}:assistant`, threadId) as SqlRow | undefined;
      return {
        executionId,
        status: execution.status as ExecutionStatus,
        assistantSeq: assistant ? Number(assistant.seq) : null,
      };
    });
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

  listRunningContainerExecutorWorkspacePaths(): string[] {
    const rows = this.db
      .prepare(
        `
      SELECT DISTINCT e.workspace_path
      FROM executions x
      JOIN threads t ON t.id = x.thread_id
      JOIN executors e ON e.id = t.executor_id
      LEFT JOIN tool_execution_routes r ON r.execution_id = x.id
      WHERE e.kind = 'container' AND x.kind = 'tool' AND x.status = 'running'
        AND (r.source = 'executor' OR r.source IS NULL)
    `,
      )
      .all() as SqlRow[];
    return rows.map((row) => String(row.workspace_path));
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

  getThreadModelSelection(threadId: string): ThreadModelSelection | null {
    const row = this.db
      .prepare('SELECT selection_json FROM thread_model_selections WHERE thread_id = ?')
      .get(threadId) as SqlRow | undefined;
    return row ? json<ThreadModelSelection | null>(row.selection_json, null) : null;
  }

  setThreadModelSelection(threadId: string, selection: ThreadModelSelection): ThreadModelSelection {
    if (!this.getThread(threadId)) throw new ServiceError(404, 'Thread not found');
    const serialized = JSON.stringify(selection);
    if (serialized === undefined) throw new Error('Thread ModelSelection must be JSON serializable');
    const updatedAt = isoNow();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO thread_model_selections (thread_id, selection_json, updated_at) VALUES (?, ?, ?)',
        )
        .run(threadId, serialized, updatedAt);
      this.workflowFact(`thread:${threadId}`, `thread-model-selection:${threadId}`, selection, randomUUID(), updatedAt);
    });
    return structuredClone(selection);
  }

  recordModelInvocation(threadId: string, invocationId: string, identity: Record<string, unknown>): void {
    if (!this.getThread(threadId)) throw new Error('Thread not found');
    this.transaction(() => {
      this.workflowFact(
        `thread:${threadId}`,
        `model-invocation:${invocationId}`,
        identity,
        `model-invocation:${createHash('sha256').update(`${threadId}\0${invocationId}`).digest('hex')}`,
      );
    });
  }

  setPluginState<T>(pluginId: string, key: string, value: T): void {
    assertPluginStateWriteAllowed(pluginId, key);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Plugin State must be JSON serializable');
    this.transaction(() => {
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
      this.workflowFact('global', `plugin-state:${pluginId}:${key}`, { pluginId, key, value }, randomUUID());
      this.notifyAfterCommit(() => {
        for (const listener of this.stateListeners) this.dispatchNotification(() => listener(pluginId));
      });
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
    if (result.changes === 0) throw new ServiceError(404, 'Remote Executor connection not found');
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
