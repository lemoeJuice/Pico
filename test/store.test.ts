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

describe('PicoStore execution transactions', () => {
  it('keeps execution state and its append-only log entry atomic', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Execution transaction', '/');
      const thread = store.createThread(project.id, 'host');
      const transition = store.createModelExecution('atomic-transition', thread.id, 0);
      store.db.exec(`
        CREATE TRIGGER fail_running_execution_log
        BEFORE INSERT ON execution_log
        WHEN NEW.execution_id = 'atomic-transition' AND NEW.kind = 'running'
        BEGIN SELECT RAISE(ABORT, 'simulated execution log failure'); END;
      `);

      expect(() => store.transitionExecution(transition.id, 'running')).toThrow(/simulated execution log failure/);
      expect(store.getExecution(transition.id)?.status).toBe('pending');
      expect(store.listExecutionLog(transition.id, 'created')).toHaveLength(1);
      expect(store.listExecutionLog(transition.id, 'running')).toHaveLength(0);

      store.db.exec('DROP TRIGGER fail_running_execution_log;');
      store.db.exec(`
        CREATE TRIGGER fail_created_execution_log
        BEFORE INSERT ON execution_log
        WHEN NEW.execution_id = 'atomic-create' AND NEW.kind = 'created'
        BEGIN SELECT RAISE(ABORT, 'simulated execution creation log failure'); END;
      `);

      expect(() => store.createModelExecution('atomic-create', thread.id, 0)).toThrow(
        /simulated execution creation log failure/,
      );
      expect(store.getExecution('atomic-create')).toBeNull();
      expect(store.listExecutionLog('atomic-create', 'created')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('persists retryable setup diagnostics atomically without changing the Execution state', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Retryable execution diagnostic', '/');
      const thread = store.createThread(project.id, 'container');
      const modelExecution = store.createModelExecution('retryable-model', thread.id, 0);
      store.transitionExecution(modelExecution.id, 'running');
      const call = { id: 'retryable-call', name: 'shell', arguments: { command: 'true' } };
      store.commitModelStep({
        assistantRecordId: 'retryable-model:assistant',
        modelExecutionId: modelExecution.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'retryable-model:batch', toolCalls: [call] }),
        toolCalls: [{ call, executionId: 'retryable-tool' }],
      });
      store.db.exec(`
        CREATE TRIGGER fail_retryable_setup_log
        BEFORE INSERT ON execution_log
        WHEN NEW.execution_id = 'retryable-tool' AND NEW.kind = 'retryable-setup-failure'
        BEGIN SELECT RAISE(ABORT, 'simulated retryable diagnostic log failure'); END;
      `);

      expect(() =>
        store.recordRetryableExecutionFailure('retryable-tool', 'Registry connection ended with EOF'),
      ).toThrow(/simulated retryable diagnostic log failure/);
      expect(store.getExecution('retryable-tool')).toMatchObject({ status: 'pending', error: null });
      expect(store.listExecutionLog('retryable-tool', 'retryable-setup-failure')).toHaveLength(0);

      store.db.exec('DROP TRIGGER fail_retryable_setup_log;');
      const updated = store.recordRetryableExecutionFailure('retryable-tool', 'Registry connection ended with EOF');
      expect(updated).toMatchObject({ status: 'pending', error: 'Registry connection ended with EOF' });
      expect(store.listExecutionLog('retryable-tool', 'retryable-setup-failure')).toMatchObject([
        { detail: { error: 'Registry connection ended with EOF' } },
      ]);
    } finally {
      store.close();
    }
  });
});

describe('canonical history pages', () => {
  it('checks Message existence and projection watermarks without materializing history', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Message watermarks', '/');
      const thread = store.createThread(project.id, 'host');
      expect(store.hasMessage(thread.id)).toBe(false);
      expect(store.hasMessageAfter(thread.id, 0)).toBe(false);

      const first = store.appendMessage(thread.id, 'watermark-first', {
        role: 'user',
        content: 'First input',
        source: 'user',
      }).record;
      store.appendCanonical(thread.id, 'watermark-assistant', 'assistant', assistantPayload({ content: 'Reply' }));
      const later = store.appendMessage(thread.id, 'watermark-later', {
        role: 'user',
        content: 'Follow-up input',
        source: 'user',
      }).record;

      expect(store.hasMessage(thread.id)).toBe(true);
      expect(store.hasMessageAfter(thread.id, first.seq)).toBe(true);
      expect(store.hasMessageAfter(thread.id, later.seq)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('pages append-only records newest-first without gaps or overlap', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('History pages', '/');
      const thread = store.createThread(project.id, 'host');
      for (let index = 0; index < 235; index += 1) {
        store.appendMessage(thread.id, `history-${index}`, {
          role: 'user',
          content: `Message ${index}`,
          source: 'user',
        });
      }

      const latest = store.listRecordPage(thread.id, undefined, 100);
      expect(latest.records).toHaveLength(100);
      expect(latest.records[0]?.id).toBe('history-135');
      expect(latest.records.at(-1)?.id).toBe('history-234');
      expect(latest.hasEarlierRecords).toBe(true);

      const earlier = store.listRecordPage(thread.id, latest.records[0]!.seq, 100);
      expect(earlier.records).toHaveLength(100);
      expect(earlier.records[0]?.id).toBe('history-35');
      expect(earlier.records.at(-1)?.id).toBe('history-134');
      expect(earlier.records.at(-1)?.seq).toBeLessThan(latest.records[0]!.seq);
      expect(earlier.hasEarlierRecords).toBe(true);

      const oldest = store.listRecordPage(thread.id, earlier.records[0]!.seq, 100);
      expect(oldest.records.map((record) => record.id)).toEqual(
        Array.from({ length: 35 }, (_value, index) => `history-${index}`),
      );
      expect(oldest.hasEarlierRecords).toBe(false);
    } finally {
      store.close();
    }
  });
});
