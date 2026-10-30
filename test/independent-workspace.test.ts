import { describe, expect, it, vi } from 'vitest';
import { deferred, FakeModel, response, setupRuntime } from './helpers.js';
import type { ContainerExecutor } from '../src/executor/container-executor.js';
import type { HostExecutor } from '../src/executor/host-executor.js';

describe('independent Thread workspace attachment', () => {
  it('offers an Executor update when an older agent cannot run without a workspace', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.runtime.createIndependentThread('host', 'Independent');
    const host = (env.runtime as unknown as { hostExecutor: HostExecutor }).hostExecutor;
    const check = vi.spyOn(host, 'checkConnection').mockResolvedValue({
      protocolVersion: 2,
      executorVersion: '0.2.1',
      updateSupported: true,
      name: 'old',
      kind: 'executor',
      workspaceRoot: '/',
      tools: [],
    });
    try {
      expect(await env.runtime.executorStatus(thread.id)).toMatchObject({
        connected: false,
        compatible: false,
        updateAvailable: true,
        updateSupported: true,
        error: expect.stringContaining('without a workspace'),
      });
    } finally {
      check.mockRestore();
      await env.cleanup();
    }
  });

  it('prevents new work and archive changes while the container is being attached', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.runtime.createIndependentThread('container', 'Independent');
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const entered = deferred<void>();
    const unblock = deferred<void>();
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockImplementation(async () => {
      entered.resolve();
      await unblock.promise;
    });
    const finalize = vi.spyOn(adapter, 'finalizeWorkspaceAttachment').mockResolvedValue();
    try {
      const assigning = env.runtime.createProjectFromThread(thread.id, 'Project', env.workspace);
      await entered.promise;
      expect(env.store.getThread(thread.id)?.projectId).toBeNull();
      await expect(env.runtime.submit(thread.id, 'during-attach', 'Start work')).rejects.toThrow(/workspace is being changed/);
      expect(() => env.runtime.continue(thread.id)).toThrow(/workspace is being changed/);
      expect(() => env.runtime.archiveThread(thread.id)).toThrow(/workspace is being changed/);
      unblock.resolve();
      const { project } = await assigning;
      expect(env.store.getThread(thread.id)).toMatchObject({ projectId: project.id, workspacePath: env.workspace });
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      unblock.resolve();
      attach.mockRestore();
      finalize.mockRestore();
      await env.cleanup();
    }
  });
});
