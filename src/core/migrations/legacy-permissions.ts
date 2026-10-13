import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid legacy permission data');
  return parsed as Record<string, unknown>;
}

/** One-time ownership migration; old canonical audit records remain untouched. */
export function migrateLegacyPermissions(db: DatabaseSync): void {
  const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get();
  const settings = db.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'permissions:%'").all() as Row[];
  if (!legacyTable && settings.length === 0) return;
  db.exec('BEGIN IMMEDIATE;');
  try {
    const read = (key: string): Record<string, unknown> => {
      const row = db
        .prepare('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND key = ?')
        .get('pico.permissions', key) as Row | undefined;
      return object(row?.value_json);
    };
    const rules = read('rules');
    for (const setting of settings) {
      const threadId = String(setting.key).slice('permissions:'.length);
      const previous = rules[threadId];
      rules[threadId] = {
        ...object(setting.value_json),
        ...(previous && typeof previous === 'object' ? previous : {}),
      };
    }
    const approvals = read('approvals');
    if (legacyTable) {
      const rows = db
        .prepare(
          `SELECT a.*, e.thread_id, e.tool_name, e.arguments_json
        FROM approvals a JOIN executions e ON e.id = a.execution_id`,
        )
        .all() as Row[];
      for (const row of rows) {
        const executionId = String(row.execution_id);
        if (!(executionId in approvals))
          approvals[executionId] = {
            executionId,
            threadId: String(row.thread_id),
            toolName: String(row.tool_name),
            arguments: object(row.arguments_json),
            status: String(row.status),
            createdAt: String(row.created_at),
          };
      }
    }
    const write = db.prepare(`INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
    const now = new Date().toISOString();
    write.run('pico.permissions', 'rules', JSON.stringify(rules), now);
    write.run('pico.permissions', 'approvals', JSON.stringify(approvals), now);
    if (legacyTable) db.exec('DROP TABLE approvals;');
    db.prepare("DELETE FROM settings WHERE key LIKE 'permissions:%'").run();
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
