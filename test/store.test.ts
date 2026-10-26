import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload } from './helpers.js';

describe('PicoStore migrations', () => {
  it('adds scope metadata without changing existing Canonical row content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-canonical-scope-migration-'));
    const databasePath = join(directory, 'canonical.sqlite');
    let store: PicoStore | null = new PicoStore(databasePath);
    try {
      const project = store.createProject('Canonical migration', directory);
      const thread = store.createThread(project.id, 'runtime');
      store.appendMessage(thread.id, 'legacy-canonical-row', { role: 'user', content: 'unchanged', source: 'user' });
      store.close();
      store = null;
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        DROP TRIGGER canonical_records_no_update;
        DROP TRIGGER canonical_records_no_delete;
        DROP INDEX canonical_thread_seq;
        DROP INDEX canonical_thread_kind_seq;
        ALTER TABLE canonical_records RENAME TO canonical_records_with_scope;
        CREATE TABLE canonical_records (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id),
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(thread_id, seq)
        );
        INSERT INTO canonical_records (id, thread_id, seq, kind, payload_json, created_at)
          SELECT id, thread_id, seq, kind, payload_json, created_at
          FROM canonical_records_with_scope WHERE thread_id IS NOT NULL;
        DROP TABLE canonical_records_with_scope;
      `);
      const before = legacy
        .prepare(
          'SELECT id, thread_id, seq, kind, payload_json, created_at FROM canonical_records ORDER BY thread_id, seq',
        )
        .all();
      legacy.close();

      store = new PicoStore(databasePath);
      const readMigratedRows = () =>
        store!.db
          .prepare(
            'SELECT id, thread_id, seq, kind, payload_json, created_at FROM canonical_records WHERE thread_id IS NOT NULL ORDER BY thread_id, seq',
          )
          .all();
      expect(readMigratedRows()).toEqual(before);
      expect(store.listRecords(thread.id)[0]).toMatchObject({
        id: 'legacy-canonical-row',
        threadId: thread.id,
        seq: 1,
      });

      const afterFirstMigration = store.db
        .prepare(
          'SELECT id, thread_id, scope_key, seq, kind, payload_json, created_at FROM canonical_records ORDER BY scope_key, seq',
        )
        .all();
      store.close();
      store = new PicoStore(databasePath);
      const afterSecondOpen = store.db
        .prepare(
          'SELECT id, thread_id, scope_key, seq, kind, payload_json, created_at FROM canonical_records ORDER BY scope_key, seq',
        )
        .all();
      expect(afterSecondOpen).toEqual(afterFirstMigration);
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('adds Runtime Chat bindings while preserving existing Executor bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-runtime-executor-migration-'));
    const databasePath = join(directory, 'runtime.sqlite');
    let store: PicoStore | null = new PicoStore(databasePath);
    const project = store.createProject('Runtime executor migration', directory);
    const existingThread = store.createThread(project.id, 'host', 'Existing Host Thread');
    const existingBinding = store.executorForThread(existingThread.id)!;
    store.close();
    store = null;

    const legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA foreign_keys = OFF;');
    legacy.exec(`
      DROP TABLE executors;
      CREATE TABLE executors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('container', 'host')),
        label TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        remote_connection_id TEXT REFERENCES remote_executor_connections(id),
        created_at TEXT NOT NULL
      );
      INSERT INTO executors (id, kind, label, workspace_path, remote_connection_id, created_at)
        VALUES ('${existingBinding.id}', 'host', '${existingBinding.label}', '${existingBinding.workspacePath}', NULL, '${existingBinding.createdAt}');
    `);
    legacy.close();

    try {
      store = new PicoStore(databasePath);
      expect(store.getThread(existingThread.id)?.executorKind).toBe('host');
      const chatThread = store.createThread(project.id, 'runtime', 'Chat Thread');
      expect(chatThread).toMatchObject({
        executorKind: 'runtime',
        workspacePath: '',
        executorLabel: 'Chat · Runtime executor migration',
      });
      expect(store.executorForThread(chatThread.id)?.kind).toBe('runtime');
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('PicoStore execution transactions', () => {
  it('rebuilds Thread ModelSelection from its scoped workflow fact', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Model selection replay', '/tmp');
      const thread = store.createThread(project.id, 'runtime');
      const selection = {
        provider: 'openai-compatible',
        connectionId: 'default',
        model: 'pinned-model',
        parameters: { temperature: 0.4, options: {} },
      };
      store.setThreadModelSelection(thread.id, selection);
      store.db.exec('DELETE FROM thread_model_selections;');

      store.rebuildWorkflowViews();

      expect(store.getThreadModelSelection(thread.id)).toEqual(selection);
      expect(store.listRecords(thread.id)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('rolls back a Plugin State view when its workflow fact cannot commit', () => {
    const store = new PicoStore(':memory:');
    let notifications = 0;
    try {
      store.subscribePluginState(() => notifications++);
      store.db.exec(`CREATE TRIGGER fail_workflow_state_fact BEFORE INSERT ON canonical_records
        WHEN NEW.scope_key = 'workflow:global' AND NEW.payload_json LIKE '%plugin-state:atomic.plugin:key%'
        BEGIN SELECT RAISE(ABORT, 'simulated workflow fact failure'); END;`);
      expect(() => store.setPluginState('atomic.plugin', 'key', { value: 1 })).toThrow(
        /simulated workflow fact failure/,
      );
      expect(store.getPluginState('atomic.plugin', 'key', null)).toBeNull();
      expect(notifications).toBe(0);
    } finally {
      store.close();
    }
  });

  it('rebuilds workflow views from scoped facts without changing Thread history', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Workflow replay', '/');
      const thread = store.createThread(project.id, 'runtime');
      const message = store.appendMessage(thread.id, 'workflow-message', {
        role: 'user',
        content: 'hello',
        source: 'user',
      }).record;
      store.setPluginState('example.plugin', 'state', { count: 3 });
      store.setPause(thread.id, true, 'review');
      let execution = store.createModelExecution('workflow-execution', thread.id, message.seq);
      execution = store.transitionExecution(execution.id, 'running');
      execution = store.transitionExecution(execution.id, 'failed', { error: 'offline' });
      store.savePluginModelCall({
        id: 'workflow-call',
        pluginId: 'example.plugin',
        idempotencyKey: 'stable-key',
        requestFingerprint: 'a'.repeat(64),
        threadId: thread.id,
        projectId: project.id,
        purpose: 'review',
        provider: 'test',
        model: 'small',
        prompt: { secret: 'full prompt sentinel' },
        status: 'completed',
        response: { text: 'result' },
        usage: null,
        attempts: [{ request: 'diagnostic' }],
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const threadHistory = store.listRecords(thread.id);
      const facts = store.listScopedCanonical(`workflow:thread:${thread.id}`);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((fact) => fact.threadId === null && fact.scope === `workflow:thread:${thread.id}`)).toBe(true);
      expect(store.listRecords(thread.id)).toEqual(threadHistory);
      expect(JSON.stringify(facts)).not.toContain('full prompt sentinel');

      store.db.exec('DELETE FROM executions; DELETE FROM plugin_state; DELETE FROM plugin_model_calls;');
      store.db.prepare('UPDATE threads SET pause_requested = 0, pause_reason = NULL WHERE id = ?').run(thread.id);
      store.rebuildWorkflowViews();

      expect(store.getExecution('workflow-execution')).toEqual(execution);
      expect(store.getThread(thread.id)).toMatchObject({ pauseRequested: true, pauseReason: 'review' });
      expect(store.getPluginState('example.plugin', 'state', null)).toEqual({ count: 3 });
      expect(store.getPluginModelCall('workflow-call')).toMatchObject({
        status: 'completed',
        response: { text: 'result' },
        prompt: null,
        attempts: [],
        requestFingerprint: 'a'.repeat(64),
      });
      expect(store.listRecords(thread.id)).toEqual(threadHistory);
    } finally {
      store.close();
    }
  });

  it('commits Execution facts when diagnostic log writes fail', () => {
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

      expect(store.transitionExecution(transition.id, 'running').status).toBe('running');
      expect(store.getExecution(transition.id)?.status).toBe('running');
      expect(store.listExecutionLog(transition.id, 'created')).toHaveLength(1);
      expect(store.listExecutionLog(transition.id, 'running')).toHaveLength(0);

      store.db.exec('DROP TRIGGER fail_running_execution_log;');
      store.db.exec(`
        CREATE TRIGGER fail_created_execution_log
        BEFORE INSERT ON execution_log
        WHEN NEW.execution_id = 'atomic-create' AND NEW.kind = 'created'
        BEGIN SELECT RAISE(ABORT, 'simulated execution creation log failure'); END;
      `);

      expect(store.createModelExecution('atomic-create', thread.id, 0).status).toBe('pending');
      expect(store.getExecution('atomic-create')).toMatchObject({ status: 'pending' });
      expect(store.listExecutionLog('atomic-create', 'created')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('commits the assistant result while every execution diagnostic insert fails', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('No diagnostic dependency', '/');
      const thread = store.createThread(project.id, 'runtime');
      store.db.exec(`CREATE TRIGGER fail_all_execution_diagnostics BEFORE INSERT ON execution_log
        BEGIN SELECT RAISE(ABORT, 'diagnostics unavailable'); END;`);
      store.createModelExecution('diagnostic-free-model', thread.id, 0);
      store.transitionExecution('diagnostic-free-model', 'running');
      store.commitModelStep({
        assistantRecordId: 'diagnostic-free-model:assistant',
        modelExecutionId: 'diagnostic-free-model',
        threadId: thread.id,
        payload: assistantPayload({ content: 'committed' }),
        toolCalls: [],
      });
      expect(store.getExecution('diagnostic-free-model')).toMatchObject({ status: 'completed' });
      expect(store.listRecords(thread.id).some((record) => record.id === 'diagnostic-free-model:assistant')).toBe(true);
      expect(store.listExecutionLog('diagnostic-free-model', 'created')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('rolls back a Model Step when a tool source cannot be durably recorded', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Atomic tool source', '/');
      const thread = store.createThread(project.id, 'host');
      const modelExecution = store.createModelExecution('atomic-tool-source-model', thread.id, 0);
      store.transitionExecution(modelExecution.id, 'running');
      store.db.exec(`CREATE TRIGGER fail_tool_source_log BEFORE INSERT ON execution_log
        WHEN NEW.kind = 'tool-source'
        BEGIN SELECT RAISE(ABORT, 'tool source write failed'); END;`);
      const call = { id: 'atomic-source-call', name: 'mcp_server_tool', arguments: {} };

      expect(() =>
        store.commitModelStep({
          assistantRecordId: 'atomic-tool-source-model:assistant',
          modelExecutionId: modelExecution.id,
          threadId: thread.id,
          payload: assistantPayload({ batchId: 'atomic-tool-source-model:batch', toolCalls: [call] }),
          toolCalls: [
            {
              call,
              executionId: `${thread.id}:${modelExecution.id}:${call.id}`,
              source: 'mcp',
            },
          ],
        }),
      ).toThrow(/tool source write failed/);

      expect(store.listRecords(thread.id).some((record) => record.id === 'atomic-tool-source-model:assistant')).toBe(
        false,
      );
      expect(store.getExecution(`${thread.id}:${modelExecution.id}:${call.id}`)).toBeNull();
      expect(store.getExecution(modelExecution.id)?.status).toBe('running');
    } finally {
      store.close();
    }
  });

  it('persists retryable setup state when diagnostic log writes fail', () => {
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

      expect(
        store.recordRetryableExecutionFailure('retryable-tool', 'Registry connection ended with EOF'),
      ).toMatchObject({ status: 'pending', error: 'Registry connection ended with EOF' });
      expect(store.getExecution('retryable-tool')).toMatchObject({
        status: 'pending',
        error: 'Registry connection ended with EOF',
      });
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

  it('persists executor errors when diagnostic log writes fail', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Executor error diagnostic', '/');
      const thread = store.createThread(project.id, 'container');
      const modelExecution = store.createModelExecution('executor-error-model', thread.id, 0);
      store.transitionExecution(modelExecution.id, 'running');
      const call = { id: 'executor-error-call', name: 'shell', arguments: { command: 'true' } };
      store.commitModelStep({
        assistantRecordId: 'executor-error-model:assistant',
        modelExecutionId: modelExecution.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'executor-error-model:batch', toolCalls: [call] }),
        toolCalls: [{ call, executionId: 'executor-error-tool' }],
      });
      store.db.exec(`
        CREATE TRIGGER fail_executor_error_log
        BEFORE INSERT ON execution_log
        WHEN NEW.execution_id = 'executor-error-tool' AND NEW.kind = 'execution-error'
        BEGIN SELECT RAISE(ABORT, 'simulated executor diagnostic log failure'); END;
      `);

      expect(store.recordExecutionError('executor-error-tool', 'Executor disconnected')).toMatchObject({
        status: 'pending',
        error: 'Executor disconnected',
      });
      expect(store.getExecution('executor-error-tool')).toMatchObject({
        status: 'pending',
        error: 'Executor disconnected',
      });

      store.db.exec('DROP TRIGGER fail_executor_error_log;');
      expect(store.recordExecutionError('executor-error-tool', 'Executor disconnected')).toMatchObject({
        status: 'pending',
        error: 'Executor disconnected',
      });
      store.transitionExecution('executor-error-tool', 'running');
      expect(store.recordExecutionError('executor-error-tool', 'Executor stopped responding')).toMatchObject({
        status: 'running',
        error: 'Executor stopped responding',
      });
      expect(store.listExecutionLog('executor-error-tool', 'execution-error')).toEqual(
        expect.arrayContaining([expect.objectContaining({ detail: { error: 'Executor stopped responding' } })]),
      );
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
