import type { AssistantPayload, Thread, TokenUsage } from '../core/types.js';
import type { PluginModelCallRecord } from '../core/store.js';
import type { PicoPlugin, PluginContext, PluginHttpRequest } from './host.js';

export interface UsageRate {
  id: string;
  provider: string;
  model: string;
  currency: string;
  effectiveAt: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface UsageRow {
  id: string;
  kind: 'main' | 'auxiliary';
  status: string;
  threadId: string | null;
  projectId: string | null;
  provider: string;
  model: string;
  purpose: string;
  createdAt: string;
  usage: TokenUsage | null;
  attempts: Array<Record<string, unknown>>;
  estimatedCost: number | null;
  currency: string | null;
  rateId: string | null;
  canonicalSeq?: number;
}

interface UsageFilter {
  threadId?: string;
  projectId?: string;
  provider?: string;
  model?: string;
  purpose?: string;
  from?: string;
  to?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function token(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageValue(value: unknown): TokenUsage | null {
  const input = object(value);
  const usage: TokenUsage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ] as const) {
    const count = token(input[key]);
    if (count !== undefined) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

function validRate(value: unknown): value is UsageRate {
  const rate = object(value);
  return (
    typeof rate.id === 'string' &&
    typeof rate.provider === 'string' &&
    typeof rate.model === 'string' &&
    typeof rate.currency === 'string' &&
    typeof rate.effectiveAt === 'string' &&
    typeof rate.inputPerMillion === 'number' &&
    Number.isFinite(rate.inputPerMillion) &&
    rate.inputPerMillion >= 0 &&
    typeof rate.outputPerMillion === 'number' &&
    Number.isFinite(rate.outputPerMillion) &&
    rate.outputPerMillion >= 0 &&
    (rate.cachedInputPerMillion === undefined ||
      (typeof rate.cachedInputPerMillion === 'number' && rate.cachedInputPerMillion >= 0)) &&
    (rate.cacheWritePerMillion === undefined ||
      (typeof rate.cacheWritePerMillion === 'number' && rate.cacheWritePerMillion >= 0))
  );
}

function effectiveRate(rates: UsageRate[], provider: string, model: string, createdAt: string): UsageRate | null {
  return (
    rates
      .filter((rate) => rate.provider === provider && rate.model === model && rate.effectiveAt <= createdAt)
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0] ?? null
  );
}

/** Returns null unless every observed token dimension can be priced from the selected rate. */
export function estimateUsageCost(usage: TokenUsage | null, rate: UsageRate | null): number | null {
  if (!usage || !rate || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  if (cached > usage.inputTokens) return null;
  if (cached > 0 && rate.cachedInputPerMillion === undefined) return null;
  if ((usage.cacheWriteTokens ?? 0) > 0 && rate.cacheWritePerMillion === undefined) return null;
  const regularInput = usage.inputTokens - cached;
  const cacheInputCost = cached * (rate.cachedInputPerMillion ?? rate.inputPerMillion);
  const cacheWriteCost = (usage.cacheWriteTokens ?? 0) * (rate.cacheWritePerMillion ?? 0);
  return (
    (regularInput * rate.inputPerMillion +
      cacheInputCost +
      usage.outputTokens * rate.outputPerMillion +
      cacheWriteCost) /
    1_000_000
  );
}

function canonicalUsageRows(context: PluginContext, threads: Thread[], rates: UsageRate[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const thread of threads) {
    for (const record of context.canonical.list(thread.id)) {
      if (record.kind !== 'assistant') continue;
      const assistant = object(record.payload) as unknown as AssistantPayload;
      const model = typeof assistant.model === 'string' && assistant.model ? assistant.model : 'unknown';
      const usage = usageValue(assistant.usage);
      const rate = effectiveRate(rates, 'unknown', model, record.createdAt);
      rows.push({
        id: record.id,
        kind: 'main',
        status: 'completed',
        threadId: thread.id,
        projectId: thread.projectId,
        provider: 'unknown',
        model,
        purpose: 'main-model',
        createdAt: record.createdAt,
        usage,
        attempts: [],
        estimatedCost: estimateUsageCost(usage, rate),
        currency: rate?.currency ?? null,
        rateId: rate?.id ?? null,
        canonicalSeq: record.seq,
      });
    }
  }
  return rows;
}

function auxiliaryUsageRows(calls: PluginModelCallRecord[], rates: UsageRate[]): UsageRow[] {
  return calls.map((call) => {
    const rate = effectiveRate(rates, call.provider, call.model, call.createdAt);
    return {
      id: call.id,
      kind: 'auxiliary',
      status: call.status,
      threadId: call.threadId,
      projectId: call.projectId,
      provider: call.provider,
      model: call.model,
      purpose: call.purpose,
      createdAt: call.createdAt,
      usage: usageValue(call.usage),
      attempts: call.attempts,
      estimatedCost: estimateUsageCost(usageValue(call.usage), rate),
      currency: rate?.currency ?? null,
      rateId: rate?.id ?? null,
    };
  });
}

function matches(row: UsageRow, filter: UsageFilter): boolean {
  return (
    (!filter.threadId || row.threadId === filter.threadId) &&
    (!filter.projectId || row.projectId === filter.projectId) &&
    (!filter.provider || row.provider === filter.provider) &&
    (!filter.model || row.model === filter.model) &&
    (!filter.purpose || row.purpose === filter.purpose) &&
    (!filter.from || row.createdAt >= filter.from) &&
    (!filter.to || row.createdAt <= filter.to)
  );
}

function sum(rows: UsageRow[]): Record<string, number | null> {
  const totals: Record<string, number | null> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCost: 0,
  };
  for (const row of rows) {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cachedInputTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ] as const) {
      const value = row.usage?.[key];
      if (value === undefined) totals[key] = null;
      else if (totals[key] !== null) totals[key] = (totals[key] ?? 0) + value;
    }
    if (row.estimatedCost === null) totals.estimatedCost = null;
    else if (totals.estimatedCost !== null) totals.estimatedCost = (totals.estimatedCost ?? 0) + row.estimatedCost;
  }
  return totals;
}

function groupBy(
  rows: UsageRow[],
  key: (row: UsageRow) => string,
): Array<{ key: string; count: number; totals: Record<string, number | null> }> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups.entries()].map(([name, values]) => ({ key: name, count: values.length, totals: sum(values) }));
}

function parseFilter(query: URLSearchParams): UsageFilter {
  const filter: UsageFilter = {};
  for (const key of ['threadId', 'projectId', 'provider', 'model', 'purpose', 'from', 'to'] as const) {
    const value = query.get(key)?.trim();
    if (value) filter[key] = value;
  }
  return filter;
}

function buildReport(context: PluginContext, state: PluginContext['state'], filter: UsageFilter) {
  const rates = state.get<unknown>('rates', []);
  const validRates = Array.isArray(rates) ? rates.filter(validRate) : [];
  const threads = context.threads
    .list(filter.projectId)
    .filter((thread) => !filter.threadId || thread.id === filter.threadId);
  const main = canonicalUsageRows(context, threads, validRates);
  const auxiliary = auxiliaryUsageRows(
    context.models.history({
      ...(filter.threadId ? { threadId: filter.threadId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
    }),
    validRates,
  );
  const rows = [...main, ...auxiliary]
    .filter((row) => matches(row, filter))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byTime = groupBy(rows, (row) => row.createdAt.slice(0, 10));
  return {
    rows,
    totals: sum(rows),
    counts: {
      completedMainCalls: rows.filter((row) => row.kind === 'main' && row.status === 'completed').length,
      auxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary').length,
      failedAuxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary' && row.status === 'failed').length,
      interruptedAuxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary' && row.status === 'interrupted').length,
      providerAttempts: rows.reduce((count, row) => count + row.attempts.length, 0),
    },
    groups: {
      thread: groupBy(rows, (row) => row.threadId ?? 'unknown'),
      project: groupBy(rows, (row) => row.projectId ?? 'unknown'),
      provider: groupBy(rows, (row) => row.provider),
      model: groupBy(rows, (row) => row.model),
      purpose: groupBy(rows, (row) => row.purpose),
      day: byTime,
    },
    rates: validRates,
    limitations: [
      'Main model calls use committed Canonical assistant usage. Failed main attempts and retries are not currently exposed by the plugin service.',
      'Main-call provider identity is unavailable in Canonical assistant records and is shown as unknown.',
      'Cost is unknown until a matching, effective-dated rate is configured and all reported token dimensions can be priced.',
    ],
  };
}

function requestObject(request: PluginHttpRequest): Record<string, unknown> {
  return object(request.body);
}

export const usagePlugin: PicoPlugin = {
  id: 'pico.usage',
  name: 'Usage',
  version: '0.1.0',
  activate(context) {
    const { state, ui, http } = context;
    const readRates = (): UsageRate[] => {
      const value = state.get<unknown>('rates', []);
      return Array.isArray(value) ? value.filter(validRate) : [];
    };
    http.register('GET', '/report', ({ query }) => buildReport(context, state, parseFilter(query)));
    http.register('PUT', '/rates', ({ body }) => {
      const data = requestObject({ body, query: new URLSearchParams(), origin: null });
      const candidate = data.rate;
      if (!validRate(candidate))
        throw new Error(
          'A rate must include provider, model, currency, effectiveAt, and non-negative input/output rates.',
        );
      if (Number.isNaN(Date.parse(candidate.effectiveAt))) throw new Error('effectiveAt must be a valid date.');
      const next = [...readRates().filter((rate) => rate.id !== candidate.id), candidate].sort((a, b) =>
        a.effectiveAt.localeCompare(b.effectiveAt),
      );
      state.set('rates', next);
      return { rates: next };
    });
    http.register('DELETE', '/rates', ({ body }) => {
      const data = requestObject({ body, query: new URLSearchParams(), origin: null });
      const id = typeof data.id === 'string' ? data.id : '';
      const next = readRates().filter((rate) => rate.id !== id);
      state.set('rates', next);
      return { rates: next };
    });
    ui.registerPage({
      id: 'usage',
      label: 'Usage',
      description: 'Token, cache, attempt, and estimated cost statistics.',
      entry: 'webui',
    });
  },
};
