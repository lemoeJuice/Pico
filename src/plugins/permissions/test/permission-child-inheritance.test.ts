import { describe, expect, it } from 'vitest';
import { collaborationPlugin } from '../../collaboration.js';
import { permissionPlugin } from '../../permissions.js';
import { FakeModel, response, setupRuntime } from '../../../../test/helpers.js';
import type { PicoPlugin } from '../../../plugins/host.js';
import type { PicoRuntime } from '../../../runtime/runtime.js';

const permissionFixturePlugin: PicoPlugin = {
  id: 'test.permission-fixture',
  name: 'Permission fixture',
  version: '1',
  activate(context) {
    context.tools.register(
      {
        name: 'permission_fixture',
        description: 'A harmless tool used to exercise permission prompts.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      () => ({ ok: true }),
    );
  },
};

async function permissionRequest<T>(
  runtime: PicoRuntime,
  method: string,
  path: string,
  body: unknown,
  threadId?: string,
): Promise<T> {
  const registered = runtime.pluginHttpRoute('pico.permissions', method, path);
  if (!registered) throw new Error(`Missing permissions route ${method} ${path}`);
  return (await registered.handler({
    body,
    query: new URLSearchParams(threadId ? { threadId } : {}),
    origin: null,
  })) as T;
}

describe('Permission child Thread inheritance', () => {
  it('copies explicit rules and Auto-review settings through spawn_thread, then keeps them independent', async () => {
    const env = await setupRuntime(new FakeModel(() => response('Child task complete.')), {
      plugins: [permissionPlugin, collaborationPlugin],
    });
    const parent = env.runtime.createThread(env.project.id, 'runtime', 'Parent');

    try {
      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: parent.id,
        toolName: 'read_file',
        policy: 'allow',
      });
      await permissionRequest(env.runtime, 'PUT', '/reviewer', { threadId: parent.id, enabled: true });
      await permissionRequest(env.runtime, 'PUT', '/reviewer-denials', { threadId: parent.id, enabled: true });

      const spawn = env.runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const result = (await spawn.execute(
        { prompt: 'Complete a small independent task.', title: 'Permission child' },
        {
          thread: parent,
          executionId: 'permission-inheritance-spawn',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const child = env.runtime.getThread(result.threadId);
      expect(child?.parentThreadId).toBe(parent.id);

      const rules = env.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {});
      expect(rules[child!.id]).toEqual({ read_file: 'allow' });
      expect(
        await permissionRequest<{ autoReview: boolean; autoReviewDenials: boolean }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          child!.id,
        ),
      ).toMatchObject({ autoReview: true, autoReviewDenials: true });

      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: child!.id,
        toolName: 'read_file',
        policy: 'deny',
      });
      await permissionRequest(env.runtime, 'PUT', '/reviewer', { threadId: child!.id, enabled: false });
      await permissionRequest(env.runtime, 'PUT', '/reviewer-denials', { threadId: child!.id, enabled: false });

      const parentAfterChildEdit = await permissionRequest<{
        autoReview: boolean;
        autoReviewDenials: boolean;
      }>(env.runtime, 'GET', '/threads', undefined, parent.id);
      expect(parentAfterChildEdit).toMatchObject({ autoReview: true, autoReviewDenials: true });
      expect(
        env.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {})[parent.id],
      ).toEqual({ read_file: 'allow' });

      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: parent.id,
        toolName: 'read_file',
        policy: 'ask',
      });
      await permissionRequest(env.runtime, 'PUT', '/reviewer', { threadId: parent.id, enabled: false });
      await permissionRequest(env.runtime, 'PUT', '/reviewer-denials', { threadId: parent.id, enabled: false });
      await permissionRequest(env.runtime, 'PUT', '/reviewer', { threadId: parent.id, enabled: true });
      await permissionRequest(env.runtime, 'PUT', '/reviewer-denials', { threadId: parent.id, enabled: true });

      const finalRules = env.store.getPluginState<Record<string, Record<string, string>>>(
        'pico.permissions',
        'rules',
        {},
      );
      expect(finalRules[parent.id]).toEqual({ read_file: 'ask' });
      expect(finalRules[child!.id]).toEqual({ read_file: 'deny' });
      expect(
        await permissionRequest<{ autoReview: boolean; autoReviewDenials: boolean }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          child!.id,
        ),
      ).toMatchObject({ autoReview: false, autoReviewDenials: false });
      expect(
        await permissionRequest<{ autoReview: boolean; autoReviewDenials: boolean }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          parent.id,
        ),
      ).toMatchObject({ autoReview: true, autoReviewDenials: true });
    } finally {
      await env.cleanup();
    }
  });

  it('does not copy permission rules or Auto-review settings when the child changes executor', async () => {
    const env = await setupRuntime(new FakeModel(() => response('Child task complete.')), {
      plugins: [permissionPlugin, collaborationPlugin],
    });
    const parent = env.runtime.createThread(env.project.id, 'runtime', 'Parent');

    try {
      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: parent.id,
        toolName: 'read_file',
        policy: 'allow',
      });
      await permissionRequest(env.runtime, 'PUT', '/reviewer', { threadId: parent.id, enabled: true });
      await permissionRequest(env.runtime, 'PUT', '/reviewer-denials', { threadId: parent.id, enabled: true });

      const spawn = env.runtime.tools.get('spawn_thread');
      if (!spawn) throw new Error('spawn_thread was not registered');
      const result = (await spawn.execute(
        { prompt: 'Run this task in a Container.', executor: 'container' },
        {
          thread: parent,
          executionId: 'cross-executor-permission-spawn',
          workspacePath: parent.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
      const child = env.runtime.getThread(result.threadId);
      expect(child?.executorKind).toBe('container');

      const rules = env.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {});
      expect(rules[parent.id]).toEqual({ read_file: 'allow' });
      expect(rules[child!.id]).toBeUndefined();
      expect(
        await permissionRequest<{ autoReview: boolean; autoReviewDenials: boolean }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          child!.id,
        ),
      ).toMatchObject({ autoReview: false, autoReviewDenials: false });
    } finally {
      await env.cleanup();
    }
  });

  it('aggregates pending approvals from all descendants and clears them after resolution', async () => {
    const model = new FakeModel((prompt) =>
      prompt.system.includes('This Thread has no parent.') || prompt.turns.some((turn) => turn.kind === 'tool_result')
        ? response('The child task is complete.')
        : response('', [
            {
              id: 'permission-call',
              name: 'permission_fixture',
              arguments: {},
            },
          ]),
    );
    const env = await setupRuntime(model, {
      plugins: [permissionPlugin, collaborationPlugin, permissionFixturePlugin],
    });
    const parent = env.createThread('runtime', 'Parent');
    const otherRoot = env.createThread('runtime', 'Other root');

    const spawn = async (threadId: string, executionId: string, title: string) => {
      const thread = env.runtime.getThread(threadId);
      if (!thread) throw new Error(`Missing Thread ${threadId}`);
      const tool = env.runtime.tools.get('spawn_thread');
      if (!tool) throw new Error('spawn_thread was not registered');
      return (await tool.execute(
        { prompt: `Read facts.txt for ${title}.`, title },
        {
          thread,
          executionId,
          workspacePath: thread.workspacePath,
          signal: new AbortController().signal,
        },
      )) as { threadId: string };
    };
    const waitForApproval = async (threadId: string) => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const view = await permissionRequest<{
          approvals: Array<{ executionId: string; status: string; threadId: string }>;
        }>(env.runtime, 'GET', '/threads', undefined, threadId);
        const pending = view.approvals.find((approval) => approval.status === 'pending');
        if (pending) return pending;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for a pending approval in Thread ${threadId}`);
    };

    try {
      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: parent.id,
        toolName: 'permission_fixture',
        policy: 'ask',
      });
      await permissionRequest(env.runtime, 'PUT', '/rules', {
        threadId: otherRoot.id,
        toolName: 'permission_fixture',
        policy: 'ask',
      });
      await env.runtime.setThreadToolEnabled(parent.id, 'permission_fixture', true);
      await env.runtime.setThreadToolEnabled(otherRoot.id, 'permission_fixture', true);

      const child = await spawn(parent.id, 'spawn-direct-child', 'Direct child');
      const completedChildApproval = await waitForApproval(child.threadId);
      await permissionRequest(env.runtime, 'POST', '/approvals', {
        executionId: completedChildApproval.executionId,
        allow: true,
      });
      await env.runtime.drain();
      expect(
        (
          await permissionRequest<{ approvals: Array<{ executionId: string; status: string }> }>(
            env.runtime,
            'GET',
            '/threads',
            undefined,
            child.threadId,
          )
        ).approvals.find((approval) => approval.executionId === completedChildApproval.executionId)?.status,
      ).toBe('allowed');

      const grandchild = await spawn(child.threadId, 'spawn-grandchild', 'Grandchild');
      const grandchildApproval = await waitForApproval(grandchild.threadId);
      const unrelatedChild = await spawn(otherRoot.id, 'spawn-other-branch', 'Other branch child');
      const unrelatedApproval = await waitForApproval(unrelatedChild.threadId);

      const parentView = await permissionRequest<{
        descendantApprovals: Array<{
          executionId: string;
          threadId: string;
          threadTitle: string;
          arguments: Record<string, unknown>;
          reviewer?: { model: string; outcome: string; reason: string };
        }>;
      }>(env.runtime, 'GET', '/threads', undefined, parent.id);
      expect(parentView.descendantApprovals).toEqual([
        expect.objectContaining({
          executionId: grandchildApproval.executionId,
          threadId: grandchild.threadId,
          threadTitle: 'Grandchild',
          arguments: {},
        }),
      ]);
      expect(
        parentView.descendantApprovals.some((approval) => approval.executionId === completedChildApproval.executionId),
      ).toBe(false);
      expect(
        parentView.descendantApprovals.some((approval) => approval.executionId === unrelatedApproval.executionId),
      ).toBe(false);

      await permissionRequest(env.runtime, 'POST', '/approvals', {
        executionId: grandchildApproval.executionId,
        allow: true,
      });
      const afterResolution = await permissionRequest<{
        descendantApprovals: Array<{ executionId: string }>;
      }>(env.runtime, 'GET', '/threads', undefined, parent.id);
      expect(afterResolution.descendantApprovals).toEqual([]);

      const otherRootView = await permissionRequest<{
        descendantApprovals: Array<{ executionId: string; threadId: string }>;
      }>(env.runtime, 'GET', '/threads', undefined, otherRoot.id);
      expect(otherRootView.descendantApprovals).toEqual([
        expect.objectContaining({ executionId: unrelatedApproval.executionId, threadId: unrelatedChild.threadId }),
      ]);

      await permissionRequest(env.runtime, 'POST', '/approvals', {
        executionId: unrelatedApproval.executionId,
        allow: true,
      });
      await env.runtime.drain();
    } finally {
      await env.cleanup();
    }
  });
});
