import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AssistantPayload } from '../src/core/types.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';

describe('durable Thread runtime invariants', () => {
  it('deduplicates Messages by ID and starts an idle Thread once', async () => {
    const model = new FakeModel(() => response('Ready.'));
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      const first = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      const retry = await env.runtime.submit(thread.id, 'message-1', 'Hello');
      await env.runtime.drain();

      expect(first.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      await env.cleanup();
    }
  });

  it('runs a Tool Batch concurrently and waits for every call to settle', async () => {
    const started = deferred<void>();
    const releaseAlpha = deferred<string>();
    const releaseBeta = deferred<string>();
    let starts = 0;
    const batchPlugin: PicoPlugin = {
      id: 'test.parallel-tools',
      name: 'Parallel tools',
      version: '1',
      activate({ tools }) {
        for (const name of ['batch_alpha', 'batch_beta']) {
          tools.register({ name, description: name, parameters: { type: 'object', properties: {} } }, async () => {
            starts += 1;
            if (starts === 2) started.resolve();
            return name === 'batch_alpha' ? releaseAlpha.promise : releaseBeta.promise;
          });
        }
      },
    };
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [
            { id: 'alpha', name: 'batch_alpha', arguments: {} },
            { id: 'alpha', name: 'batch_beta', arguments: {} },
          ])
        : response('Both tools finished.'),
    );
    const env = await setupRuntime(model, { plugins: [batchPlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'parallel-message', 'Run both tools');
      await started.promise;
      expect(starts).toBe(2);
      expect(model.calls).toBe(1);

      releaseAlpha.resolve('alpha done');
      await until(() =>
        env.store
          .listExecutions(thread.id)
          .some((execution) => execution.toolName === 'batch_alpha' && execution.status === 'completed'),
      );
      expect(model.calls).toBe(1);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.toolName === 'batch_beta')?.status).toBe(
        'running',
      );

      releaseBeta.resolve('beta done');
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(
        env.store
          .listExecutions(thread.id)
          .filter((execution) => execution.kind === 'tool')
          .every((execution) => execution.status === 'completed'),
      ).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'tool_result')).toHaveLength(2);
      const assistant = env.store.listRecords(thread.id).find((record) => record.kind === 'assistant')!;
      const assistantStep = assistant.payload as unknown as AssistantPayload;
      expect(new Set(assistantStep.toolCalls.map((call) => call.id)).size).toBe(2);
    } finally {
      releaseAlpha.resolve('cleanup');
      releaseBeta.resolve('cleanup');
      await env.cleanup();
    }
  });

  it('Pause preserves the current Model Step, saves incoming Messages, and Continue resumes later', async () => {
    const firstResponse = deferred<ReturnType<typeof response>>();
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1 ? firstResponse.promise : response('Continued.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'pause-message-1', 'Start');
      await until(() => model.calls === 1);
      const signal = model.signals[0]!;
      env.runtime.pause(thread.id);
      await env.runtime.submit(thread.id, 'pause-message-2', 'Save this for later');
      expect(signal.aborted).toBe(false);
      expect(model.calls).toBe(1);
      expect(env.runtime.getThread(thread.id)?.state).toBe('pausing');

      firstResponse.resolve(response('Finished the current step.'));
      await env.runtime.drain();
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
      expect(model.calls).toBe(1);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'message')).toHaveLength(2);

      env.runtime.continue(thread.id);
      await env.runtime.drain();
      expect(model.calls).toBe(2);
      expect(env.runtime.getThread(thread.id)?.state).toBe('idle');
    } finally {
      firstResponse.resolve(response('cleanup'));
      await env.cleanup();
    }
  });

  it('asks before a Host Executor tool call, then records the allowed result', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'read-call', name: 'read_file', arguments: { path: 'facts.txt' } }])
        : response('I read the file.'),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread('host');
    await writeFile(`${env.workspace}/facts.txt`, 'The durable fact.\n', 'utf8');
    try {
      expect(env.runtime.toolPermissions(thread.id).find((tool) => tool.name === 'read_file')?.policy).toBe('ask');
      await env.runtime.submit(thread.id, 'approval-message', 'Read facts.txt');
      await until(() => env.store.listApprovals(thread.id).some((approval) => approval.status === 'pending'));
      const approval = env.store.listApprovals(thread.id)[0]!;
      expect(env.store.getExecution(approval.executionId)?.status).toBe('pending');

      env.runtime.resolveApproval(approval.executionId, true);
      await env.runtime.drain();
      expect(env.store.getApproval(approval.executionId)?.status).toBe('allowed');
      expect(env.store.getExecution(approval.executionId)?.status).toBe('completed');
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
    } finally {
      await env.cleanup();
    }
  });

  it('explicit Interrupt aborts a Model Step and leaves no partial assistant fact', async () => {
    const started = deferred<void>();
    const model = new FakeModel(
      (_prompt, _callNumber, signal) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          signal.addEventListener('abort', () => reject(new DOMException('Interrupted', 'AbortError')), { once: true });
        }),
    );
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'interrupt-model-message', 'Begin');
      await started.promise;
      await env.runtime.interrupt(thread.id);
      await env.runtime.drain();
      expect(model.signals[0]?.aborted).toBe(true);
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model')?.status).toBe(
        'interrupted',
      );
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('discards partial streaming text when a Model Step fails', async () => {
    const model = new FakeModel((_prompt, _callNumber, _signal, onText) => {
      onText('unfinished draft');
      throw new Error('stream disconnected');
    });
    const env = await setupRuntime(model);
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'stream-failure-message', 'Write something');
      await env.runtime.drain();
      expect(env.store.listRecords(thread.id).filter((record) => record.kind === 'assistant')).toHaveLength(0);
      expect(env.store.listExecutions(thread.id).find((execution) => execution.kind === 'model')?.status).toBe(
        'failed',
      );
      expect(env.runtime.getThread(thread.id)?.state).toBe('paused');
    } finally {
      await env.cleanup();
    }
  });

  it('lets a child Thread and parent exchange ordinary Messages without blocking spawn', async () => {
    let parentId = '';
    let childId = '';
    let parentCalls = 0;
    let childCalls = 0;
    const model = new FakeModel((prompt) => {
      const threadId = prompt.system.match(/Current Thread ID: ([^\n]+)/)?.[1];
      if (threadId === parentId) {
        parentCalls += 1;
        if (parentCalls === 1)
          return response('', [
            {
              id: 'spawn',
              name: 'spawn_thread',
              arguments: { title: 'Research child', prompt: 'Find one useful fact.' },
            },
          ]);
        if (parentCalls === 2)
          return response('', [
            {
              id: 'reply',
              name: 'send_thread_message',
              arguments: { thread_id: childId, message: 'Please check the detail.' },
            },
          ]);
        return response('Parent received the child update.');
      }
      childCalls += 1;
      if (childCalls === 1)
        return response('', [
          {
            id: 'child-reply',
            name: 'send_thread_message',
            arguments: { thread_id: parentId, message: 'The detail is confirmed.' },
          },
        ]);
      return response('Child work is complete.');
    });
    const env = await setupRuntime(model);
    const parent = env.createThread('host', 'Main thread');
    parentId = parent.id;
    const unsubscribe = env.runtime.subscribe((event) => {
      const created = event.thread as { id?: string; parentThreadId?: string | null } | undefined;
      if (event.type === 'thread.created' && created?.parentThreadId === parent.id) childId = created.id ?? '';
    });
    try {
      await env.runtime.submit(parent.id, 'parent-child-start', 'Delegate a quick check');
      await env.runtime.drain();
      const child = env.store.getThread(childId);
      expect(child).not.toBeNull();
      expect(child?.projectId).toBe(parent.projectId);
      expect(child?.executorKind).toBe(parent.executorKind);
      expect(child?.parentThreadId).toBe(parent.id);
      expect(env.runtime.getSnapshot(parent.id)?.children.map((item) => item.id)).toContain(childId);

      const parentMessages = env.store.listRecords(parent.id).filter((record) => record.kind === 'message');
      const childMessages = env.store.listRecords(childId).filter((record) => record.kind === 'message');
      expect(
        parentMessages.some(
          (record) => record.payload.source === 'child' && record.payload.content === 'The detail is confirmed.',
        ),
      ).toBe(true);
      expect(
        childMessages.some(
          (record) => record.payload.source === 'child' && record.payload.content === 'Please check the detail.',
        ),
      ).toBe(true);
      expect(parentCalls).toBeGreaterThanOrEqual(3);
      expect(childCalls).toBeGreaterThanOrEqual(2);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${parent.id}`) &&
            prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'The detail is confirmed.'),
        ),
      ).toBe(true);
      expect(
        model.prompts.some(
          (prompt) =>
            prompt.system.includes(`Current Thread ID: ${childId}`) &&
            prompt.turns.some((turn) => turn.kind === 'message' && turn.content === 'Please check the detail.'),
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
      await env.cleanup();
    }
  });

  it('loads a local plugin tool, slash command, semantic UI contribution, state, and canonical log', async () => {
    const model = new FakeModel((_prompt, callNumber) =>
      callNumber === 1
        ? response('', [{ id: 'note', name: 'save_thread_note', arguments: { note: 'Keep the setup small.' } }])
        : response('Saved.'),
    );
    const env = await setupRuntime(model, { pluginDirectory: resolve(process.cwd(), 'plugins') });
    const thread = env.createThread();
    try {
      expect(env.runtime.pluginInfo().plugins.some((plugin) => plugin.id === 'pico.example-notes')).toBe(true);
      expect(env.runtime.availableCommands().some((command) => command.name === 'notes')).toBe(true);
      expect(env.runtime.pluginInfo().ui.some((contribution) => contribution.id === 'pico.example-notes:notes')).toBe(
        true,
      );

      await env.runtime.submit(thread.id, 'plugin-tool-message', 'Save a note');
      await env.runtime.drain();
      expect(
        env.store.getPluginState<Record<string, Array<{ note: string }>>>('pico.example-notes', 'notesByThread', {})[
          thread.id
        ]?.[0]?.note,
      ).toBe('Keep the setup small.');
      expect(
        env.store
          .listRecords(thread.id)
          .some((record) => record.kind === 'plugin' && record.payload.pluginId === 'pico.example-notes'),
      ).toBe(true);
      const command = await env.runtime.submit(thread.id, 'plugin-command', '/notes');
      expect(command.command?.text).toContain('Keep the setup small.');
    } finally {
      await env.cleanup();
    }
  });

  it('passes frozen projections to plugins while preserving canonical facts', async () => {
    let frozenObserved = false;
    const immutablePlugin: PicoPlugin = {
      id: 'test.immutable-projection',
      name: 'Immutable projection probe',
      version: '1',
      activate({ pipelines }) {
        pipelines.use<any, any>('projection', async (input, next) => {
          frozenObserved = Object.isFrozen(input.records[0]) && Object.isFrozen(input.records[0].payload);
          try {
            input.records[0].payload.content = 'rewritten';
          } catch {
            /* Frozen canonical view rejects writes. */
          }
          return next(input);
        });
      },
    };
    const model = new FakeModel(() => response('Kept intact.'));
    const env = await setupRuntime(model, { plugins: [immutablePlugin] });
    const thread = env.createThread();
    try {
      await env.runtime.submit(thread.id, 'immutable-message', 'Original fact');
      await env.runtime.drain();
      expect(frozenObserved).toBe(true);
      expect(
        env.store.listRecords(thread.id).find((record) => record.id === 'immutable-message')?.payload.content,
      ).toBe('Original fact');
      expect(() =>
        env.store.db
          .prepare('UPDATE canonical_records SET payload_json = ? WHERE id = ?')
          .run('{"content":"rewritten"}', 'immutable-message'),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM canonical_records WHERE id = ?').run('immutable-message')).toThrow(
        /append-only/,
      );
      const pluginRecord = env.store.appendPluginRecord(thread.id, 'test.owner', {
        pluginId: 'forged.owner',
        action: 'test',
      });
      expect(pluginRecord.payload.pluginId).toBe('test.owner');
      const logId = (env.store.db.prepare('SELECT id FROM execution_log LIMIT 1').get() as { id: string }).id;
      expect(() =>
        env.store.db.prepare('UPDATE execution_log SET detail_json = ? WHERE id = ?').run('{}', logId),
      ).toThrow(/append-only/);
      expect(() => env.store.db.prepare('DELETE FROM execution_log WHERE id = ?').run(logId)).toThrow(/append-only/);
    } finally {
      await env.cleanup();
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
