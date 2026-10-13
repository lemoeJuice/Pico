import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { migrateLegacyPermissions } from '../src/core/migrations/legacy-permissions.js';
import { assistantPayload } from './helpers.js';

describe('permission ownership migration', () => {
  it('moves rules and pending decisions atomically, retains audit and is idempotent', () => {
    const store = new PicoStore(':memory:');
    const project = store.createProject('Legacy', '/tmp');
    const thread = store.createThread(project.id, 'host');
    const model = store.createModelExecution('legacy-model', thread.id, 0);
    store.transitionExecution(model.id, 'running');
    const call = { id: 'legacy-call', name: 'shell', arguments: { command: 'echo hello' } };
    store.commitModelStep({
      assistantRecordId: 'legacy-assistant',
      modelExecutionId: model.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'legacy-batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId: 'legacy-tool' }],
    });
    store.db.exec(`CREATE TABLE IF NOT EXISTS approvals (execution_id TEXT PRIMARY KEY, status TEXT NOT NULL,
      created_at TEXT NOT NULL, decided_at TEXT)`);
    store.db.prepare('INSERT INTO approvals VALUES (?, ?, ?, NULL)').run('legacy-tool', 'pending', '2026-10-13');
    store.setSetting(`permissions:${thread.id}`, { shell: 'ask', read_file: 'allow' });
    store.setPluginState('pico.permissions', 'rules', { [thread.id]: { read_file: 'deny' } });
    const audit = store.appendPluginRecord(thread.id, 'pico.permissions', { action: 'old-decision' });
    migrateLegacyPermissions(store.db);
    expect(store.getPluginState('pico.permissions', 'rules', {})).toEqual({
      [thread.id]: { shell: 'ask', read_file: 'deny' },
    });
    expect(store.getPluginState('pico.permissions', 'approvals', {})).toEqual({
      'legacy-tool': {
        executionId: 'legacy-tool',
        threadId: thread.id,
        toolName: 'shell',
        arguments: call.arguments,
        status: 'pending',
        createdAt: '2026-10-13',
      },
    });
    expect(store.getCanonicalRecordById(audit.id)).toEqual(audit);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'approvals'").get()).toBeUndefined();
    expect(store.getSetting(`permissions:${thread.id}`, null)).toBeNull();
    migrateLegacyPermissions(store.db);
    expect(store.getExecution('legacy-tool')?.status).toBe('pending');
    store.close();
  });

  it('rolls back malformed legacy data instead of silently losing rules', () => {
    const store = new PicoStore(':memory:');
    store.db
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('permissions:broken', '{invalid', 'now');
    expect(() => migrateLegacyPermissions(store.db)).toThrow();
    expect(store.db.prepare('SELECT key FROM settings WHERE key = ?').get('permissions:broken')).toBeDefined();
    expect(store.getPluginState('pico.permissions', 'rules', null)).toBeNull();
    store.close();
  });
});
