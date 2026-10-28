import type { ModelRequestTrace, ProviderRequestSummary, ProviderRequestStart } from '../contracts/model.js';

export interface ModelAuthorization {
  accessToken?(signal: AbortSignal, forceRefresh: boolean, trace?: ModelRequestTrace): Promise<string>;
  authorize?(forceRefresh: boolean, signal: AbortSignal, trace?: ModelRequestTrace): Promise<Record<string, string>>;
  refreshOnUnauthorized?: boolean;
}

export interface TransportRequest {
  endpoint: string;
  provider: string;
  protocol: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  trace?: ModelRequestTrace | undefined;
  providerMetadata?: ProviderRequestStart['providerMetadata'] | undefined;
  authorization?: ModelAuthorization | undefined;
  fetcher?: typeof fetch | undefined;
  fetchRetries?: number | undefined;
  retryDelayMs?: number | undefined;
}

export interface TracedRequest {
  response: Response;
  startedAt: number;
  settle(summary: ProviderRequestSummary): void;
}

export function errorCodeFrom(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !visited.has(current); depth += 1) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const retryCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
function retryable(error: unknown): boolean {
  const code = errorCodeFrom(error)?.toUpperCase();
  return code ? retryCodes.has(code) : error instanceof TypeError && error.message.toLowerCase() === 'fetch failed';
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Each physical fetch is traced and settled once. The caller settles successful HTTP responses after parsing. */
export async function executeModelRequest(options: TransportRequest): Promise<TracedRequest> {
  const { signal, trace, authorization } = options;
  const authorize = async (forceRefresh: boolean): Promise<Record<string, string>> => {
    if (authorization?.authorize) return authorization.authorize(forceRefresh, signal, trace);
    if (authorization?.accessToken)
      return { authorization: `Bearer ${await authorization.accessToken(signal, forceRefresh, trace)}` };
    return {};
  };
  let authHeaders = await authorize(false);
  let refreshUsed = false;
  let retries = 0;
  let attempt = 0;
  while (true) {
    const startedAt = Date.now();
    const id = trace?.started({
      provider: options.provider,
      protocol: options.protocol,
      endpoint: options.endpoint,
      attempt: ++attempt,
      ...(options.providerMetadata ? { providerMetadata: options.providerMetadata } : {}),
    });
    let settled = false;
    const settle = (summary: ProviderRequestSummary): void => {
      if (settled) return;
      settled = true;
      const outputTokens = summary.usage?.outputTokens;
      const outputTokensPerSecond =
        summary.outcome === 'completed' &&
        typeof outputTokens === 'number' &&
        Number.isFinite(outputTokens) &&
        outputTokens >= 0 &&
        Number.isFinite(summary.durationMs) &&
        summary.durationMs > 0
          ? (outputTokens * 1000) / summary.durationMs
          : undefined;
      if (id)
        trace?.settled(id, { ...summary, ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }) });
    };
    let response: Response;
    try {
      const headers = new Headers(options.headers);
      for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
      response = await (options.fetcher ?? fetch)(options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: options.body,
        signal,
      });
    } catch (error) {
      const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const canRetry = !interrupted && retries < (options.fetchRetries ?? 0) && retryable(error);
      const code = interrupted ? 'aborted' : (errorCodeFrom(error) ?? (retryable(error) ? 'fetch_failed' : undefined));
      settle({
        outcome: interrupted ? 'interrupted' : canRetry ? 'retrying' : 'failed',
        durationMs: Date.now() - startedAt,
        errorCategory: interrupted ? 'aborted' : 'transport',
        ...(code ? { errorCode: code } : {}),
      });
      if (!canRetry) throw error;
      retries += 1;
      await delay(options.retryDelayMs ?? 2000, signal);
      continue;
    }
    if (id) {
      const providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id');
      trace?.response(id, {
        status: response.status,
        contentType: response.headers.get('content-type'),
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    if (response.status === 401 && authorization?.refreshOnUnauthorized && !refreshUsed) {
      refreshUsed = true;
      await response.body?.cancel().catch(() => undefined);
      try {
        authHeaders = await authorize(true);
      } catch (error) {
        const interrupted = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        settle({
          outcome: interrupted ? 'interrupted' : 'failed',
          durationMs: Date.now() - startedAt,
          terminalEvent: 'http_response',
          errorCategory: interrupted ? 'aborted' : 'http',
          errorCode: interrupted ? 'aborted' : 'http_401',
        });
        throw error;
      }
      settle({
        outcome: 'retrying',
        durationMs: Date.now() - startedAt,
        terminalEvent: 'http_response',
        errorCategory: 'http',
        errorCode: 'http_401',
      });
      continue;
    }
    return { response, startedAt, settle };
  }
}
