import { describe, expect, it } from 'vitest';
import { executorStatusFromProbe, startVisibleStatusPolling } from '../src/web/executor-status.js';

describe('Executor status probing', () => {
  it('keeps an explicit disconnected response distinct from a failed status request', () => {
    expect(
      executorStatusFromProbe({ status: 'fulfilled', value: { connected: false, error: 'socket closed' } }),
    ).toEqual({ connected: false, error: 'socket closed' });
    expect(executorStatusFromProbe({ status: 'rejected', reason: new Error('Runtime unavailable') })).toEqual({
      connected: null,
      error: 'Could not check Executor status: Runtime unavailable',
    });
  });

  it('clears the probe error after an explicit connected response', () => {
    expect(executorStatusFromProbe({ status: 'fulfilled', value: { connected: true } })).toEqual({
      connected: true,
      error: null,
    });
  });

  it('maps an inactive Executor to an unknown status without presenting a failure', () => {
    expect(executorStatusFromProbe({ status: 'fulfilled', value: { connected: false, inactive: true } })).toEqual({
      connected: null,
      error: null,
    });
  });

  it('probes immediately only while visible and skips hidden interval ticks', () => {
    let visibility: DocumentVisibilityState = 'hidden';
    const callbacks: { visibility: EventListenerOrEventListenerObject | null; interval: (() => void) | null } = {
      visibility: null,
      interval: null,
    };
    let clearedTimer: number | null = null;
    let refreshes = 0;
    const documentSource = {
      get visibilityState() { return visibility; },
      addEventListener: (_type: 'visibilitychange', listener: EventListenerOrEventListenerObject) => {
        callbacks.visibility = listener;
      },
      removeEventListener: (_type: 'visibilitychange', listener: EventListenerOrEventListenerObject) => {
        if (callbacks.visibility === listener) callbacks.visibility = null;
      },
    } as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
    const windowSource = {
      setInterval: (callback: TimerHandler, delay?: number) => {
        expect(delay).toBe(15_000);
        callbacks.interval = callback as () => void;
        return 7;
      },
      clearInterval: (timer: number) => { clearedTimer = timer; },
    } as Pick<Window, 'setInterval' | 'clearInterval'>;

    const stop = startVisibleStatusPolling(() => { refreshes += 1; }, documentSource, windowSource);
    expect(refreshes).toBe(0);
    visibility = 'visible';
    if (typeof callbacks.visibility === 'function') callbacks.visibility(new Event('visibilitychange'));
    expect(refreshes).toBe(1);
    visibility = 'hidden';
    callbacks.interval?.();
    expect(refreshes).toBe(1);
    visibility = 'visible';
    callbacks.interval?.();
    expect(refreshes).toBe(2);

    stop();
    expect(clearedTimer).toBe(7);
    expect(callbacks.visibility).toBeNull();
    callbacks.interval?.();
    expect(refreshes).toBe(2);
  });
});
