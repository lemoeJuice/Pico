import { describe, expect, it } from 'vitest';
import type { ProjectionInput } from '../src/contracts/plugin-pipeline.js';
import type { Thread } from '../src/core/types.js';
import type { ThreadContextState } from '../src/runtime/context-state.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

interface RuntimeContextReplacementAccess {
  projectModelInput(thread: Thread, records: readonly ReturnType<Awaited<ReturnType<typeof setupRuntime>>['store']['listRecords']>[number][], through: number, modelStep?: boolean): Promise<ProjectionInput>;
  contextStates: ThreadContextState;
  threadModelSelection(threadId: string): { model: string };
  commitContextReplacement(
    threadId: string,
    preview: ProjectionInput,
    candidate: ProjectionInput,
    commit: () => boolean,
  ): Promise<{ committed: boolean; reason?: string }>;
}

async function prepare(env: Awaited<ReturnType<typeof setupRuntime>>) {
  const thread = env.createThread('runtime');
  env.store.appendCanonical(thread.id, 'replacement-user', 'message', {
    role: 'user', source: 'user', content: 'original context',
  });
  const access = env.runtime as unknown as RuntimeContextReplacementAccess;
  const records = env.store.listRecords(thread.id);
  const preview = await access.projectModelInput(thread, records, records.at(-1)!.seq, false);
  const candidate: ProjectionInput = {
    ...preview,
    turns: structuredClone(preview.turns),
    provenance: structuredClone(preview.provenance ?? []),
  };
  const firstMessage = candidate.turns.find((turn) => turn.kind === 'message');
  if (!firstMessage) throw new Error('Expected projected user message.');
  firstMessage.content = 'replacement capsule';
  return { thread, access, preview, candidate };
}

describe('Runtime context replacement atomicity', () => {
  it('rejects altered provider accounting history before invoking commit', async () => {
    const env = await setupRuntime(new FakeModel(() => response('ok')), { resolveProjectionTokenCount: () => 42 });
    try {
      const { thread, access, preview, candidate } = await prepare(env);
      const accountingKey = Object.getOwnPropertySymbols(preview).find((key) => key.description === 'pico.context-token-records');
      if (!accountingKey) throw new Error('Expected provider accounting history.');
      Object.defineProperty(candidate, accountingKey, { value: [], enumerable: true });
      const before = await access.contextStates.read(thread.id);
      let commitCalls = 0;
      const result = await access.commitContextReplacement(thread.id, preview, candidate, () => {
        commitCalls += 1;
        return true;
      });
      expect(result.committed).toBe(false);
      expect(commitCalls).toBe(0);
      expect(await access.contextStates.read(thread.id)).toEqual(before);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects a candidate without a provider count before invoking commit or changing state', async () => {
    const env = await setupRuntime(new FakeModel(() => response('ok')), { resolveProjectionTokenCount: () => null });
    try {
      const { thread, access, preview, candidate } = await prepare(env);
      const beforeState = await access.contextStates.read(thread.id);
      const beforeRecords = env.store.listRecords(thread.id);
      let commitCalls = 0;

      const result = await access.commitContextReplacement(thread.id, preview, candidate, () => {
        commitCalls += 1;
        return true;
      });

      expect(result.committed).toBe(false);
      expect(commitCalls).toBe(0);
      expect(await access.contextStates.read(thread.id)).toEqual(beforeState);
      expect(env.store.listRecords(thread.id)).toEqual(beforeRecords);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects when canonical history and model selection change during token validation', async () => {
    let armed = false;
    let mutateDuringCount = () => {};
    const env = await setupRuntime(new FakeModel(() => response('ok')), {
      resolveProjectionTokenCount: () => {
        if (armed) mutateDuringCount();
        return 42;
      },
    });
    try {
      const { thread, access, preview, candidate } = await prepare(env);
      const nextSelection = await env.catalog.addModel('changed-model');
      const beforeState = await access.contextStates.read(thread.id);
      const beforeRecords = env.store.listRecords(thread.id);
      let commitCalls = 0;
      mutateDuringCount = () => {
        env.store.appendCanonical(thread.id, 'concurrent-user', 'message', {
          role: 'user', source: 'user', content: 'concurrent message',
        });
        env.runtime.updateThreadModelSelection(thread.id, nextSelection);
      };
      armed = true;

      const result = await access.commitContextReplacement(thread.id, preview, candidate, () => {
        commitCalls += 1;
        return true;
      });

      expect(result.committed).toBe(false);
      expect(commitCalls).toBe(0);
      expect(await access.contextStates.read(thread.id)).toEqual(beforeState);
      expect(env.store.listRecords(thread.id)).toHaveLength(beforeRecords.length + 1);
      expect(env.store.listRecords(thread.id).at(-1)?.id).toBe('concurrent-user');
      expect(access.threadModelSelection(thread.id).model).toBe('changed-model');
    } finally {
      await env.cleanup();
    }
  });

  it('commits the replacement and side effect exactly once when the preview remains current', async () => {
    const env = await setupRuntime(new FakeModel(() => response('ok')), { resolveProjectionTokenCount: () => 42 });
    try {
      const { thread, access, preview, candidate } = await prepare(env);
      let commitCalls = 0;

      const result = await access.commitContextReplacement(thread.id, preview, candidate, () => {
        commitCalls += 1;
        env.store.appendCanonical(thread.id, 'replacement-commit', 'plugin', { action: 'committed' });
        return true;
      });

      expect(result).toEqual({ committed: true });
      expect(commitCalls).toBe(1);
      expect(await access.contextStates.read(thread.id)).toMatchObject({
        sourceThrough: preview.through,
        tokenCount: 42,
        turns: [{ kind: 'message', role: 'user', content: 'replacement capsule' }],
      });
      expect(env.store.listRecords(thread.id).at(-1)?.id).toBe('replacement-commit');
    } finally {
      await env.cleanup();
    }
  });
});
