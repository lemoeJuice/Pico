import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelInputAttempt } from '../src/contracts/runtime.js';
import { ComposerTps, latestOutputTokensPerSecond } from '../src/web/model-metrics.js';
import { mergePluginSelectionRefresh } from '../src/web/plugin-model-selection-state.js';

describe('provider throughput', () => {
  it('uses the recorded output token metric from the last physical request', () => {
    const attempts = [
      { providerRequests: [{ outputTokensPerSecond: 12.5, outputTextCharacters: 9999 }] },
    ] as ModelInputAttempt[];
    expect(latestOutputTokensPerSecond(attempts)).toBe(12.5);
    expect(
      latestOutputTokensPerSecond([{ providerRequests: [{ outputTextCharacters: 9999 }] }] as ModelInputAttempt[]),
    ).toBeNull();
    expect(
      latestOutputTokensPerSecond([{ providerRequests: [{ outputTokensPerSecond: 12 }, {}] }] as ModelInputAttempt[]),
    ).toBeNull();
  });
  it('displays unavailable until a provider metric is loaded and explains the elapsed time', () => {
    const markup = renderToStaticMarkup(
      <ComposerTps threadId="a" executionId="b" status="completed" request={async <T,>() => ({}) as T} />,
    );
    expect(markup).toContain('TPS —');
    expect(markup).toContain('including the wait for the first text');
  });
  it('preserves in-flight edits and independent plugin choices when refreshes return', () => {
    const old = { a: 'fixed draft', b: 'old', c: 'saving' };
    const fresh = { a: 'thread', b: 'new', c: 'thread' };
    expect(mergePluginSelectionRefresh(old, fresh, { a: 0, c: 1 }, { a: 1, c: 1 }, new Set(['c']), new Set())).toEqual({
      a: 'fixed draft',
      b: 'new',
      c: 'saving',
    });
    expect(mergePluginSelectionRefresh(old, fresh, {}, {}, new Set(), new Set(['a']))).toEqual({
      a: 'fixed draft',
      b: 'new',
      c: 'thread',
    });
  });
});
