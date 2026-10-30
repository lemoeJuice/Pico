import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelInputAttempt } from '../src/contracts/runtime.js';
import { ComposerTps, latestGenerationTokensPerSecond } from '../src/web/model-metrics.js';
import { mergePluginSelectionRefresh } from '../src/web/plugin-model-selection-state.js';

describe('composer generation throughput', () => {
  it('uses provider output tokens divided by time after first visible text', () => {
    const attempts = [
      {
        providerRequests: [
          {
            outcome: 'completed',
            durationMs: 2000,
            firstTextMs: 500,
            usage: { outputTokens: 12 },
          },
        ],
      },
    ] as ModelInputAttempt[];
    expect(latestGenerationTokensPerSecond(attempts)).toBe(8);
  });
  it('omits the value while running and explains the measurement', () => {
    const markup = renderToStaticMarkup(
      <ComposerTps threadId="a" executionId="b" status="running" request={async <T,>() => ({}) as T} />,
    );
    expect(markup).toContain('TPS —');
    expect(markup).toContain('Provider-reported output tokens');
  });
  it('requires a completed physical request with exact usage and valid post-first-text duration', () => {
    const request = {
      outcome: 'completed',
      durationMs: 2000,
      firstTextMs: 500,
      usage: { outputTokens: 12 },
    };
    const forRequest = (value: object) =>
      latestGenerationTokensPerSecond([{ providerRequests: [value] }] as ModelInputAttempt[]);
    expect(forRequest({ ...request, outcome: 'running' })).toBeNull();
    expect(forRequest({ ...request, outcome: 'retrying' })).toBeNull();
    expect(forRequest({ ...request, firstTextMs: undefined })).toBeNull();
    expect(forRequest({ ...request, firstTextMs: -1 })).toBeNull();
    expect(forRequest({ ...request, durationMs: 500 })).toBeNull();
    expect(forRequest({ ...request, usage: null })).toBeNull();
    expect(forRequest({ ...request, usage: { outputTokens: undefined } })).toBeNull();
    expect(forRequest({ ...request, usage: { outputTokens: -1 } })).toBeNull();
    expect(
      latestGenerationTokensPerSecond([
        {
          providerRequests: [
            { ...request, outcome: 'completed' },
            { ...request, outcome: 'failed' },
          ],
        },
      ] as ModelInputAttempt[]),
    ).toBeNull();
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
