import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload } from './helpers.js';

describe('PicoStore migrations', () => {
  it('adds cancelled approval status while preserving existing approval decisions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-approval-migration-'));
    const databasePath = join(directory, 'runtime.sqlite');
    let store: PicoStore | null = new PicoStore(databasePath);
    const project = store.createProject('Approval migration', directory);
    const thread = store.createThread(project.id, 'host');
    const executionId = `${thread.id}:migration-step:migration-call`;
    const call = { id: 'migration-call', name: 'read_file', arguments: { path: 'facts.txt' } };
    const modelExecution = store.createModelExecution('migration-step', thread.id, 0);
    store.transitionExecution(modelExecution.id, 'running');
    store.commitModelStep({
      assistantRecordId: 'migration-step:assistant',
      modelExecutionId: modelExecution.id,
      threadId: thread.id,
      payload: assistantPayload({ batchId: 'migration-step:batch', toolCalls: [call] }),
      toolCalls: [{ call, executionId }],
    });
    store.createApproval(executionId);
    store.resolveApproval(executionId, true);
    store.close();
    store = null;

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE approvals RENAME TO approvals_current;
      CREATE TABLE approvals (
        execution_id TEXT PRIMARY KEY REFERENCES executions(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied')),
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      INSERT INTO approvals (execution_id, status, created_at, decided_at)
        SELECT execution_id, status, created_at, decided_at FROM approvals_current;
      DROP TABLE approvals_current;
      COMMIT;
    `);
    legacy.close();

    try {
      store = new PicoStore(databasePath);
      expect(store.getApproval(executionId)?.status).toBe('allowed');
      const schema = store.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'")
        .get() as { sql: string };
      expect(schema.sql).toContain("'cancelled'");
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
