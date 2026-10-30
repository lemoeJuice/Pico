import { afterEach, describe, expect, it } from 'vitest';
import { collaborationPlugin } from '../../collaboration.js';
import { permissionPlugin } from '../../permissions.js';
import type { PicoRuntime } from '../../../runtime/runtime.js';
import { deferred, FakeModel, response, setupRuntime } from '../../../../test/helpers.js';

const environments: Array<Awaited<ReturnType<typeof setupRuntime>>> = [];

afterEach(async () => {
  await Promise.all(environments.splice(0).map((environment) => environment.cleanup()));
});

async function permissionRequest<T>(
  runtime: PicoRuntime,
  method: string,
  path: string,
  body?: unknown,
  threadId?: string,
): Promise<T> {
  const route = runtime.pluginHttpRoute('pico.permissions', method, path);
  if (!route) throw new Error(`Missing permission route ${method} ${path}`);
  return (await route.handler({
    body,
    query: new URLSearchParams(threadId ? { threadId } : {}),
    origin: null,
  })) as T;
}

async function untilPending(runtime: PicoRuntime, threadId: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const view = await permissionRequest<{
      approvals: Array<{ executionId: string; status: string }>;
    }>(runtime, 'GET', '/threads', undefined, threadId);
    const pending = view.approvals.find((approval) => approval.status === 'pending');
    if (pending) return pending.executionId;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Child Thread did not reach a pending approval');
}

describe('Child Thread Auto-review shortcut', () => {
  it('enables both settings on the pending descendant and reviews that request', async () => {
    const reviewerStarted = deferred<void>();
    const reviewerResult = deferred<ReturnType<typeof response>>();
    const model = new FakeModel((prompt) => {
      if (prompt.system.includes('You are Pico Permission Reviewer.')) {
        reviewerStarted.resolve();
        return reviewerResult.promise;
      }
      return prompt.turns.some((turn) => turn.kind === 'tool_result')
        ? response('The child task is complete.')
        : response('', [{ id: 'child-list-projects', name: 'list_project_threads', arguments: {} }]);
    });
    const environment = await setupRuntime(model, { plugins: [permissionPlugin, collaborationPlugin] });
    environments.push(environment);
    const parent = environment.createThread('runtime', 'Parent');
    const unrelatedParent = environment.runtime.createThread(environment.project.id, 'runtime', 'Unrelated parent');
    const separateProject = await environment.runtime.createProject('Separate Project', environment.workspace);
    const separateProjectThread = environment.runtime.createThread(separateProject.id, 'runtime', 'Other project');
    await permissionRequest(environment.runtime, 'PUT', '/rules', {
      threadId: parent.id,
      toolName: 'list_project_threads',
      policy: 'ask',
    });
    environment.runtime.pause(parent.id);

    const spawn = environment.runtime.tools.get('spawn_thread');
    if (!spawn) throw new Error('spawn_thread was not registered');
    const spawned = (await spawn.execute(
      { prompt: 'List the project threads.', title: 'Approval child' },
      {
        thread: parent,
        executionId: 'child-auto-review-spawn',
        workspacePath: parent.workspacePath,
        signal: new AbortController().signal,
      },
    )) as { threadId: string };
    const executionId = await untilPending(environment.runtime, spawned.threadId);

    environment.store.db.exec(`
      CREATE TRIGGER fail_child_auto_review_audit
      BEFORE INSERT ON canonical_records
      WHEN NEW.thread_id = '${spawned.threadId}' AND NEW.kind = 'plugin'
        AND json_extract(NEW.payload_json, '$.action') = 'reviewer.denial-mode'
      BEGIN SELECT RAISE(ABORT, 'simulated second child auto-review audit failure'); END;
    `);
    const recordsBeforeFailure = environment.store
      .listRecords(spawned.threadId)
      .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions');
    try {
      await expect(
        permissionRequest(environment.runtime, 'POST', '/child-auto-review', {
          parentThreadId: parent.id,
          executionId,
        }),
      ).rejects.toThrow(/simulated second child auto-review audit failure/);
    } finally {
      environment.store.db.exec('DROP TRIGGER fail_child_auto_review_audit;');
    }
    expect(
      environment.store.getPluginState<Record<string, boolean>>('pico.permissions', 'autoReview', {})[spawned.threadId],
    ).not.toBe(true);
    expect(
      environment.store.getPluginState<Record<string, boolean>>('pico.permissions', 'autoReviewDenials', {})[
        spawned.threadId
      ],
    ).not.toBe(true);
    expect(
      environment.store
        .listRecords(spawned.threadId)
        .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions'),
    ).toEqual(recordsBeforeFailure);
    expect(
      environment.store.getPluginState<Record<string, { status: string }>>('pico.permissions', 'approvals', {})[
        executionId
      ]?.status,
    ).toBe('pending');

    const result = await permissionRequest<{
      parentThreadId: string;
      threadId: string;
      executionId: string;
      autoReview: boolean;
      autoReviewDenials: boolean;
      approvalStatus: string;
    }>(environment.runtime, 'POST', '/child-auto-review', {
      parentThreadId: parent.id,
      executionId,
    });

    expect(result).toEqual({
      parentThreadId: parent.id,
      threadId: spawned.threadId,
      executionId,
      autoReview: true,
      autoReviewDenials: true,
      approvalStatus: 'pending',
    });
    await reviewerStarted.promise;
    expect(
      environment.store.getPluginState<Record<string, boolean>>('pico.permissions', 'autoReview', {})[
        unrelatedParent.id
      ],
    ).toBeUndefined();
    expect(
      environment.store.getPluginState<Record<string, boolean>>('pico.permissions', 'autoReviewDenials', {})[
        spawned.threadId
      ],
    ).toBe(true);

    await expect(
      permissionRequest(environment.runtime, 'POST', '/child-auto-review', {
        parentThreadId: unrelatedParent.id,
        executionId,
      }),
    ).rejects.toThrow(/not from an active descendant/i);
    await expect(
      permissionRequest(environment.runtime, 'POST', '/child-auto-review', {
        parentThreadId: separateProjectThread.id,
        executionId,
      }),
    ).rejects.toThrow(/not from an active descendant/i);

    const retried = await permissionRequest<{
      parentThreadId: string;
      threadId: string;
      executionId: string;
      autoReview: boolean;
      autoReviewDenials: boolean;
      approvalStatus: string;
    }>(environment.runtime, 'POST', '/child-auto-review', { parentThreadId: parent.id, executionId });
    expect(retried).toMatchObject({ autoReview: true, autoReviewDenials: true, approvalStatus: 'pending' });
    expect(model.prompts.filter((prompt) => prompt.system.includes('You are Pico Permission Reviewer.'))).toHaveLength(
      1,
    );
    reviewerResult.resolve(response('{"decision":"allow","reason":"Listing project threads matches the request."}'));
    const deadline = Date.now() + 3_000;
    let approvalState: { status: string; decisionSource?: string; reviewer?: { outcome: string } } | undefined;
    while (Date.now() < deadline) {
      approvalState = environment.store.getPluginState<Record<string, typeof approvalState>>(
        'pico.permissions',
        'approvals',
        {},
      )[executionId];
      if (approvalState?.status === 'allowed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const records = environment.store
      .listRecords(spawned.threadId)
      .filter((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.permissions');
    expect(records.filter((record) => record.payload.action === 'reviewer.mode')).toHaveLength(1);
    expect(records.filter((record) => record.payload.action === 'reviewer.denial-mode')).toHaveLength(1);
    expect(approvalState).toMatchObject({
      status: 'allowed',
      decisionSource: 'reviewer',
      reviewer: { outcome: 'allow' },
    });
    await environment.runtime.drain();
    await expect(
      permissionRequest(environment.runtime, 'POST', '/child-auto-review', {
        parentThreadId: parent.id,
        executionId,
      }),
    ).rejects.toThrow(/pending approval not found/i);
    reviewerResult.resolve(response('{"decision":"allow","reason":"Listing project threads matches the request."}'));
  });
});
