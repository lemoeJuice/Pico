import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { setupRuntime, FakeModel, response, deferred } from './helpers.js';
import type { ModelPrompt } from '../src/runtime/model.js';
import type { PicoRuntime } from '../src/runtime/runtime.js';
import { permissionPlugin } from '../src/plugins/permissions.js';

const environments: Array<Awaited<ReturnType<typeof setupRuntime>>> = [];
afterEach(async () => {
  await Promise.all(
    environments.splice(0).map(async (env) => {
      await env.cleanup();
    }),
  );
});

async function route<T>(
  runtime: PicoRuntime,
  method: string,
  path: string,
  body?: unknown,
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

function isReviewer(prompt: ModelPrompt): boolean {
  return prompt.system.includes('You are Pico Permission Reviewer.');
}

describe('Permission Auto-review', () => {
  it('reviews only ask requests and binds an allow to the single invocation', async () => {
    let mainCalls = 0;
    const model = new FakeModel((prompt) => {
      if (isReviewer(prompt)) {
        expect(prompt.tools).toEqual([]);
        const evidence = JSON.parse(prompt.turns[0]!.kind === 'message' ? prompt.turns[0]!.content : '{}');
        expect(evidence.requestedAction).toEqual({ tool: 'read_file', arguments: { path: 'facts.txt' } });
        expect(evidence.executionBoundary.statement).toContain('No broader access');
        return response('{"decision":"allow","reason":"The requested file is within the workspace."}');
      }
      mainCalls += 1;
      return mainCalls === 1
        ? response('', [{ id: 'review-allow-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('I read the file.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    environments.push(env);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'reviewed content', 'utf8');
    try {
      await route(env.runtime, 'PUT', '/reviewer', { threadId: thread.id, enabled: true });
      await env.runtime.submit(thread.id, 'auto-review-allow', 'Read facts.txt');
      await env.runtime.drain();
      const view = await route<{ autoReview: boolean; approvals: Array<Record<string, unknown>> }>(
        env.runtime,
        'GET',
        '/threads',
        undefined,
        thread.id,
      );
      expect(view.autoReview).toBe(true);
      expect(view.approvals[0]).toMatchObject({
        status: 'allowed',
        decisionSource: 'reviewer',
        reviewer: { outcome: 'allow', reason: 'The requested file is within the workspace.', model: 'test-model' },
      });
      expect(model.prompts.filter(isReviewer)).toHaveLength(1);
      const stored = env.store.listRecords(thread.id).filter((record) => record.kind === 'plugin');
      expect(
        stored.some(
          (record) => record.payload.pluginId === 'pico.permissions' && record.payload.action === 'reviewer.result',
        ),
      ).toBe(true);
      expect(
        env.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {})[thread.id],
      ).toBeUndefined();
    } finally {
      await env.runtime.interrupt(thread.id);
    }
  });

  it('fails closed to a per-invocation human decision when the reviewer denies', async () => {
    let mainCalls = 0;
    const model = new FakeModel((prompt) => {
      if (isReviewer(prompt))
        return response('{"decision":"deny","reason":"The requested action is not sufficiently justified."}');
      mainCalls += 1;
      return mainCalls === 1
        ? response('', [{ id: 'review-deny-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The file was read after your one-time approval.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    environments.push(env);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'one-time override', 'utf8');
    try {
      await route(env.runtime, 'PUT', '/reviewer', { threadId: thread.id, enabled: true });
      await env.runtime.submit(thread.id, 'auto-review-deny', 'Read facts.txt');
      for (let i = 0; i < 100; i += 1) {
        const view = await route<{ approvals: Array<Record<string, unknown>> }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          thread.id,
        );
        if (view.approvals.some((approval) => approval.status === 'pending' && approval.reviewer)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const view = await route<{ approvals: Array<Record<string, unknown>> }>(
        env.runtime,
        'GET',
        '/threads',
        undefined,
        thread.id,
      );
      const approval = view.approvals[0]!;
      expect(approval).toMatchObject({
        status: 'pending',
        reviewer: { outcome: 'deny', reason: 'The requested action is not sufficiently justified.' },
      });
      await expect(
        route(env.runtime, 'POST', '/approvals', {
          executionId: approval.executionId,
          allow: true,
          rememberForThread: true,
        }),
      ).rejects.toThrow(/only allow this invocation once/i);
      await route(env.runtime, 'POST', '/approvals', { executionId: approval.executionId, allow: true });
      await env.runtime.drain();
      const after = await route<{ approvals: Array<Record<string, unknown>> }>(
        env.runtime,
        'GET',
        '/threads',
        undefined,
        thread.id,
      );
      expect(after.approvals[0]).toMatchObject({ status: 'allowed', decisionSource: 'user' });
      expect(
        env.store.getPluginState<Record<string, Record<string, string>>>('pico.permissions', 'rules', {})[thread.id],
      ).toBeUndefined();
    } finally {
      await env.runtime.interrupt(thread.id);
    }
  });

  it('keeps reviewer errors closed and returns control to the human approval boundary', async () => {
    let mainCalls = 0;
    const model = new FakeModel((prompt) => {
      if (isReviewer(prompt)) throw new Error('temporary provider failure');
      mainCalls += 1;
      return mainCalls === 1
        ? response('', [{ id: 'review-error-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('Read after approval.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    environments.push(env);
    const thread = env.createThread('host');
    try {
      await route(env.runtime, 'PUT', '/reviewer', { threadId: thread.id, enabled: true });
      await env.runtime.submit(thread.id, 'auto-review-error', 'Read facts.txt');
      for (let i = 0; i < 100; i += 1) {
        const view = await route<{ approvals: Array<Record<string, unknown>> }>(
          env.runtime,
          'GET',
          '/threads',
          undefined,
          thread.id,
        );
        if (view.approvals.some((approval) => approval.status === 'pending' && approval.reviewer)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const view = await route<{ approvals: Array<Record<string, unknown>> }>(
        env.runtime,
        'GET',
        '/threads',
        undefined,
        thread.id,
      );
      expect(view.approvals[0]).toMatchObject({
        status: 'pending',
        reviewer: {
          outcome: 'unavailable',
          reason: 'Reviewer unavailable. Approval temporarily failed; no decision was made. This is not a denial.',
        },
      });
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'pending',
      );
    } finally {
      await env.runtime.interrupt(thread.id);
    }
  });

  it('aborts an in-flight reviewer with the tool execution and records cancellation', async () => {
    const reviewerStarted = deferred<AbortSignal>();
    let mainCalls = 0;
    const model = new FakeModel((prompt, _callNumber, signal) => {
      if (isReviewer(prompt)) {
        reviewerStarted.resolve(signal);
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      mainCalls += 1;
      return mainCalls === 1
        ? response('', [{ id: 'review-abort-read', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('The review was interrupted.');
    });
    const env = await setupRuntime(model, { plugins: [permissionPlugin] });
    environments.push(env);
    const thread = env.createThread('host');
    try {
      await route(env.runtime, 'PUT', '/reviewer', { threadId: thread.id, enabled: true });
      await env.runtime.submit(thread.id, 'auto-review-abort', 'Read facts.txt');
      const reviewerSignal = await reviewerStarted.promise;
      await env.runtime.interrupt(thread.id);
      expect(reviewerSignal.aborted).toBe(true);
      const view = await route<{ approvals: Array<Record<string, unknown>> }>(
        env.runtime,
        'GET',
        '/threads',
        undefined,
        thread.id,
      );
      expect(view.approvals[0]).toMatchObject({ status: 'cancelled' });
      expect(view.approvals[0]?.reviewer).toBeUndefined();
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'tool')?.status).toBe(
        'interrupted',
      );
    } finally {
      await env.runtime.interrupt(thread.id);
    }
  });
});
