export type ExecutorProbe = { connected: boolean; error?: string };

export type ExecutorStatusView = { connected: boolean | null; error: string | null };

export function executorStatusFromProbe(result: PromiseSettledResult<ExecutorProbe>): ExecutorStatusView {
  if (result.status === 'rejected') {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { connected: null, error: `Could not check Executor status: ${message}` };
  }

  const { connected, error } = result.value;
  return {
    connected,
    error: connected ? null : (error ?? 'Executor connection failed.'),
  };
}
