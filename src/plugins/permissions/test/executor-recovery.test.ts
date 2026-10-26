import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PicoStore } from '../../../core/store.js';
import { PicoRuntime } from '../../../runtime/runtime.js';
import { assistantPayload, FakeModel, response } from '../../../../test/helpers.js';

it('recovers durable work and interrupts a Host tool only after the Executor confirms it was lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pico-recovery-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const databasePath = join(directory, 'runtime.sqlite');
  let store = new PicoStore(databasePath);
  const project = store.createProject('Recovery', workspace);
  const thread = store.createThread(project.id, 'host');
  const lostToolId = `${thread.id}:tool-model:lost-call`;
  const strandedModel = store.createModelExecution('stranded-model', thread.id, 0);
  store.transitionExecution(strandedModel.id, 'running');
  const preparingModel = store.createModelExecution('tool-model', thread.id, 0);
  store.transitionExecution(preparingModel.id, 'running');
  store.commitModelStep({
    assistantRecordId: 'tool-model:assistant',
    modelExecutionId: preparingModel.id,
    threadId: thread.id,
    payload: assistantPayload({
      batchId: 'tool-model:batch',
      toolCalls: [{ id: 'lost-call', name: 'read_file', arguments: { path: 'input.txt' } }],
    }),
    toolCalls: [
      {
        call: { id: 'lost-call', name: 'read_file', arguments: { path: 'input.txt' } },
        executionId: lostToolId,
        source: 'executor',
      },
    ],
  });
  store.transitionExecution(lostToolId, 'running');
  store.setPluginState('pico.permissions', 'approvals', {
    [lostToolId]: {
      executionId: lostToolId,
      threadId: thread.id,
      toolName: 'read_file',
      arguments: { path: 'input.txt' },
      status: 'allowed',
      createdAt: new Date().toISOString(),
    },
  });
  store.close();

  store = new PicoStore(databasePath);
  const runtime = new PicoRuntime(store, {
    model: new FakeModel(() => response('unused')),
    pluginDirectory: join(directory, 'plugins'),
  });
  await runtime.initialize();
  try {
    await runtime.drain();
    expect(store.getExecution('stranded-model')?.status).toBe('interrupted');
    expect(store.getExecution(lostToolId)?.error).toMatch(/confirmed/i);
    expect(store.getExecution(lostToolId)?.status).toBe('interrupted');
    expect(
      store
        .listRecords(thread.id)
        .some((record) => record.kind === 'tool_result' && record.id === `${lostToolId}:result`),
    ).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
