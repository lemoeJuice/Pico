import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PicoStore } from '../../../core/store.js';
import { permissionPlugin } from '../../../plugins/permissions.js';
import { PicoRuntime } from '../../../runtime/runtime.js';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

interface PermissionApprovalForTest {
  executionId: string;
  threadId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'cancelled';
  createdAt: string;
}

interface PermissionViewForTest {
  tools: Array<{ name: string; description: string; policy: 'allow' | 'ask' | 'deny' }>;
  approvals: PermissionApprovalForTest[];
}

async function permissionRequest<T>(
  runtime: PicoRuntime,
  method: string,
  path: string,
  body?: unknown,
  query?: URLSearchParams,
): Promise<T> {
  const route = runtime.pluginHttpRoute('pico.permissions', method, path);
  if (!route) throw new Error('Permission plugin route ' + method + ' ' + path + ' is not registered.');
  return (await route.handler({ body, query: query ?? new URLSearchParams(), origin: null })) as T;
}

function permissionView(runtime: PicoRuntime, threadId: string): Promise<PermissionViewForTest> {
  return permissionRequest(runtime, 'GET', '/threads', undefined, new URLSearchParams({ threadId }));
}

async function setPermission(
  runtime: PicoRuntime,
  threadId: string,
  toolName: string,
  policy: 'allow' | 'ask' | 'deny',
) {
  return permissionRequest(runtime, 'PUT', '/rules', { threadId, toolName, policy });
}

async function decidePermission(runtime: PicoRuntime, executionId: string, allow: boolean, rememberForThread = false) {
  return permissionRequest(runtime, 'POST', '/approvals', { executionId, allow, rememberForThread });
}

async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for an async condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Permissions Runtime integration', () => {
  it('lists coordination tools and registers permission controls in the Runtime UI', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.runtime.createThread(env.project.id, 'runtime', 'Permission tools');
    try {
      expect((await permissionView(env.runtime, thread.id)).tools.map((tool) => tool.name)).toEqual([
        'workspace_info',
        'project_memory_record',
        'project_memory_search',
        'spawn_thread',
        'send_thread_message',
        'list_child_threads',
        'read_thread_history',
      ]);
      expect(
        env.runtime
          .pluginInfo()
          .ui.filter((item) => item.pluginId === 'pico.permissions')
          .map((item) => item.slot),
      ).toEqual(['thread.toolbar', 'tool.result']);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps an active Tool Batch visible when its parent is older than the latest history page', async () => {
    const model = new FakeModel(() =>
      response('', [{ id: 'paged-pending-read', name: 'read_file', arguments: { path: 'facts.txt' } }]),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    try {
      await env.runtime.submit(thread.id, 'paged-parent-message', 'Read facts.txt.');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      for (let index = 0; index < 110; index += 1) {
        await env.runtime.submit(thread.id, `paused-follow-up-${index}`, `Follow-up ${index}`);
      }

      const snapshot = env.runtime.getSnapshot(thread.id)!;
      expect(snapshot.records[0]?.kind).toBe('assistant');
      expect(snapshot.records[0]?.id).toMatch(/:assistant$/);
      expect(snapshot.records).toHaveLength(112);
      expect(snapshot.records.filter((record) => record.kind === 'message')).toHaveLength(110);
      expect(snapshot.executions.find((execution) => execution.toolName === 'read_file')?.status).toBe('pending');
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      ).toBe(true);
      expect(snapshot.hasEarlierRecords).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('closes with a pending approval intact and restores it after Runtime restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pico-approval-restart-'));
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'input.txt'), 'durable approval', 'utf8');
    const databasePath = join(directory, 'runtime.sqlite');
    let modelCalls = 0;
    const createModel = (): FakeModel =>
      new FakeModel(() => {
        modelCalls += 1;
        return modelCalls === 1
          ? response('', [{ id: 'approval-read', name: 'read_file', arguments: { path: 'input.txt' } }])
          : response('The file was read after restart.');
      });
    let store = new PicoStore(databasePath);
    let runtime = new PicoRuntime(store, {
      model: createModel(),
      pluginDirectory: join(directory, 'empty-plugins'),
      plugins: [permissionPlugin],
    });
    await runtime.initialize();
    const project = await runtime.createProject('Approval recovery', workspace);
    runtime.updateModelSettings({ model: 'test-model' });
    const thread = runtime.createThread(project.id, 'host');
    try {
      await runtime.submit(thread.id, 'approval-restart-message', 'Read the input file.');
      await untilAsync(async () =>
        (await permissionView(runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(runtime, thread.id)).approvals[0]!;
      const executionBeforeShutdown = store.getExecution(approval.executionId);

      await runtime.shutdown();
      expect(executionBeforeShutdown?.status).toBe('pending');
      expect(store.getExecution(approval.executionId)?.status).toBe('pending');
      store.close();

      store = new PicoStore(databasePath);
      runtime = new PicoRuntime(store, {
        model: createModel(),
        pluginDirectory: join(directory, 'empty-plugins'),
        plugins: [permissionPlugin],
      });
      await runtime.initialize();
      await untilAsync(async () => (await permissionView(runtime, thread.id)).approvals[0]?.status === 'pending');
      await decidePermission(runtime, approval.executionId, true);
      await runtime.drain();

      expect(store.getExecution(approval.executionId)?.status).toBe('completed');
      expect(
        (await permissionView(runtime, thread.id)).approvals.find((item) => item.executionId === approval.executionId)
          ?.status,
      ).toBe('allowed');
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(1);
      expect(store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(2);
    } finally {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('asks before a Host Executor tool call, then records the allowed result', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read:file:one', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('I read the file.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      await env.runtime.submit(thread.id, 'approval-message', 'Read facts.txt');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');

      await decidePermission(env.runtime, approval.executionId, true);
      await env.runtime.drain();
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
      const toolResult = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(toolResult?.payload).toMatchObject({ toolCallId: 'read:file:one', toolName: 'read_file' });
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toBe(true);
      expect(
        model.prompts[1]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
      expect(model.prompts[1]?.turns.filter((turn) => turn.kind === 'tool_result')).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  it('commits approval status, remembered permission, and audit record together', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'atomic-approval', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The approval was recorded.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'transactional approval', 'utf8');
    try {
      await env.runtime.submit(thread.id, 'atomic-approval-message', 'Read facts.txt.');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;
      env.store.db.exec(`
          CREATE TRIGGER fail_permission_audit
          BEFORE INSERT ON canonical_records
          WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
          BEGIN SELECT RAISE(ABORT, 'simulated permission denial audit failure'); END;
        `);

      await expect(decidePermission(env.runtime, approval.executionId, true, true)).rejects.toThrow(
        /simulated permission denial audit failure/,
      );
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('pending');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((item) => item.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toHaveLength(1);

      env.store.db.exec('DROP TRIGGER fail_permission_audit;');
      await decidePermission(env.runtime, approval.executionId, true, true);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((item) => item.name === 'read_file')?.policy,
      ).toBe('allow');
      expect(
        env.store
          .listRecords(thread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.executionId === approval.executionId &&
              record.payload.scope === 'thread',
          ),
      ).toBe(true);
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
    } finally {
      await env.cleanup();
    }
  });

  it('returns permission denials with a visible reason and guidance for the next Model Step', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'policy-denial', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The tool was blocked by policy, so I will explain that and offer another path.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await setPermission(env.runtime, thread.id, 'read_file', 'deny');
    try {
      await env.runtime.submit(thread.id, 'policy-denial-message', 'Read facts.txt.');
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'read_file')!;
      const result = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(execution).toMatchObject({
        status: 'failed',
        error: 'Denied by the current permission policy.',
        result: {
          denied: true,
          reason: 'Denied by the current permission policy.',
          modelGuidance: expect.stringContaining('Do not repeat the same call.'),
        },
      });
      expect(result?.payload).toMatchObject({
        status: 'failed',
        error: 'Denied by the current permission policy.',
        result: { denied: true, modelGuidance: expect.any(String) },
      });
      const modelToolResult = model.prompts[1]?.turns.find((turn) => turn.kind === 'tool_result');
      expect(modelToolResult?.content).toContain('Denied by the current permission policy.');
      expect(modelToolResult?.content).toContain('Model guidance:');
      expect(modelToolResult?.content).toContain('Do not repeat the same call.');
    } finally {
      await env.cleanup();
    }
  });

  it('fails closed when the permission audit record for a denied Tool cannot be committed', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'atomic-denial', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The file was read after the permission decision could be recorded.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'transactional denial', 'utf8');
    await setPermission(env.runtime, thread.id, 'read_file', 'deny');
    try {
      env.store.db.exec(`
          CREATE TRIGGER fail_permission_denial_audit
          BEFORE INSERT ON canonical_records
          WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
            AND json_extract(NEW.payload_json, '$.pluginId') = 'pico.permissions'
            AND json_extract(NEW.payload_json, '$.action') = 'decision'
          BEGIN SELECT RAISE(ABORT, 'simulated permission denial audit failure'); END;
        `);

      await env.runtime.submit(thread.id, 'atomic-denial-message', 'Read facts.txt.');
      await env.runtime.drain();
      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'read_file')!;

      expect(env.store.getExecution(execution.id)?.status).toBe('failed');
      expect(env.store.getExecution(execution.id)?.error).toContain('simulated permission denial audit failure');
      expect(
        env.store
          .listRecords(thread.id)
          .filter(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.action === 'decision',
          ),
      ).toHaveLength(0);
      expect(env.store.getExecution(execution.id)?.result).toBeNull();
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toMatchObject([
        { payload: { status: 'failed' } },
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('Interrupt stops a pathological Host search while the Runtime remains responsive', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'regex-search', name: 'search_files', arguments: { pattern: '^(a+)+$' } }])
        : response('The search was interrupted.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/pathological.txt`, `${'a'.repeat(28)}!`, 'utf8');
    await setPermission(env.runtime, thread.id, 'search_files', 'allow');
    try {
      await env.runtime.submit(thread.id, 'regex-search-message', 'Search this workspace.');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'search_files' && execution.status === 'running'),
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      const execution = env.store.listExecutions(thread.id).find((item) => item.toolName === 'search_files');
      const result = env.store.listRecords(thread.id).find((record) => record.kind === 'tool_result');
      expect(execution?.status).toBe('interrupted');
      expect((result?.payload as { status?: string }).status).toBe('interrupted');
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  }, 5000);

  it('Interrupt cancels a pending approval without recording a denial or starting the Tool', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'cancel-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The interrupted approval was not executed.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    try {
      await env.runtime.submit(thread.id, 'cancel-approval-message', 'Read facts.txt');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;

      env.store.db.exec(`
          CREATE TRIGGER fail_permission_cancel_audit
          BEFORE INSERT ON canonical_records
          WHEN NEW.thread_id = '${thread.id}' AND NEW.kind = 'plugin'
          BEGIN SELECT RAISE(ABORT, 'simulated permission cancellation audit failure'); END;
        `);
      await expect(env.runtime.interrupt(thread.id)).rejects.toThrow(/simulated permission cancellation audit failure/);
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('pending');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');
      expect(
        env.store
          .listRecords(thread.id)
          .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
      ).toHaveLength(1);
      env.store.db.exec('DROP TRIGGER fail_permission_cancel_audit;');

      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('cancelled');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('interrupted');
      await expect(decidePermission(env.runtime, approval.executionId, true, true)).rejects.toThrow(/cancelled/i);
      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('ask');
      expect(model.calls).toBe(1);
      const permissionRecords = env.store
        .listRecords(thread.id)
        .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions');
      expect(permissionRecords.some((record) => record.payload.action === 'cancel')).toBe(true);
      expect(
        permissionRecords.some((record) => record.payload.action === 'decision' && record.payload.decision === 'deny'),
      ).toBe(false);
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'tool_result' && record.payload.status === 'interrupted'),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it('can persist an approval for one Tool in the Thread to avoid repeated prompts', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read-once', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : callNumber === 2
          ? response('', [{ id: 'read-again', name: 'read_file', arguments: { path: 'facts.txt' } }])
          : response('The file was read twice.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      await env.runtime.submit(thread.id, 'thread-approval-message', 'Read the file twice');
      await untilAsync(async () =>
        (await permissionView(env.runtime, thread.id)).approvals.some((approval) => approval.status === 'pending'),
      );
      const approval = (await permissionView(env.runtime, thread.id)).approvals[0]!;

      await decidePermission(env.runtime, approval.executionId, true, true);
      await env.runtime.drain();

      expect(
        (await permissionView(env.runtime, thread.id)).tools.find((tool) => tool.name === 'read_file')?.policy,
      ).toBe('allow');
      expect((await permissionView(env.runtime, thread.id)).approvals).toHaveLength(1);
      expect(
        (await permissionView(env.runtime, thread.id)).approvals.find(
          (item) => item.executionId === approval.executionId,
        )?.status,
      ).toBe('allowed');
      expect(
        env.store
          .listRecords(thread.id)
          .some(
            (record) =>
              record.kind === 'plugin' &&
              record.payload.pluginId === 'pico.permissions' &&
              record.payload.scope === 'thread',
          ),
      ).toBe(true);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(model.calls).toBe(3);
      expect(
        model.prompts[2]?.turns.some(
          (turn) => turn.kind === 'tool_result' && turn.content.includes('The durable fact.'),
        ),
      ).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});
