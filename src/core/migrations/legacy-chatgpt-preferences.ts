import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

/** One-time ownership migration for the former ChatGPT plugin's shared UI preferences. */
export function migrateLegacyChatGptPreferences(db: DatabaseSync): void {
  const marker = db
    .prepare("SELECT value_json FROM plugin_state WHERE plugin_id = 'pico.model-parameters' AND key = 'chatgptPreferencesV1Migrated'")
    .get() as Row | undefined;
  if (marker?.value_json === 'true') return;

  const source = db
    .prepare("SELECT value_json FROM plugin_state WHERE plugin_id = 'pico.chatgpt-plan' AND key = 'preferences'")
    .get() as Row | undefined;
  let migrated: Record<string, unknown> = {};
  if (typeof source?.value_json === 'string') {
    try {
      const value: unknown = JSON.parse(source.value_json);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const preferences = value as Record<string, unknown>;
        migrated = {
          ...(typeof preferences.reasoningEffort === 'string' ? { reasoningEffort: preferences.reasoningEffort } : {}),
          ...(typeof preferences.fastMode === 'boolean' ? { fastMode: preferences.fastMode } : {}),
        };
      }
    } catch {
      // Preserve an invalid legacy value in place and mark the attempted import complete.
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const now = new Date().toISOString();
    const hasTarget = db
      .prepare("SELECT 1 FROM plugin_state WHERE plugin_id = 'pico.model-parameters' AND key = 'legacyChatGptPreferences'")
      .get();
    if (!hasTarget && Object.keys(migrated).length > 0) {
      db.prepare('INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)').run(
        'pico.model-parameters',
        'legacyChatGptPreferences',
        JSON.stringify(migrated),
        now,
      );
    }
    db.prepare(`INSERT INTO plugin_state (plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(
      'pico.model-parameters',
      'chatgptPreferencesV1Migrated',
      'true',
      now,
    );
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
