import type { AssistantPayload, Thread, TokenUsage } from '../core/types.js';
import type { PluginModelCallRecord } from '../contracts/store.js';
import type { PicoPlugin, PluginContext, PluginHttpRequest } from './host.js';

export interface UsageRate {
  id: string;
  provider: string;
  model: string;
  currency: string;
  /** Legacy field accepted when reading older saved rates; current rates ignore it. */
  effectiveAt?: string;
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

function currentRate(value: UsageRate): UsageRate {
  return {
    id: value.id,
    provider: value.provider,
    model: value.model,
    currency: value.currency,
    inputPerMillion: value.inputPerMillion,
    outputPerMillion: value.outputPerMillion,
    ...(value.cachedInputPerMillion === undefined ? {} : { cachedInputPerMillion: value.cachedInputPerMillion }),
    ...(value.cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion: value.cacheWritePerMillion }),
  };
}

function normalizeRates(value: unknown): UsageRate[] {
  const latestByPair = new Map<string, { rate: UsageRate; effectiveAt: string; index: number }>();
  for (const [index, candidate] of (Array.isArray(value) ? value : []).entries()) {
    if (!validRate(candidate)) continue;
    const rate = currentRate(candidate);
    const effectiveAt = typeof candidate.effectiveAt === 'string' ? candidate.effectiveAt : '';
    const key = JSON.stringify([rate.provider, rate.model]);
    const previous = latestByPair.get(key);
    if (!previous || effectiveAt.localeCompare(previous.effectiveAt) >= 0)
      latestByPair.set(key, { rate, effectiveAt, index });
  }
  return [...latestByPair.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ rate }) => rate);
}

function rateFor(rates: UsageRate[], provider: string, model: string): UsageRate | null {
  return rates.find((rate) => rate.provider === provider && rate.model === model) ?? null;
}

/** Returns null unless every observed token dimension can be priced from the selected rate. */
export function estimateUsageCost(usage: TokenUsage | null, rate: UsageRate | null): number | null {
  if (!usage || !rate || usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  if (cached + cacheWrite > usage.inputTokens) return null;
  if (cached > 0 && rate.cachedInputPerMillion === undefined) return null;
  if (cacheWrite > 0 && rate.cacheWritePerMillion === undefined) return null;
  // Cache read and write counts are subsets of inputTokens, so remove both before pricing ordinary input.
  const regularInput = usage.inputTokens - cached - cacheWrite;
  const cacheInputCost = cached * (rate.cachedInputPerMillion ?? rate.inputPerMillion);
  const cacheWriteCost = cacheWrite * (rate.cacheWritePerMillion ?? 0);
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
      const rate = rateFor(rates, 'unknown', model);
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
    const rate = rateFor(rates, call.provider, call.model);
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

const tokenDimensions = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

type UsageDimension = (typeof tokenDimensions)[number];
type UsageCoverage = Record<UsageDimension | 'usage', { reported: number; total: number }>;

function sum(rows: UsageRow[]): { totals: Record<string, number | null>; coverage: UsageCoverage } {
  const totals: Record<string, number | null> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCost: 0,
  };
  const reported: Record<UsageDimension, number> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  let reportedUsageCalls = 0;
  for (const row of rows) {
    if (row.usage) reportedUsageCalls += 1;
    for (const key of tokenDimensions) {
      const value = row.usage?.[key];
      if (value !== undefined) {
        reported[key] += 1;
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
    if (row.estimatedCost === null) totals.estimatedCost = null;
    else if (totals.estimatedCost !== null) totals.estimatedCost = (totals.estimatedCost ?? 0) + row.estimatedCost;
  }
  const coverage = Object.fromEntries(
    tokenDimensions.map((key) => [key, { reported: reported[key], total: rows.length }]),
  ) as UsageCoverage;
  coverage.usage = { reported: reportedUsageCalls, total: rows.length };
  for (const key of tokenDimensions) {
    if (reported[key] === 0 && rows.length > 0) totals[key] = null;
  }
  return { totals, coverage };
}

function groupBy(
  rows: UsageRow[],
  key: (row: UsageRow) => string,
): Array<{ key: string; count: number; totals: Record<string, number | null>; coverage: UsageCoverage }> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups.entries()].map(([name, values]) => ({ key: name, count: values.length, ...sum(values) }));
}

function rateCatalog(context: PluginContext, rates: UsageRate[]) {
  const threads = context.threads.list();
  const rows = [
    ...canonicalUsageRows(context, threads, rates),
    ...auxiliaryUsageRows(context.models.history(), rates),
  ];
  const providerModels = new Map<string, { provider: string; model: string }>();
  for (const { provider, model } of [...rows, ...rates]) {
    providerModels.set(JSON.stringify([provider, model]), { provider, model });
  }
  return {
    providerModels: [...providerModels.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
    purposes: [...new Set(rows.map((row) => row.purpose.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  };
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
  const validRates = normalizeRates(rates);
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
  const aggregate = sum(rows);
  const byTime = groupBy(rows, (row) => row.createdAt.slice(0, 10));
  return {
    rows,
    totals: aggregate.totals,
    coverage: aggregate.coverage,
    counts: {
      completedMainCalls: rows.filter((row) => row.kind === 'main' && row.status === 'completed').length,
      auxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary').length,
      failedAuxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary' && row.status === 'failed').length,
      interruptedAuxiliaryCalls: rows.filter((row) => row.kind === 'auxiliary' && row.status === 'interrupted').length,
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
      'Cost estimates use current provider/model rates for all calls, including historical calls; cost is unknown when a required price is missing.',
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
      const rates = normalizeRates(value);
      if (JSON.stringify(value) !== JSON.stringify(rates)) state.set('rates', rates);
      return rates;
    };
    http.register('GET', '/catalog', () => ({
      projects: context.projects.list().map(({ id, name }) => ({ id, name })),
      threads: context.threads.list().map(({ id, projectId, title }) => ({ id, projectId, title })),
    }));
    http.register('GET', '/options', () => rateCatalog(context, readRates()));
    http.register('GET', '/report', ({ query }) => buildReport(context, state, parseFilter(query)));
    http.register('PUT', '/rates', ({ body }) => {
      const data = requestObject({ body, query: new URLSearchParams(), origin: null });
      if (!validRate(data.rate))
        throw new Error('A rate must include provider, model, currency, and non-negative input/output rates.');
      const candidate = currentRate(data.rate);
      const next = [
        ...readRates().filter(
          (rate) =>
            rate.id !== candidate.id && (rate.provider !== candidate.provider || rate.model !== candidate.model),
        ),
        candidate,
      ];
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
