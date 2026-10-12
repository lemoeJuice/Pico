import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stableJson, type RemoteExecutionRequest, type RemoteExecutionState } from './remote-protocol.js';

interface LedgerRow {
  execution_id: string;
  request_hash: string;
  request_json: string;
  status: RemoteExecutionState['status'];
  result_json: string | null;
  error: string | null;
}

export class RemoteExecutionLedger {
  readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') {
      try {
        chmodSync(filename, 0o600);
      } catch {
        // The data directory may be managed by the host.
      }
    }
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS remote_executions (
        execution_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'interrupted')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createIfAbsent(
    id: string,
    identity: unknown,
    request: RemoteExecutionRequest,
  ): { state: RemoteExecutionState; inserted: boolean } {
    const requestHash = stableJson(identity);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db.prepare('SELECT * FROM remote_executions WHERE execution_id = ?').get(id) as
        LedgerRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new Error(`Execution ID ${id} was reused with different tool input.`);
        }
        this.db.exec('COMMIT;');
        return { state: this.fromRow(existing), inserted: false };
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO remote_executions
            (execution_id, request_hash, request_json, status, result_json, error, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        )
        .run(id, requestHash, JSON.stringify(request), now, now);
      this.db.exec('COMMIT;');
      return { state: { id, status: 'pending' }, inserted: true };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  get(id: string): RemoteExecutionState | null {
    const row = this.db.prepare('SELECT * FROM remote_executions WHERE execution_id = ?').get(id) as
      LedgerRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  getRequest(id: string): RemoteExecutionRequest | null {
    const row = this.db.prepare('SELECT request_json FROM remote_executions WHERE execution_id = ?').get(id) as
      { request_json: string } | undefined;
    return row ? (JSON.parse(row.request_json) as RemoteExecutionRequest) : null;
  }

  transition(
    id: string,
    status: RemoteExecutionState['status'],
    data: { result?: unknown; error?: string } = {},
  ): RemoteExecutionState {
    const current = this.get(id);
    if (!current) throw new Error(`Execution ${id} was not durably accepted.`);
    if (current.status === status) return current;
    const transitions: Record<RemoteExecutionState['status'], RemoteExecutionState['status'][]> = {
      pending: ['running', 'completed', 'failed', 'interrupted'],
      running: ['completed', 'failed', 'interrupted'],
      completed: [],
      failed: [],
      interrupted: [],
    };
    if (!transitions[current.status].includes(status)) {
      throw new Error(`Invalid remote execution transition ${current.status} → ${status}`);
    }
    const resultJson = Object.hasOwn(data, 'result') ? JSON.stringify(data.result) : null;
    this.db
      .prepare(
        `UPDATE remote_executions SET status = ?, result_json = COALESCE(?, result_json),
           error = ?, updated_at = ? WHERE execution_id = ?`,
      )
      .run(status, resultJson, data.error ?? null, new Date().toISOString(), id);
    return this.get(id)!;
  }

  private fromRow(row: LedgerRow): RemoteExecutionState {
    return {
      id: row.execution_id,
      status: row.status,
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }
}
