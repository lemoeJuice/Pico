import { describe, expect, it } from 'vitest';
import { formatUsageSummary } from '../src/web/usage-summary.js';

describe('formatUsageSummary', () => {
  it('shows full totals and computes cache rate from matching coverage', () => {
    expect(
      formatUsageSummary({
        totals: { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 250 },
        coverage: {
          inputTokens: { reported: 4, total: 4 },
          outputTokens: { reported: 4, total: 4 },
          cachedInputTokens: { reported: 4, total: 4 },
        },
      }),
    ).toEqual({ input: '1K', output: '240', cached: '250', cacheRate: '25.0%' });
  });

  it('marks partial values and refuses a cache rate unless both dimensions cover every row', () => {
    expect(
      formatUsageSummary({
        totals: { inputTokens: 100, outputTokens: 12, cachedInputTokens: 20 },
        coverage: {
          inputTokens: { reported: 2, total: 3 },
          outputTokens: { reported: 1, total: 3 },
          // The counts match input, but these could be a different subset of calls.
          cachedInputTokens: { reported: 2, total: 3 },
        },
      }),
    ).toEqual({ input: '≥100', output: '≥12', cached: '≥20', cacheRate: '—' });
  });

  it('treats null totals and absent coverage as unknown', () => {
    expect(formatUsageSummary({ totals: { inputTokens: null, outputTokens: 0, cachedInputTokens: null } })).toEqual({
      input: '—',
      output: '0',
      cached: '—',
      cacheRate: '—',
    });
  });
});

it('compacts token counts with K and M and omits coverage counts', () => {
  expect(
    formatUsageSummary({
      totals: { inputTokens: 143224, outputTokens: 5592, cachedInputTokens: 1234567 },
      coverage: { inputTokens: { reported: 26, total: 30 } },
    }),
  ).toEqual({ input: '≥143.2K', output: '5.6K', cached: '1.2M', cacheRate: '—' });
});
