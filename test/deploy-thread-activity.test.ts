import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Deployment helpers are plain Node ESM modules.
import { getActiveThreadCount as getActiveThreadCountUntyped } from '../scripts/deploy/thread-activity.mjs';

const getActiveThreadCount = getActiveThreadCountUntyped as unknown as (
  threads: Array<{ id: string; state: string }>,
  readThreadSnapshot: (id: string) => Promise<{ executions: Array<{ status: string }> }>,
) => Promise<number>;

describe('deployment Thread activity checks', () => {
  it('treats idle as safe without requesting an execution snapshot', async () => {
    const readSnapshot = vi.fn();
    await expect(getActiveThreadCount([{ id: 'idle', state: 'idle' }], readSnapshot)).resolves.toBe(0);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it.each(['running', 'pausing', 'waiting_permission'])('treats %s as active', async (state) => {
    const readSnapshot = vi.fn();
    await expect(getActiveThreadCount([{ id: 'active', state }], readSnapshot)).resolves.toBe(1);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['model_error', 'pending'],
    ['model_error', 'running'],
    ['paused', 'pending'],
    ['paused', 'running'],
  ])('checks %s snapshots and blocks %s executions', async (state, status) => {
    const readSnapshot = vi.fn(async () => ({ executions: [{ status }] }));
    await expect(getActiveThreadCount([{ id: 'thread-a', state }], readSnapshot)).resolves.toBe(1);
    expect(readSnapshot).toHaveBeenCalledWith('thread-a');
  });

  it.each(['model_error', 'paused'])('allows %s with no pending or running executions', async (state) => {
    const readSnapshot = vi.fn(async () => ({ executions: [{ status: 'completed' }, { status: 'failed' }] }));
    await expect(getActiveThreadCount([{ id: 'thread-a', state }], readSnapshot)).resolves.toBe(0);
    expect(readSnapshot).toHaveBeenCalledWith('thread-a');
  });

  it('fails closed for an unrecognized state without reading snapshots', async () => {
    const readSnapshot = vi.fn();
    await expect(getActiveThreadCount([{ id: 'future', state: 'future_state' }], readSnapshot)).rejects.toThrow(
      'unknown Thread state',
    );
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});
