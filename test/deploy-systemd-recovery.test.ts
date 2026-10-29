import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { recoverStoppedSystemdUnit as recoverStoppedSystemdUnitUntyped } from '../scripts/deploy/systemd-recovery.mjs';

type State = { listenerPids: readonly number[]; oldProcessAlive: boolean; activeState: string };
type Ops = {
  readState: () => Promise<State>;
  assertStopped: () => Promise<void>;
  restore: () => Promise<void>;
  start: () => Promise<void>;
  verify: () => Promise<void>;
};
const recoverStoppedSystemdUnit = recoverStoppedSystemdUnitUntyped as unknown as (ops: Ops) => Promise<void>;

function makeOps(state: Partial<State> = {}): Ops & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    readState: vi.fn(async () => {
      order.push('readState');
      return { listenerPids: [], oldProcessAlive: false, activeState: 'inactive', ...state };
    }),
    assertStopped: vi.fn(async () => {
      order.push('assertStopped');
    }),
    restore: vi.fn(async () => {
      order.push('restore');
    }),
    start: vi.fn(async () => {
      order.push('start');
    }),
    verify: vi.fn(async () => {
      order.push('verify');
    }),
  };
}

describe('recoverStoppedSystemdUnit', () => {
  it.each([
    ['listener', { listenerPids: [4321] }],
    ['old process', { oldProcessAlive: true }],
    ['deactivating unit', { activeState: 'deactivating' }],
  ] as const)('refuses recovery when the %s is still active', async (_reason, state) => {
    const ops = makeOps(state);

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow(
      /refusing to restore Runtime artifacts|finished stopping/,
    );
    expect(ops.order).toEqual(['readState']);
    expect(ops.restore).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
  });

  it('fails closed when the stopped state cannot be read completely', async () => {
    const ops = makeOps();
    ops.readState = vi.fn(async () => ({ listenerPids: [], oldProcessAlive: false }) as unknown as State);

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow(/Cannot verify/);
    expect(ops.order).toEqual([]);
    expect(ops.restore).not.toHaveBeenCalled();
  });

  it('does not restore when the caller reference check fails', async () => {
    const ops = makeOps();
    ops.assertStopped = vi.fn(async () => {
      ops.order.push('assertStopped');
      throw new Error('reference lost');
    });

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow('reference lost');
    expect(ops.order).toEqual(['readState', 'assertStopped']);
    expect(ops.restore).not.toHaveBeenCalled();
    expect(ops.start).not.toHaveBeenCalled();
  });

  it('does not start when restoring artifacts fails', async () => {
    const ops = makeOps();
    ops.restore = vi.fn(async () => {
      ops.order.push('restore');
      throw new Error('restore failed');
    });

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow('restore failed');
    expect(ops.order).toEqual(['readState', 'assertStopped', 'restore']);
    expect(ops.start).not.toHaveBeenCalled();
    expect(ops.verify).not.toHaveBeenCalled();
  });

  it('does not verify when starting the unit fails', async () => {
    const ops = makeOps();
    ops.start = vi.fn(async () => {
      ops.order.push('start');
      throw new Error('start failed');
    });

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow('start failed');
    expect(ops.order).toEqual(['readState', 'assertStopped', 'restore', 'start']);
    expect(ops.verify).not.toHaveBeenCalled();
  });

  it('verifies after a successful restore and start', async () => {
    const ops = makeOps();

    await expect(recoverStoppedSystemdUnit(ops)).resolves.toBeUndefined();
    expect(ops.order).toEqual(['readState', 'assertStopped', 'restore', 'start', 'verify']);
  });

  it('propagates verification failure after the unit has started', async () => {
    const ops = makeOps();
    ops.verify = vi.fn(async () => {
      ops.order.push('verify');
      throw new Error('health failed');
    });

    await expect(recoverStoppedSystemdUnit(ops)).rejects.toThrow('health failed');
    expect(ops.order).toEqual(['readState', 'assertStopped', 'restore', 'start', 'verify']);
  });
});
