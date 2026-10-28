/** Fetch with a default timeout for GET requests only; caller cancellation is preserved. */
export function fetchWithGetTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return fetcher(input, init);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetcher(input, { ...init, signal });
}
