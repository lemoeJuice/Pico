(() => {
  'use strict';

  function coverageFor(report, key) {
    return report.coverage?.[key];
  }

  function formatCount(report, key) {
    const value = report.totals?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const coverage = coverageFor(report, key);
    const reported = coverage?.reported;
    const total = coverage?.total;
    const count = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    if (typeof reported === 'number' && typeof total === 'number' && total > 0 && reported === 0) return '—';
    if (typeof reported === 'number' && typeof total === 'number' && reported < total) return `≥${count}`;
    return count;
  }

  function formatUsageSummary(report) {
    const rows = report.rows ?? [];
    const cacheRows = rows.flatMap((row) => {
      const inputTokens = row.usage?.inputTokens;
      const cachedInputTokens = row.usage?.cachedInputTokens;
      return typeof inputTokens === 'number' &&
        Number.isFinite(inputTokens) &&
        inputTokens >= 0 &&
        typeof cachedInputTokens === 'number' &&
        Number.isFinite(cachedInputTokens) &&
        cachedInputTokens >= 0
        ? [{ inputTokens, cachedInputTokens }]
        : [];
    });
    const input = cacheRows.reduce((total, row) => total + row.inputTokens, 0);
    const cached = cacheRows.reduce((total, row) => total + row.cachedInputTokens, 0);
    return {
      input: formatCount(report, 'inputTokens'),
      output: formatCount(report, 'outputTokens'),
      cached: formatCount(report, 'cachedInputTokens'),
      cacheRate: input > 0 ? `${((cached / input) * 100).toFixed(1)}%` : '—',
      cacheCoverage: `${cacheRows.length}/${rows.length}`,
    };
  }

  window.PicoUsageSummary = Object.freeze({ formatUsageSummary });
})();
