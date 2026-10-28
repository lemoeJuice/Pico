import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const windowContext: {
  PicoUsageSummary?: { formatUsageSummary: (report: unknown) => Record<string, string> };
} = {};
runInNewContext(
  readFileSync(new URL('../../../../plugins/pico.usage/webui/usage-summary.js', import.meta.url), 'utf8'),
  {
    window: windowContext,
  },
);
const formatUsageSummary = windowContext.PicoUsageSummary!.formatUsageSummary;

describe('formatUsageSummary', () => {
  it('shows full totals and computes cache rate from calls with reported values', () => {
    expect(
      formatUsageSummary({
        totals: { inputTokens: 1000, outputTokens: 240, cachedInputTokens: 250 },
        coverage: {
          inputTokens: { reported: 4, total: 4 },
          outputTokens: { reported: 4, total: 4 },
          cachedInputTokens: { reported: 4, total: 4 },
        },
        rows: [
          { usage: { inputTokens: 200, cachedInputTokens: 50 } },
          { usage: { inputTokens: 300, cachedInputTokens: 75 } },
          { usage: { inputTokens: 250, cachedInputTokens: 50 } },
          { usage: { inputTokens: 250, cachedInputTokens: 75 } },
        ],
      }),
    ).toEqual({ input: '750', output: '240', cached: '250', cacheRate: '25.0%', cacheCoverage: '4/4' });
  });

  it('reports the cache rate for known calls and shows its coverage', () => {
    expect(
      formatUsageSummary({
        totals: { inputTokens: 100, outputTokens: 12, cachedInputTokens: 20 },
        coverage: {
          inputTokens: { reported: 2, total: 3 },
          outputTokens: { reported: 1, total: 3 },
          // The counts match input, but these could be a different subset of calls.
          cachedInputTokens: { reported: 2, total: 3 },
        },
        rows: [
          { usage: { inputTokens: 40, cachedInputTokens: 10 } },
          { usage: { inputTokens: 40, cachedInputTokens: 10 } },
          { usage: { inputTokens: 20 } },
        ],
      }),
    ).toEqual({ input: '≥60', output: '≥12', cached: '≥20', cacheRate: '25.0%', cacheCoverage: '2/3' });
  });

  it('treats null totals and absent coverage as unknown', () => {
    expect(formatUsageSummary({ totals: { inputTokens: null, outputTokens: 0, cachedInputTokens: null } })).toEqual({
      input: '—',
      output: '0',
      cached: '—',
      cacheRate: '—',
      cacheCoverage: '0/0',
    });
  });
});

it('compacts token counts with K and M and shows zero cache coverage when there are no calls', () => {
  expect(
    formatUsageSummary({
      totals: { inputTokens: 143224, outputTokens: 5592, cachedInputTokens: 1234567 },
      coverage: { inputTokens: { reported: 26, total: 30 } },
    }),
  ).toEqual({ input: '—', output: '5.6K', cached: '1.2M', cacheRate: '—', cacheCoverage: '0/0' });
});

it('only counts valid input and cache pairs and preserves a known zero', () => {
  expect(
    formatUsageSummary({
      rows: [
        { usage: { inputTokens: 10, cachedInputTokens: 10 } },
        { usage: { inputTokens: 5, cachedInputTokens: 6 } },
        { usage: { inputTokens: 20 } },
        { usage: { inputTokens: -1, cachedInputTokens: 0 } },
        { usage: { inputTokens: 5, cachedInputTokens: NaN } },
      ],
    }).input,
  ).toBe('≥0');
  expect(formatUsageSummary({ rows: [{ usage: { inputTokens: 5, cachedInputTokens: 6 } }] }).input).toBe('—');
  expect(formatUsageSummary({ rows: [{ usage: { inputTokens: 10, cachedInputTokens: 10 } }] }).input).toBe('0');
});
