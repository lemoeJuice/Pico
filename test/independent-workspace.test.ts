import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockResolvedValue();
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
      copy.mockRestore();
      finalize.mockRestore();
      await env.cleanup();
    }
  });

  it('attaches a shared parent and child Container only once when creating a Project', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const parent = env.runtime.createIndependentThread('container', 'Parent');
    const child = env.store.createThread(null, 'container', 'Child', {
      parentThreadId: parent.id,
      inheritExecutorId: parent.executorId,
    });
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockResolvedValue();
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockResolvedValue();
    const finalize = vi.spyOn(adapter, 'finalizeWorkspaceAttachment').mockResolvedValue();
    try {
      const { project } = await env.runtime.createProjectFromThread(parent.id, 'Shared', env.workspace);
      expect(attach).toHaveBeenCalledOnce();
      expect(copy).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledOnce();
      expect(env.store.getThread(child.id)).toMatchObject({
        projectId: project.id,
        executorId: parent.executorId,
        workspacePath: env.workspace,
      });
    } finally {
      attach.mockRestore(); copy.mockRestore(); finalize.mockRestore();
      await env.cleanup();
    }
  });

  it('copies staged container files including hidden files into the new workspace', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.runtime.createIndependentThread('container', 'Independent');
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockImplementation(async (_binding, stagingPath) => {
      await writeFile(join(stagingPath, 'notes.txt'), 'from container');
      await writeFile(join(stagingPath, '.env.example'), 'hidden');
    });
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockResolvedValue();
    const finalize = vi.spyOn(adapter, 'finalizeWorkspaceAttachment').mockResolvedValue();
    const destination = await mkdtemp(join(tmpdir(), 'pico-independent-workspace-'));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    try {
      await env.runtime.createProjectFromThread(thread.id, 'Project', destination);
      expect(await readFile(join(destination, 'notes.txt'), 'utf8')).toBe('from container');
      expect(await readFile(join(destination, '.env.example'), 'utf8')).toBe('hidden');
      expect(copy).toHaveBeenCalledOnce();
      expect(attach).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      copy.mockRestore(); attach.mockRestore(); finalize.mockRestore();
      await env.cleanup();
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('rejects staged file conflicts without overwriting destination and rolls back attachment', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const thread = env.runtime.createIndependentThread('container', 'Independent');
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockImplementation(async (_binding, stagingPath) => {
      await writeFile(join(stagingPath, 'same.txt'), 'container version');
      await writeFile(join(stagingPath, 'new.txt'), 'new file');
      await writeFile(join(destination, 'same.txt'), 'user version');
    });
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockResolvedValue();
    const rollback = vi.spyOn(adapter, 'rollbackWorkspaceAttachment').mockResolvedValue();
    const destination = await mkdtemp(join(tmpdir(), 'pico-independent-conflict-'));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    try {
      await expect(env.runtime.createProjectFromThread(thread.id, 'Project', destination)).rejects.toThrow(/changed during migration/i);
      expect(await readFile(join(destination, 'same.txt'), 'utf8')).toBe('user version');
      expect((await readdir(destination)).sort()).toEqual(['same.txt']);
      expect(rollback).toHaveBeenCalledOnce();
      expect(env.store.getThread(thread.id)?.projectId).toBeNull();
    } finally {
      copy.mockRestore(); attach.mockRestore(); rollback.mockRestore();
      await env.cleanup();
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('rejects same-path conflicts between two independent containers and rolls both back', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const first = env.runtime.createIndependentThread('container', 'First');
    const second = env.store.createThread(null, 'container', 'Second', { parentThreadId: first.id });
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const rollback = vi.spyOn(adapter, 'rollbackWorkspaceAttachment').mockResolvedValue();
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockResolvedValue();
    const bindings = [env.store.executorForThread(first.id)!, env.store.executorForThread(second.id)!];
    const contents = new Map(bindings.map((binding, index) => [binding.id, `container-${index}`]));
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockImplementation(async (binding, stagingPath) => {
      await writeFile(join(stagingPath, 'shared.txt'), contents.get(binding.id)!);
    });
    const destination = await mkdtemp(join(tmpdir(), 'pico-two-container-conflict-'));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    try {
      await expect(env.runtime.createProjectFromThread(first.id, 'Project', destination)).rejects.toThrow(/conflict/i);
      expect(await readdir(destination)).toEqual([]);
      expect(attach).toHaveBeenCalledTimes(2);
      expect(rollback).toHaveBeenCalledTimes(2);
      expect(env.store.getThread(first.id)?.projectId).toBeNull();
      expect(env.store.getThread(second.id)?.projectId).toBeNull();
    } finally {
      copy.mockRestore(); attach.mockRestore(); rollback.mockRestore();
      await env.cleanup();
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('merges distinct paths from two independent containers', async () => {
    const env = await setupRuntime(new FakeModel(() => response('unused')));
    const first = env.runtime.createIndependentThread('container', 'First');
    const second = env.store.createThread(null, 'container', 'Second', { parentThreadId: first.id });
    const adapter = (env.runtime as unknown as { containerExecutor: ContainerExecutor }).containerExecutor;
    const bindings = [env.store.executorForThread(first.id)!, env.store.executorForThread(second.id)!];
    const copy = vi.spyOn(adapter, 'copyIndependentWorkspace').mockImplementation(async (binding, stagingPath) => {
      const index = bindings.findIndex((item) => item.id === binding.id);
      await writeFile(join(stagingPath, index === 0 ? 'first.txt' : 'second.txt'), `from-${index}`);
    });
    const attach = vi.spyOn(adapter, 'attachWorkspace').mockResolvedValue();
    const finalize = vi.spyOn(adapter, 'finalizeWorkspaceAttachment').mockResolvedValue();
    const destination = await mkdtemp(join(tmpdir(), 'pico-two-container-merge-'));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    try {
      await env.runtime.createProjectFromThread(first.id, 'Project', destination);
      expect(await readFile(join(destination, 'first.txt'), 'utf8')).toBe('from-0');
      expect(await readFile(join(destination, 'second.txt'), 'utf8')).toBe('from-1');
      expect(copy).toHaveBeenCalledTimes(2);
      expect(attach).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledTimes(2);
    } finally {
      copy.mockRestore(); attach.mockRestore(); finalize.mockRestore();
      await env.cleanup();
      await rm(destination, { recursive: true, force: true });
    }
  });
});
