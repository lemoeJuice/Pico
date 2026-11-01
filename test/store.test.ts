import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../src/core/store.js';
import { assistantPayload } from './helpers.js';

describe('PicoStore migrations', () => {
  it('makes legacy Thread project ownership nullable without breaking dependent tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-nullable-thread-project-'));
    const databasePath = join(directory, 'legacy.sqlite');
    let store: PicoStore | null = new PicoStore(databasePath);
    try {
      const project = store.createProject('Legacy Project', directory);
      const thread = store.createThread(project.id, 'host');
      store.appendMessage(thread.id, 'legacy-owned-thread-record', {
        role: 'user',
        content: 'preserve',
        source: 'user',
      });
      store.close();
      store = null;

      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        ALTER TABLE threads RENAME TO threads_nullable;
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          executor_id TEXT NOT NULL REFERENCES executors(id),
          title TEXT NOT NULL,
          parent_thread_id TEXT REFERENCES threads(id),
          created_by_agent INTEGER NOT NULL DEFAULT 0,
          pause_requested INTEGER NOT NULL DEFAULT 0,
          pause_reason TEXT,
          pause_code TEXT,
          created_at TEXT NOT NULL,
          archived_at TEXT,
          deleted_at TEXT
        );
        INSERT INTO threads SELECT * FROM threads_nullable;
        DROP TABLE threads_nullable;
        PRAGMA legacy_alter_table = OFF;
        PRAGMA foreign_keys = ON;
      `);
      legacy.close();

      store = new PicoStore(databasePath);
      const migratedThread = store.listThreads(project.id)[0];
      expect(migratedThread?.projectId).toBe(project.id);
      expect(store.listRecords(migratedThread!.id).map((record) => record.id)).toContain('legacy-owned-thread-record');
      expect(store.createThread(null, 'runtime').projectId).toBeNull();
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

describe('Thread list activity timestamps', () => {
  it('returns the latest user-authored message time for independent and Project Threads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-thread-list-activity-'));
    const store = new PicoStore(join(directory, 'pico.sqlite'));
    try {
      const project = store.createProject('Activity', directory);
      const projectThread = store.createThread(project.id, 'runtime');
      const independentThread = store.createThread(null, 'runtime');
      const emptyThread = store.createThread(project.id, 'runtime');
      store.appendCanonical(projectThread.id, 'activity-user-1', 'message', {
        role: 'user', content: 'first', source: 'user',
      }, '2026-01-01T00:00:00.000Z');
      store.appendCanonical(projectThread.id, 'activity-agent-user-role', 'message', {
        role: 'user', content: 'agent generated', source: 'agent',
      }, '2026-01-02T00:00:00.000Z');
      const latestUserRecord = store.appendCanonical(projectThread.id, 'activity-user-2', 'message', {
        role: 'user', content: 'latest', source: 'user',
      }, '2026-01-03T00:00:00.000Z').record;
      store.appendMessage(independentThread.id, 'activity-independent-user', {
        role: 'user', content: 'independent', source: 'user',
      });

      expect(store.listThreads(project.id).find((thread) => thread.id === projectThread.id)?.lastUserMessageAt)
        .toBe(latestUserRecord.createdAt);
      expect(store.listProjectThreads(project.id).find((thread) => thread.id === projectThread.id)?.lastUserMessageAt)
        .toBe(latestUserRecord.createdAt);
      expect(store.listThreads(null).find((thread) => thread.id === independentThread.id)?.lastUserMessageAt)
        .toBeTruthy();
      expect(store.listThreads(project.id).find((thread) => thread.id === emptyThread.id)?.lastUserMessageAt).toBeNull();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('independent Thread Project assignment', () => {
  it('reuses a direct parent Container binding and includes inheritance in idempotency identity', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Shared Container', '/workspace');
      const parent = store.createThread(project.id, 'container', 'Parent');
      const parentBinding = store.getExecutorBinding(parent.executorId)!;

      const first = store.createThreadWithResult(project.id, 'container', 'Child', {
        parentThreadId: parent.id,
        inheritExecutorId: parent.executorId,
        idempotencyKey: 'shared-child',
      });
      const retry = store.createThreadWithResult(project.id, 'container', 'Child', {
        parentThreadId: parent.id,
        inheritExecutorId: parent.executorId,
        idempotencyKey: 'shared-child',
      });

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.thread.id).toBe(first.thread.id);
      expect(first.thread.executorId).toBe(parent.executorId);
      expect(first.thread.workspacePath).toBe(parent.workspacePath);
      expect(store.getExecutorBinding(first.thread.executorId)).toEqual(parentBinding);
      expect(() =>
        store.createThreadWithResult(project.id, 'container', 'Other', {
          parentThreadId: parent.id,
          inheritExecutorId: parent.executorId,
          idempotencyKey: 'shared-child',
        }),
      ).toThrow(/different parameters/);
    } finally {
      store.close();
    }
  });

  it('rejects inherited Container bindings unless they belong to the direct parent in the same Project', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Shared Container', '/workspace');
      const otherProject = store.createProject('Other Project', '/other');
      const parent = store.createThread(project.id, 'container', 'Parent');
      const otherParent = store.createThread(project.id, 'container', 'Other parent');
      const hostParent = store.createThread(project.id, 'host', 'Host parent');

      expect(() =>
        store.createThread(project.id, 'container', 'Wrong binding', {
          parentThreadId: parent.id,
          inheritExecutorId: otherParent.executorId,
        }),
      ).toThrow(/belong to the parent/);
      expect(() =>
        store.createThread(project.id, 'container', 'Wrong kind', {
          parentThreadId: hostParent.id,
          inheritExecutorId: hostParent.executorId,
        }),
      ).toThrow(/Container Executor/);
      expect(() =>
        store.createThread(otherProject.id, 'container', 'Wrong Project', {
          parentThreadId: parent.id,
          inheritExecutorId: parent.executorId,
        }),
      ).toThrow(/same Project/);
      expect(() =>
        store.createThread(project.id, 'host', 'Wrong child kind', {
          parentThreadId: parent.id,
          inheritExecutorId: parent.executorId,
        }),
      ).toThrow(/Only local Container/);
    } finally {
      store.close();
    }
  });

  it('keeps standalone roots isolated and assigns an entire child tree atomically', () => {
    const store = new PicoStore(':memory:');
    try {
      const root = store.createThread(null, 'host', 'Independent root');
      const child = store.createThread(null, 'container', 'Child', { parentThreadId: root.id });
      const other = store.createThread(null, 'runtime', 'Other root');

      expect(store.listThreads(null).map(({ id }) => id)).toEqual(
        expect.arrayContaining([root.id, child.id, other.id]),
      );
      const { project, threads } = store.createProjectForThreadSubtree(root.id, 'New Project', '');

      expect(threads.map(({ projectId }) => projectId)).toEqual([project.id, project.id]);
      expect(store.getThread(root.id)?.projectId).toBe(project.id);
      expect(store.getThread(child.id)?.projectId).toBe(project.id);
      expect(store.getThread(other.id)?.projectId).toBeNull();
      expect(store.listThreads(null).map(({ id }) => id)).toEqual([other.id]);
    } finally {
      store.close();
    }
  });

  it('updates a shared executor label only once when assigning a subtree to a Project', () => {
    const store = new PicoStore(':memory:');
    try {
      const root = store.createThread(null, 'container', 'Independent root');
      const child = store.createThread(null, 'container', 'Child', {
        parentThreadId: root.id,
        inheritExecutorId: root.executorId,
      });

      const { project } = store.createProjectForThreadSubtree(root.id, 'Moved Project', '');

      expect(store.getThread(root.id)?.executorLabel).toBe('Container · Moved Project');
      expect(store.getThread(child.id)?.executorLabel).toBe('Container · Moved Project');
      expect(store.getExecutorBinding(root.executorId)?.label).toBe('Container · Moved Project');
      expect(store.getThread(root.id)?.projectId).toBe(project.id);
    } finally {
      store.close();
    }
  });

  it('sets a Project workspace only on explicitly selected local bindings', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Workspace later', '');
      const host = store.createThread(project.id, 'host');
      const chat = store.createThread(project.id, 'runtime');

      store.setProjectWorkspace(project.id, '/workspace', [host.executorId, chat.executorId]);

      expect(store.getThread(host.id)?.workspacePath).toBe('/workspace');
      expect(store.getThread(chat.id)?.workspacePath).toBe('');
      expect(store.getProject(project.id)?.workspacePath).toBe('/workspace');
      expect(() => store.setProjectWorkspace(project.id, '/elsewhere', [])).toThrow(/already been set/);
    } finally {
      store.close();
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
        modelId: 'test-model-id',
        adapterId: 'test-adapter',
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
      store.db.exec(`CREATE TRIGGER fail_tool_source_log BEFORE INSERT ON canonical_records
        WHEN NEW.payload_json LIKE '%tool-routing:%'
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
              mcpTarget: { serverId: 'server', toolKey: 'tool' },
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

  it('persists and rebuilds immutable routing when all diagnostics fail', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('Routing', '/tmp/routing');
      const thread = store.createThread(project.id, 'container');
      const model = store.createModelExecution('routing-model', thread.id, 0);
      store.transitionExecution(model.id, 'running');
      store.db.exec(
        `CREATE TRIGGER fail_all_logs BEFORE INSERT ON execution_log BEGIN SELECT RAISE(ABORT, 'diagnostics unavailable'); END;`,
      );
      const call = { id: 'call', name: 'shell', arguments: {} };
      const input = {
        assistantRecordId: 'routing-model:assistant',
        modelExecutionId: model.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'routing-batch', toolCalls: [call] }),
        toolCalls: [{ call, executionId: 'routing-tool', source: 'executor' as const }],
      };
      store.commitModelStep(input);
      expect(store.getToolExecutionRouting('routing-tool')).toEqual({ source: 'executor' });
      expect(() =>
        store.commitModelStep({ ...input, toolCalls: [{ ...input.toolCalls[0]!, source: 'runtime' }] }),
      ).toThrow(/routing changed/);
      store.transitionExecution('routing-tool', 'running');
      expect(store.listRunningContainerExecutorWorkspacePaths()).toContain('/tmp/routing');
      store.rebuildWorkflowViews();
      expect(store.getToolExecutionRouting('routing-tool')).toEqual({ source: 'executor' });
      expect(store.listRunningContainerExecutorWorkspacePaths()).toContain('/tmp/routing');
    } finally {
      store.close();
    }
  });

  it('rejects invalid MCP routes and changes to target identity on retry', () => {
    const store = new PicoStore(':memory:');
    try {
      const project = store.createProject('MCP routing', '/');
      const thread = store.createThread(project.id, 'host');
      const model = store.createModelExecution('mcp-routing-model', thread.id, 0);
      const call = { id: 'call', name: 'mcp_tool', arguments: {} };
      const target = { serverId: 'server', toolKey: 'tool' };
      const input = {
        assistantRecordId: 'mcp-routing-model:assistant',
        modelExecutionId: model.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'mcp-routing-batch', toolCalls: [call] }),
        toolCalls: [{ call, executionId: 'mcp-routing-tool', source: 'mcp' as const, mcpTarget: target }],
      };
      expect(() =>
        store.commitModelStep({ ...input, toolCalls: [{ call, executionId: 'mcp-tool', source: 'mcp' }] }),
      ).toThrow(/valid MCP target/);
      expect(() =>
        store.commitModelStep({ ...input, toolCalls: [{ ...input.toolCalls[0]!, source: 'executor' }] }),
      ).toThrow(/cannot have an MCP target/);
      store.commitModelStep(input);
      store.commitModelStep(input);
      expect(() =>
        store.commitModelStep({
          ...input,
          toolCalls: [{ ...input.toolCalls[0]!, mcpTarget: { ...target, toolKey: 'different' } }],
        }),
      ).toThrow(/routing changed/);
      expect(store.getToolExecutionRouting('mcp-routing-tool')).toEqual({ source: 'mcp', mcpTarget: target });
    } finally {
      store.close();
    }
  });

  it('imports legacy diagnostic routing once and reconstructs it without logs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-routing-migration-'));
    const path = join(directory, 'db.sqlite');
    let store = new PicoStore(path);
    try {
      const project = store.createProject('Legacy route', directory);
      const thread = store.createThread(project.id, 'container');
      const model = store.createModelExecution('legacy-routing-model', thread.id, 0);
      const call = { id: 'call', name: 'shell', arguments: {} };
      const legacyTarget = { serverId: 'server', toolKey: 'tool', extra: 'discard-me' };
      store.commitModelStep({
        assistantRecordId: 'legacy-routing-model:assistant',
        modelExecutionId: model.id,
        threadId: thread.id,
        payload: assistantPayload({ batchId: 'legacy-routing-batch', toolCalls: [call] }),
        toolCalls: [
          {
            call,
            executionId: 'legacy-routing-tool',
            source: 'mcp',
            mcpTarget: legacyTarget,
          },
        ],
      });
      store.close();
      const db = new DatabaseSync(path);
      db.exec(`DELETE FROM tool_execution_routes; DELETE FROM store_migrations WHERE name = 'tool-execution-routes-v1';
        DROP TRIGGER canonical_records_no_delete;
        DELETE FROM canonical_records WHERE payload_json LIKE '%tool-routing:legacy-routing-tool%';
        CREATE TRIGGER canonical_records_no_delete BEFORE DELETE ON canonical_records BEGIN SELECT RAISE(ABORT, 'canonical records are append-only'); END;`);
      db.close();
      store = new PicoStore(path);
      expect(store.getToolExecutionRouting('legacy-routing-tool')).toEqual({
        source: 'mcp',
        mcpTarget: { serverId: 'server', toolKey: 'tool' },
      });
      expect(
        JSON.stringify(
          store
            .listScopedCanonical(`workflow:thread:${thread.id}`)
            .filter((r) => JSON.stringify(r.payload).includes('tool-routing:legacy-routing-tool')),
        ),
      ).not.toContain('discard-me');
      const count = store
        .listScopedCanonical(`workflow:thread:${thread.id}`)
        .filter((r) => JSON.stringify(r.payload).includes('tool-routing:legacy-routing-tool')).length;
      store.close();
      store = new PicoStore(path);
      expect(
        store
          .listScopedCanonical(`workflow:thread:${thread.id}`)
          .filter((r) => JSON.stringify(r.payload).includes('tool-routing:legacy-routing-tool')),
      ).toHaveLength(count);
      store.db.exec('DROP TRIGGER execution_log_no_delete; DELETE FROM execution_log;');
      store.rebuildWorkflowViews();
      expect(store.getToolExecutionRouting('legacy-routing-tool')).toEqual({
        source: 'mcp',
        mcpTarget: { serverId: 'server', toolKey: 'tool' },
      });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
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
