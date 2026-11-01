export type ExecutorProbe = { connected: boolean; error?: string; inactive?: boolean };

export type ExecutorStatusView = { connected: boolean | null; error: string | null };

export function executorStatusFromProbe(result: PromiseSettledResult<ExecutorProbe>): ExecutorStatusView {
  if (result.status === 'rejected') {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { connected: null, error: `Could not check Executor status: ${message}` };
  }

  if (result.value.inactive === true) return { connected: null, error: null };

  const { connected, error } = result.value;
  return {
    connected,
    error: connected ? null : (error ?? 'Executor connection failed.'),
  };
}

export function startVisibleStatusPolling(
  refresh: () => void,
  documentSource: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  windowSource: Pick<Window, 'setInterval' | 'clearInterval'>,
  intervalMs = 15_000,
): () => void {
  let active = true;
  const refreshWhenVisible = (): void => {
    if (active && documentSource.visibilityState === 'visible') refresh();
  };
  documentSource.addEventListener('visibilitychange', refreshWhenVisible);
  const timer = windowSource.setInterval(refreshWhenVisible, intervalMs);
  refreshWhenVisible();
  return () => {
    active = false;
    documentSource.removeEventListener('visibilitychange', refreshWhenVisible);
    windowSource.clearInterval(timer);
  };
}
