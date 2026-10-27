import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface SqlRow {
  value_json: unknown;
}

function secureSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${databasePath}${suffix}`, 0o600);
    } catch {
      // SQLite creates the sidecar files only when needed.
    }
  }
}

export interface SharedChatGptOAuthSecrets {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

/** Opens a dedicated SQLite secret store shared by ChatGPT plugin instances. */
export function createSharedChatGptOAuthSecrets(filename: string, owner: string): SharedChatGptOAuthSecrets {
  const databasePath = resolve(filename);
  const runtimeDatabasePath = resolve(
    process.env.PICO_DB_PATH?.trim() || join(process.cwd(), 'data', 'pico.sqlite'),
  );
  if (databasePath === runtimeDatabasePath) {
    throw new Error('PICO_CHATGPT_OAUTH_DB_PATH must point to a dedicated OAuth database.');
  }

  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA busy_timeout = 30000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS private_secrets (
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner, key)
    );
  `);
  chmodSync(databasePath, 0o600);
  secureSidecars(databasePath);

  return {
    get<T>(key: string, fallback: T): T {
      const row = db
        .prepare('SELECT value_json FROM private_secrets WHERE owner = ? AND key = ?')
        .get(owner, key) as SqlRow | undefined;
      if (!row || typeof row.value_json !== 'string') return fallback;
      try {
        return JSON.parse(row.value_json) as T;
      } catch {
        return fallback;
      }
    },
    set<T>(key: string, value: T): void {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error('Private secret must be JSON serializable');
      db.prepare(
        `INSERT INTO private_secrets (owner, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(owner, key, serialized, new Date().toISOString());
      secureSidecars(databasePath);
    },
    delete(key: string): void {
      db.prepare('DELETE FROM private_secrets WHERE owner = ? AND key = ?').run(owner, key);
    },
    async withLock<T>(operation: () => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        // Unusable-token handling intentionally clears the stored credential before throwing.
        try {
          db.exec('COMMIT');
        } catch {
          try {
            db.exec('ROLLBACK');
          } catch {
            // Preserve the OAuth error that caused the transaction to unwind.
          }
        }
        throw error;
      }
    },
    close(): void {
      db.close();
    },
  };
}
