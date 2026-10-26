import { describe, expect, it } from 'vitest';
import type { PluginModelCallRecord } from '../../../core/store.js';
import type { CanonicalRecord, Thread } from '../../../core/types.js';
import type { PluginContext } from '../../../plugins/host.js';
import { estimateUsageCost, usagePlugin, type UsageRate } from '../../../plugins/usage.js';

function harness() {
  const values = new Map<string, unknown>();
  const calls: PluginModelCallRecord[] = [];
  const records = new Map<string, CanonicalRecord[]>();
  const thread = { id: 'thread-1', projectId: 'project-1', title: 'Current thread' } as Thread;
  const routes = new Map<string, (request: { body: unknown; query: URLSearchParams }) => unknown>();
  let modelListener: (() => void) | undefined;
  let invalidations = 0;
  const contributions: Array<{ slot: string; id: string }> = [];
  const context = {
    projects: { list: () => [{ id: 'project-1', name: 'Example project' }] },
    threads: { list: () => [thread] },
    canonical: { list: (threadId: string) => records.get(threadId) ?? [] },
    models: {
      history: (filter: { threadId?: string; projectId?: string } = {}) =>
        calls.filter(
          (call) =>
            (!filter.threadId || call.threadId === filter.threadId) &&
            (!filter.projectId || call.projectId === filter.projectId),
        ),
      subscribe: (listener: () => void) => {
        modelListener = listener;
        return () => {
          modelListener = undefined;
        };
      },
    },
    http: {
      register: (
        method: string,
        path: string,
        handler: (request: { body: unknown; query: URLSearchParams }) => unknown,
      ) => routes.set(`${method} ${path}`, handler),
    },
    ui: {
      registerPage: () => undefined,
      contribute: (item: { slot: string; id: string }) => contributions.push(item),
      invalidate: () => {
        invalidations += 1;
      },
    },
    state: {
      get: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
      set: <T>(key: string, value: T) => values.set(key, structuredClone(value)),
    },
  } as unknown as PluginContext;
  usagePlugin.activate?.(context);
  const report = (query = new URLSearchParams()) =>
    routes.get('GET /report')!({ body: null, query }) as Record<string, any>;
  return {
    calls,
    records,
    routes,
    thread,
    report,
    contributions,
    modelChanged: () => modelListener?.(),
    get invalidations() {
      return invalidations;
    },
  };
}

describe('Usage plugin', () => {
  it('owns the composer summary contribution and invalidates it on model telemetry changes', () => {
    const env = harness();
    expect(env.contributions).toContainEqual(expect.objectContaining({ slot: 'composer.status', id: 'usage-summary' }));
    env.modelChanged();
    expect(env.invalidations).toBe(1);
  });

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

  it('sums only reported token dimensions and exposes per-dimension coverage', () => {
    const env = harness();
    env.records.set(env.thread.id, [
      {
        id: 'model-known:assistant',
        threadId: env.thread.id,
        seq: 1,
        kind: 'assistant',
        createdAt: '2026-06-01T00:00:00.000Z',
        payload: {
          content: 'done',
          toolCalls: [],
          batchId: null,
          projectionThrough: 0,
          model: 'main-x',
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      } as CanonicalRecord,
    ]);
    const auxiliary: PluginModelCallRecord = {
      id: 'aux-known',
      pluginId: 'pico.todo',
      idempotencyKey: 'known',
      threadId: env.thread.id,
      projectId: env.thread.projectId,
      purpose: 'todo-review',
      provider: 'provider-a',
      model: 'reviewer-x',
      prompt: {},
      status: 'completed',
      response: {},
      usage: { inputTokens: 30 },
      attempts: [],
      error: null,
      createdAt: '2026-06-01T00:01:00.000Z',
      updatedAt: '2026-06-01T00:01:00.000Z',
    };
    env.calls.push(
      auxiliary,
      { ...auxiliary, id: 'aux-missing', idempotencyKey: 'missing', usage: null },
      {
        ...auxiliary,
        id: 'aux-priced',
        idempotencyKey: 'priced',
        usage: { inputTokens: 50, outputTokens: 10 },
      },
    );
    env.routes.get('PUT /rates')!({
      body: {
        rate: {
          id: 'rate-reviewer',
          provider: 'provider-a',
          model: 'reviewer-x',
          currency: 'USD',
          effectiveAt: '2026-01-01T00:00:00.000Z',
          inputPerMillion: 1,
          outputPerMillion: 2,
        },
      },
      query: new URLSearchParams(),
    });

    const result = env.report();
    expect(result.totals).toMatchObject({ inputTokens: 180, outputTokens: 30, estimatedCost: null });
    expect(result.coverage).toMatchObject({
      usage: { reported: 3, total: 4 },
      inputTokens: { reported: 3, total: 4 },
      outputTokens: { reported: 2, total: 4 },
    });
    expect(result.groups.thread[0]).toMatchObject({
      totals: { inputTokens: 180, outputTokens: 30, estimatedCost: null },
      coverage: { inputTokens: { reported: 3, total: 4 } },
    });
  });

  it('returns project names and Thread titles for Usage filter options', () => {
    const env = harness();
    const catalog = env.routes.get('GET /catalog')!({ body: null, query: new URLSearchParams() });
    expect(catalog).toEqual({
      projects: [{ id: 'project-1', name: 'Example project' }],
      threads: [{ id: 'thread-1', projectId: 'project-1', title: 'Current thread' }],
    });
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
    expect(result.rows[0]?.attempts).toHaveLength(2);
  });
});
