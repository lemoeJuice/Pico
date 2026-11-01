import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorBinding } from '../src/core/types.js';
import { ExecutorActivity } from '../src/runtime/executor-activity.js';
import type { PicoPlugin } from '../src/plugins/host.js';
import { FakeModel, response, setupRuntime } from './helpers.js';

const binding = (id: string, kind: ExecutorBinding['kind'] = 'host'): ExecutorBinding => ({
  id,
  kind,
  label: id,
  workspacePath: `/workspace/${id}`,
  remoteConnectionId: null,
  createdAt: new Date(0).toISOString(),
});

async function flushActivity(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ExecutorActivity', () => {
  it.each(['remote', 'host', 'container'] as const)('retries an unsuccessful %s connection while the source remains active', async (kind) => {
    vi.useFakeTimers();
    const target = kind === 'remote'
      ? { ...binding('remote'), remoteConnectionId: 'remote-connection' }
      : binding(kind, kind);
    const heartbeat = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const activity = new ExecutorActivity(() => target, heartbeat, async () => undefined);
    try {
      activity.renew('thread', 'thread', 'thread', null);
      await flushActivity();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      await activity.shutdown();
    }
  });
  it('keeps a remote connection probed only while its activity lease remains live', async () => {
    vi.useFakeTimers();
    const target = { ...binding('remote'), remoteConnectionId: 'remote-connection' };
    const heartbeat = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const activity = new ExecutorActivity(() => target, heartbeat, release);
    try {
      activity.renew('viewer', 'viewer', 'thread', 60_000);
      await flushActivity();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20_000);
      await flushActivity();
      expect(heartbeat).toHaveBeenCalledTimes(2);
      activity.clear('viewer', 'viewer');
      await flushActivity();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      await activity.shutdown();
    }
  });

  it('reports active viewer, plugin, thread, and Runtime leases without waking an Executor', async () => {
    vi.useFakeTimers();
    const bindings = new Map([
      ['thread-a', binding('container-a', 'container')],
      ['thread-b', binding('host-b')],
    ]);
    const heartbeat = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const resolve = vi.fn((threadId: string) => bindings.get(threadId) ?? null);
    const activity = new ExecutorActivity(resolve, heartbeat, release);
    try {
      activity.renew('viewer', 'viewer-a', 'thread-a', null);
      activity.renew('plugin', 'plugin-a', 'thread-a', 1_000);
      activity.renew('thread', 'thread-a', 'thread-a', null);
      activity.renew('runtime', 'runtime-b', 'thread-b', null);
      await flushActivity();

      expect(activity.hasThread('thread-a')).toBe(true);
      expect(activity.hasThread('thread-b')).toBe(true);
      expect(activity.hasThread('thread-missing')).toBe(false);
      const heartbeatCount = heartbeat.mock.calls.length;
      const resolveCount = resolve.mock.calls.length;
      expect(activity.hasThread('thread-a')).toBe(true);
      expect(heartbeat).toHaveBeenCalledTimes(heartbeatCount);
      expect(resolve).toHaveBeenCalledTimes(resolveCount);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(activity.hasThread('thread-a')).toBe(true);
      activity.clear('viewer', 'viewer-a');
      activity.clear('thread', 'thread-a');
      await flushActivity();
      expect(activity.hasThread('thread-a')).toBe(false);
      expect(activity.hasThread('thread-b')).toBe(true);
    } finally {
      await activity.shutdown();
    }
  });

  it('keeps sources independent, releases a viewer’s previous Executor on switch, and expires only finite leases', async () => {
    vi.useFakeTimers();
    const bindings = new Map([
      ['thread-a', binding('host-a')],
      ['thread-b', binding('container-b', 'container')],
    ]);
    const heartbeats: Array<{
      binding: ExecutorBinding;
      identity: { runtimeId: string; source: string; leaseId: string };
    }> = [];
    const releases: Array<{
      binding: ExecutorBinding;
      identity: { runtimeId: string; source: string; leaseId: string };
    }> = [];
    const activity = new ExecutorActivity(
      (threadId) => bindings.get(threadId) ?? null,
      async (target, identity) => {
        heartbeats.push({ binding: target, identity });
      },
      async (target, identity) => {
        releases.push({ binding: target, identity });
      },
    );
    try {
      activity.renew('thread', 'thread-a', 'thread-a', null);
      activity.renew('plugin', 'same-id', 'thread-a', 10_000);
      activity.renew('viewer', 'same-id', 'thread-a', null);
      await flushActivity();
      expect(heartbeats.map(({ identity }) => identity.source)).toEqual(['thread', 'plugin', 'viewer']);
      expect(new Set(heartbeats.map(({ identity }) => identity.runtimeId)).size).toBe(1);
      expect(heartbeats.map(({ identity }) => identity.leaseId)).toEqual(['thread-a', 'same-id', 'same-id']);

      activity.renew('viewer', 'same-id', 'thread-b', null);
      await flushActivity();
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({
        binding: bindings.get('thread-a'),
        identity: { source: 'viewer', leaseId: 'same-id' },
      });
      expect(heartbeats.at(-1)).toMatchObject({
        binding: bindings.get('thread-b'),
        identity: { source: 'viewer', leaseId: 'same-id' },
      });

      activity.renew('plugin', 'same-id', 'thread-a', 10_000);
      await flushActivity();
      await vi.advanceTimersByTimeAsync(10_000);
      await flushActivity();
      expect(releases.filter(({ identity }) => identity.source === 'plugin')).toHaveLength(1);
      expect(releases.some(({ identity }) => identity.source === 'thread')).toBe(false);
      expect(releases.filter(({ identity }) => identity.source === 'viewer')).toHaveLength(1);
    } finally {
      await activity.shutdown();
    }
  });

  it('serializes a late asynchronous heartbeat before its release during shutdown', async () => {
    const target = binding('host-a');
    let resolveHeartbeat!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const events: string[] = [];
    const activity = new ExecutorActivity(
      () => target,
      async (_binding, identity) => {
        events.push(`heartbeat:${identity.leaseId}:start`);
        await gate;
        events.push(`heartbeat:${identity.leaseId}:done`);
      },
      async (_binding, identity) => {
        events.push(`release:${identity.leaseId}`);
      },
    );

    activity.renew('viewer', 'viewer-1', 'thread-a', null);
    await flushActivity();
    expect(events).toEqual(['heartbeat:viewer-1:start']);
    const shutdown = activity.shutdown();
    resolveHeartbeat();
    await shutdown;
    expect(events).toEqual(['heartbeat:viewer-1:start', 'heartbeat:viewer-1:done', 'release:viewer-1']);
    activity.renew('viewer', 'viewer-1', 'thread-a', null);
    await flushActivity();
    expect(events).toHaveLength(3);
  });

  it('does not allow a delayed heartbeat to outlive an explicit clear', async () => {
    const target = binding('host-a');
    let resolveHeartbeat!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const events: string[] = [];
    const activity = new ExecutorActivity(
      () => target,
      async (_binding, identity) => {
        events.push(`heartbeat:${identity.leaseId}:start`);
        await gate;
        events.push(`heartbeat:${identity.leaseId}:done`);
      },
      async (_binding, identity) => {
        events.push(`release:${identity.leaseId}`);
      },
    );

    activity.renew('plugin', 'plugin-1', 'thread-a', 60_000);
    await flushActivity();
    activity.clear('plugin', 'plugin-1');
    resolveHeartbeat();
    await activity.shutdown();
    expect(events).toEqual(['heartbeat:plugin-1:start', 'heartbeat:plugin-1:done', 'release:plugin-1']);
  });
});

describe('PicoRuntime executor activity wiring', () => {
  it('leases capable remote Executors and only probes older remote Executors', async () => {
    const env = await setupRuntime(new FakeModel(() => response('done')), { executorActivityEnabled: true });
    const remote = (env.runtime as unknown as {
      remoteHostExecutor: {
        checkConnection: (binding: ExecutorBinding) => Promise<unknown>;
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<string>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
    }).remoteHostExecutor;
    const target = { ...binding('remote'), remoteConnectionId: 'remote-connection' };
    vi.spyOn(env.store, 'executorForThread').mockReturnValue(target);
    const check = vi.spyOn(remote, 'checkConnection').mockResolvedValue({ leaseHeartbeat: true });
    const heartbeat = vi.spyOn(remote, 'heartbeat').mockResolvedValue('token');
    const release = vi.spyOn(remote, 'release').mockResolvedValue();
    const thread = env.createThread('host');
    try {
      env.runtime.updateThreadViewer('viewer', thread.id);
      await flushActivity();
      expect(heartbeat).toHaveBeenCalledOnce();
      env.runtime.updateThreadViewer('viewer', null);
      await flushActivity();
      expect(release).toHaveBeenCalledOnce();

      check.mockResolvedValue({ leaseHeartbeat: false });
      env.runtime.updateThreadViewer('viewer', thread.id);
      await flushActivity();
      expect(check).toHaveBeenCalledTimes(2);
      expect(heartbeat).toHaveBeenCalledOnce();
    } finally {
      await env.cleanup();
    }
  });

  it('does not wake an inactive Executor when a client only asks for status', async () => {
    const env = await setupRuntime(new FakeModel(() => response('done')), { executorActivityEnabled: true });
    const internals = env.runtime as unknown as {
      hostExecutor: {
        checkConnection: (binding: ExecutorBinding) => Promise<unknown>;
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
    };
    const check = vi.spyOn(internals.hostExecutor, 'checkConnection').mockResolvedValue({
      protocolVersion: 2, kind: 'executor', executorVersion: '0.2.3', workspaceOptional: true, leaseHeartbeat: true,
    });
    vi.spyOn(internals.hostExecutor, 'heartbeat').mockResolvedValue();
    vi.spyOn(internals.hostExecutor, 'release').mockResolvedValue();
    const thread = env.createThread('host');
    try {
      expect(await env.runtime.executorStatus(thread.id, false)).toMatchObject({ inactive: true });
      expect(check).not.toHaveBeenCalled();
      env.runtime.updateThreadViewer('viewer', thread.id);
      expect(await env.runtime.executorStatus(thread.id, false)).toMatchObject({ connected: true });
      expect(check).toHaveBeenCalledOnce();
    } finally {
      await env.cleanup();
    }
  });

  it('switches viewer leases across Executors and clears them on disconnect and shutdown', async () => {
    const env = await setupRuntime(new FakeModel(() => response('done')), { executorActivityEnabled: true });
    const runtime = env.runtime as unknown as {
      hostExecutor: {
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
      containerExecutor: {
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
    };
    const events: string[] = [];
    vi.spyOn(runtime.hostExecutor, 'heartbeat').mockImplementation(async (_binding, identity) => {
      events.push(`host:heartbeat:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(runtime.hostExecutor, 'release').mockImplementation(async (_binding, identity) => {
      events.push(`host:release:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(runtime.containerExecutor, 'heartbeat').mockImplementation(async (_binding, identity) => {
      events.push(`container:heartbeat:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(runtime.containerExecutor, 'release').mockImplementation(async (_binding, identity) => {
      events.push(`container:release:${identity.source}:${identity.leaseId}`);
    });
    const hostThread = env.createThread('host');
    const containerThread = env.createThread('container');
    const viewerId = 'socket-viewer';
    try {
      env.runtime.updateThreadViewer(viewerId, hostThread.id);
      await flushActivity();
      env.runtime.updateThreadViewer(viewerId, containerThread.id);
      await flushActivity();
      expect(events).toEqual([
        `host:heartbeat:viewer:${viewerId}`,
        `host:release:viewer:${viewerId}`,
        `container:heartbeat:viewer:${viewerId}`,
      ]);

      env.runtime.updateThreadViewer(viewerId, null);
      await flushActivity();
      env.runtime.updateThreadViewer('shutdown-viewer', hostThread.id);
      await flushActivity();
      await env.runtime.shutdown();
      expect(events.slice(-2)).toEqual([
        `host:heartbeat:viewer:shutdown-viewer`,
        `host:release:viewer:shutdown-viewer`,
      ]);
    } finally {
      await env.cleanup();
    }
  });

  it('renews loop activity after each loop start and releases it after each loop end', async () => {
    const model = new FakeModel(() => response('done'));
    const env = await setupRuntime(model, { executorActivityEnabled: true });
    const internals = env.runtime as unknown as {
      hostExecutor: {
        listTools: (binding: ExecutorBinding) => Promise<import('../src/core/types.js').ToolDefinition[]>;
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
    };
    const events: string[] = [];
    vi.spyOn(internals.hostExecutor, 'heartbeat').mockImplementation(async (_binding, identity) => {
      events.push(`heartbeat:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(internals.hostExecutor, 'release').mockImplementation(async (_binding, identity) => {
      events.push(`release:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(internals.hostExecutor, 'listTools').mockResolvedValue([]);
    const thread = env.createThread('host');
    try {
      await env.runtime.submit(thread.id, 'first-user', 'first');
      await env.runtime.drain();
      await flushActivity();
      expect(events.filter((event) => event === `heartbeat:thread:${thread.id}`)).toHaveLength(1);
      expect(events.filter((event) => event === `release:thread:${thread.id}`)).toHaveLength(1);

      await env.runtime.submit(thread.id, 'second-user', 'second');
      await env.runtime.drain();
      await flushActivity();
      expect(model.calls).toBe(2);
      expect(events.filter((event) => event === `heartbeat:thread:${thread.id}`)).toHaveLength(2);
      expect(events.filter((event) => event === `release:thread:${thread.id}`)).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  });

  it('exposes plugin leases with a bounded TTL and releases them on expiry', async () => {
    vi.useFakeTimers();
    let pluginApi: { heartbeat(threadId: string): void; release(threadId: string): void } | undefined;
    const plugin: PicoPlugin = {
      id: 'test.executor-activity',
      name: 'Executor activity test',
      version: '1.0.0',
      activate(context) {
        pluginApi = context.executors;
      },
    };
    const env = await setupRuntime(new FakeModel(() => response('done')), { plugins: [plugin], executorActivityEnabled: true });
    const internals = env.runtime as unknown as {
      hostExecutor: {
        heartbeat: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
        release: (binding: ExecutorBinding, identity: { source: string; leaseId: string }) => Promise<void>;
      };
    };
    const events: string[] = [];
    vi.spyOn(internals.hostExecutor, 'heartbeat').mockImplementation(async (_binding, identity) => {
      events.push(`heartbeat:${identity.source}:${identity.leaseId}`);
    });
    vi.spyOn(internals.hostExecutor, 'release').mockImplementation(async (_binding, identity) => {
      events.push(`release:${identity.source}:${identity.leaseId}`);
    });
    const thread = env.createThread('host');
    try {
      pluginApi!.heartbeat(thread.id);
      await flushActivity();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatch(/^heartbeat:plugin:/);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushActivity();
      expect(events.filter((event) => event.startsWith('release:plugin:'))).toHaveLength(1);

      pluginApi!.heartbeat(thread.id);
      await flushActivity();
      pluginApi!.release(thread.id);
      await flushActivity();
      expect(events.filter((event) => event.startsWith('release:plugin:'))).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  });
});
