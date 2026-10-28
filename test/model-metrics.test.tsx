import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelInputAttempt } from '../src/contracts/runtime.js';
import { ComposerTps, latestOutputTokensPerSecond, TextSpeedWindow } from '../src/web/model-metrics.js';
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
    expect(markup).toContain('Estimated visible-text tokens');
  });
  it('estimates a rolling text speed and resets after a pause', () => {
    const speed = new TextSpeedWindow();
    expect(speed.add(0, 'abcd')).toBeNull();
    expect(speed.add(1000, 'abcdefgh')).toBe(2);
    expect(speed.add(5000, 'abcd')).toBeNull();
    expect(speed.add(6000, '中文')).toBe(2);
  });
  it('requires 500ms of observations and isolates a new execution', () => {
    const first = new TextSpeedWindow();
    expect(first.add(0, 'abcd')).toBeNull();
    expect(first.add(1, 'abcdefgh')).toBeNull();
    expect(first.add(499, 'abcd')).toBeNull();
    expect(first.add(500, 'abcd')).toBe(8);
    const nextExecution = new TextSpeedWindow();
    expect(nextExecution.add(501, 'abcd')).toBeNull();
    expect(nextExecution.add(502, 'abcdefgh')).toBeNull();
    expect(nextExecution.add(4000, 'abcd')).toBeNull();
    expect(nextExecution.add(4500, 'abcd')).toBe(2);
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
