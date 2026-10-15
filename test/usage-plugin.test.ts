import { describe, expect, it } from 'vitest';
import type { PluginModelCallRecord } from '../src/core/store.js';
import type { CanonicalRecord, Thread } from '../src/core/types.js';
import type { PluginContext } from '../src/plugins/host.js';
import { estimateUsageCost, usagePlugin, type UsageRate } from '../src/plugins/usage.js';

function harness() {
  const values = new Map<string, unknown>();
  const calls: PluginModelCallRecord[] = [];
  const records = new Map<string, CanonicalRecord[]>();
  const thread = { id: 'thread-1', projectId: 'project-1' } as Thread;
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  const context = {
    threads: { list: () => [thread] },
    canonical: { list: (threadId: string) => records.get(threadId) ?? [] },
    models: {
      history: (filter: { threadId?: string; projectId?: string } = {}) =>
        calls.filter(
          (call) =>
            (!filter.threadId || call.threadId === filter.threadId) &&
            (!filter.projectId || call.projectId === filter.projectId),
        ),
    },
    http: {
      register: (
        method: string,
        path: string,
        handler: (request: { body: unknown; query: URLSearchParams }) => unknown,
      ) => routes.set(`${method} ${path}`, handler),
    },
    ui: { registerPage: () => undefined },
    state: {
      get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
      set: <T>(key: string, value: T) => values.set(key, structuredClone(value)),
    },
  } as unknown as PluginContext;
  usagePlugin.activate?.(context);
  const report = (query = new URLSearchParams()) =>
    routes.get('GET /report')!({ body: null, query }) as Record<string, any>;
  return { calls, records, routes, thread, report };
}

describe('Usage plugin', () => {
  it('uses Canonical main usage and auxiliary telemetry once each', () => {
    const env = harness();
    env.records.set(env.thread.id, [
      {
        id: 'model-1:assistant',
        threadId: env.thread.id,
        seq: 3,
        kind: 'assistant',
        createdAt: '2026-06-01T00:00:00.000Z',
        payload: {
          content: 'done',
          toolCalls: [],
          batchId: null,
          projectionThrough: 2,
          model: 'main-x',
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      } as CanonicalRecord,
    ]);
    env.calls.push({
      id: 'aux-1',
      pluginId: 'pico.rolling-context',
      idempotencyKey: 'sum-1',
      threadId: env.thread.id,
      projectId: 'project-1',
      purpose: 'rolling-summary',
      provider: 'provider-a',
      model: 'summary-x',
      prompt: {},
      status: 'completed',
      response: {},
      usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 15 },
      attempts: [{ outcome: 'completed' }],
      error: null,
      createdAt: '2026-06-01T00:01:00.000Z',
      updatedAt: '2026-06-01T00:01:02.000Z',
    });
    const result = env.report();
    expect(result.rows).toHaveLength(2);
    expect(result.totals.inputTokens).toBe(150);
    expect(result.totals.outputTokens).toBe(30);
    expect(result.groups.purpose.map((group: { key: string }) => group.key)).toEqual(['main-model', 'rolling-summary']);
    expect(result.rows[0].estimatedCost).toBeNull();
  });

  it('prices only when all observed dimensions have an effective rate', () => {
    const rate: UsageRate = {
      id: 'rate-1',
      provider: 'p',
      model: 'm',
      currency: 'USD',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      inputPerMillion: 1,
      outputPerMillion: 2,
      cachedInputPerMillion: 0.2,
    };
    expect(estimateUsageCost({ inputTokens: 100, outputTokens: 10 }, rate)).toBeCloseTo(0.00012);
    expect(estimateUsageCost({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 20 }, rate)).toBeCloseTo(
      0.000104,
    );
    expect(estimateUsageCost({ inputTokens: 100, outputTokens: 10, cacheWriteTokens: 1 }, rate)).toBeNull();
    expect(estimateUsageCost(null, rate)).toBeNull();
  });

  it('applies filters and preserves attempt/status diagnostics for auxiliary calls', () => {
    const env = harness();
    env.calls.push({
      id: 'aux-failed',
      pluginId: 'pico.permissions',
      idempotencyKey: 'review',
      threadId: env.thread.id,
      projectId: 'project-1',
      purpose: 'permission-review',
      provider: 'provider-b',
      model: 'reviewer',
      prompt: {},
      status: 'failed',
      response: null,
      usage: null,
      attempts: [{ outcome: 'failed' }, { outcome: 'failed' }],
      error: 'request failed',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:01.000Z',
    });
    const result = env.report(new URLSearchParams({ purpose: 'permission-review', from: '2026-05-01' }));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      status: 'failed',
      attempts: [{ outcome: 'failed' }, { outcome: 'failed' }],
    });
    expect(result.counts.failedAuxiliaryCalls).toBe(1);
    expect(result.counts.providerAttempts).toBe(2);
  });
});
