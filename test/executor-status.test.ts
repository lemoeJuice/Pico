import { describe, expect, it } from 'vitest';
import { executorStatusFromProbe } from '../src/web/executor-status.js';

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
});
