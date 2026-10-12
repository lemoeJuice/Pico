import type { Execution, ThreadState } from '../core/types.js';

export function threadCanBeInterrupted(state: ThreadState, executions: readonly Pick<Execution, 'status'>[]): boolean {
  return (
    state === 'running' ||
    state === 'pausing' ||
    executions.some((execution) => execution.status === 'pending' || execution.status === 'running')
  );
}
