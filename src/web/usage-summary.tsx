import { useEffect, useState } from 'react';

type Coverage = { reported?: unknown; total?: unknown };
type UsageReport = {
  totals?: Record<string, unknown>;
  coverage?: Record<string, Coverage>;
};

type Summary = { input: string; output: string; cached: string; cacheRate: string };

function coverageFor(report: UsageReport, key: string): Coverage | undefined {
  return report.coverage?.[key];
}

function formatCount(report: UsageReport, key: string): string {
  const value = report.totals?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const coverage = coverageFor(report, key);
  const reported = coverage?.reported;
  const total = coverage?.total;
  const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  if (typeof reported === 'number' && typeof total === 'number' && total > 0 && reported === 0) return '—';
  if (typeof reported === 'number' && typeof total === 'number' && reported < total) {
    return `≥${count}`;
  }
  return count;
}

export function formatUsageSummary(report: UsageReport): Summary {
  const input = report.totals?.inputTokens;
  const cached = report.totals?.cachedInputTokens;
  const inputCoverage = coverageFor(report, 'inputTokens');
  const cachedCoverage = coverageFor(report, 'cachedInputTokens');
  const fullyCovered = (coverage: Coverage | undefined) =>
    typeof coverage?.reported === 'number' &&
    typeof coverage.total === 'number' &&
    coverage.reported === coverage.total;
  const cacheRate =
    typeof input === 'number' &&
    typeof cached === 'number' &&
    input > 0 &&
    fullyCovered(inputCoverage) &&
    fullyCovered(cachedCoverage)
      ? `${((cached / input) * 100).toFixed(1)}%`
      : '—';
  return {
    input: formatCount(report, 'inputTokens'),
    output: formatCount(report, 'outputTokens'),
    cached: formatCount(report, 'cachedInputTokens'),
    cacheRate,
  };
}

export type ComposerUsageProps = { threadId: string; revision: unknown; enabled: boolean };

export function ComposerUsage({ threadId, revision, enabled }: ComposerUsageProps) {
  const [result, setResult] = useState<{ threadId: string; summary: Summary } | null>(null);

  useEffect(() => {
    if (!enabled || !threadId) return;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ threadId });
      void fetch(`/api/plugins/pico.usage/report?${query.toString()}`, { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          if (response.status === 401) {
            window.dispatchEvent(new Event('pico:auth-expired'));
            return null;
          }
          if (!response.ok) return null;
          return (await response.json()) as UsageReport;
        })
        .then((report) => {
          if (active && report) setResult({ threadId, summary: formatUsageSummary(report) });
        })
        .catch(() => {
          // Usage is optional composer context; request failures must not affect chat.
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [threadId, revision, enabled]);

  if (!enabled || result?.threadId !== threadId) return null;
  const summary = result.summary;
  return (
    <div className="composer-usage" aria-label="Thread token usage">
      <span>In {summary.input}</span>
      <span>Out {summary.output}</span>
      <span>Cache {summary.cached}</span>
      <span>Hit {summary.cacheRate}</span>
    </div>
  );
}
