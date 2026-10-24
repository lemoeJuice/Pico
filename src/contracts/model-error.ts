import type { ProviderHttpError } from './model.js';

type ModelCallErrorCode =
  | 'target-mismatch'
  | 'connection-unavailable'
  | 'missing-base-url'
  | 'invalid-base-url'
  | 'invalid-options'
  | 'unsupported-parameters'
  | 'provider-unavailable'
  | 'http-response'
  | 'provider-error';

const modelCallErrorMessages: Record<ModelCallErrorCode, string> = {
  'target-mismatch': 'Model pipeline provider and target identity do not match.',
  'connection-unavailable': 'The selected model connection is unavailable.',
  'missing-base-url': 'Model API base URL is required.',
  'invalid-base-url': 'Model API base URL must be a valid HTTP or HTTPS URL.',
  'invalid-options': 'Model selection options must contain non-null scalar values.',
  'unsupported-parameters': 'Model parameters are not supported by the selected provider.',
  'provider-unavailable': 'The selected model provider is unavailable.',
  'http-response': '',
  'provider-error': 'Model request failed (provider_error).',
};

/** Safe to persist or expose beyond the Runtime's model-call boundary. */
export class ModelCallError extends Error {
  readonly code: ModelCallErrorCode;
  readonly status: number | undefined;
  readonly providerError: ProviderHttpError | undefined;

  constructor(code: ModelCallErrorCode, status?: number, providerError?: unknown) {
    const safeCode = Object.hasOwn(modelCallErrorMessages, code) ? code : 'provider-error';
    const safeStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    const safeProviderError = sanitizeProviderHttpError(providerError);
    const providerDetails = safeProviderError
      ? [
          safeProviderError.type ? `type=${safeProviderError.type}` : undefined,
          safeProviderError.code ? `code=${safeProviderError.code}` : undefined,
          safeProviderError.param ? `param=${safeProviderError.param}` : undefined,
          `reason=${safeProviderError.reason}`,
        ]
          .filter((value): value is string => Boolean(value))
          .join('; ')
      : '';
    const message =
      safeCode === 'http-response' && safeStatus !== undefined
        ? `Model provider returned HTTP ${safeStatus}${providerDetails ? ` (${providerDetails})` : ''}.`
        : modelCallErrorMessages[safeCode] || modelCallErrorMessages['provider-error'];
    super(message);
    this.code = safeCode;
    this.status = safeStatus;
    this.providerError = safeProviderError;
    this.name = 'ModelCallError';
  }
}

function sanitizeProviderHttpError(value: unknown): ProviderHttpError | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const label = (candidate: unknown): string | undefined =>
    typeof candidate === 'string' && candidate.length <= 80 && /^[a-z0-9_.:-]+$/i.test(candidate)
      ? candidate
      : undefined;
  const type = label(raw.type);
  const providerCode = label(raw.code);
  const param =
    typeof raw.param === 'string' &&
    raw.param.length <= 160 &&
    /^[a-z0-9_.:-]+(?:\[[a-z0-9_.:-]*\][a-z0-9_.:-]*)*$/i.test(raw.param)
      ? raw.param
      : undefined;
  const reason =
    raw.reason === 'unsupported_parameter' ||
    raw.reason === 'invalid_value' ||
    raw.reason === 'invalid_type' ||
    raw.reason === 'missing_parameter' ||
    raw.reason === 'unknown'
      ? raw.reason
      : 'unknown';
  if (!type && !providerCode && !param && reason === 'unknown') return undefined;
  return {
    reason,
    ...(type ? { type } : {}),
    ...(providerCode ? { code: providerCode } : {}),
    ...(param ? { param } : {}),
  };
}

export function sanitizeModelCallError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof ModelCallError) {
    try {
      return new ModelCallError(error.code, error.status, error.providerError);
    } catch {
      return new ModelCallError('provider-error');
    }
  }
  if (error && typeof error === 'object') {
    const providerStatus = (error as { providerStatus?: unknown }).providerStatus;
    const providerError = (error as { providerError?: unknown }).providerError;
    if (
      typeof providerStatus === 'number' &&
      Number.isInteger(providerStatus) &&
      providerStatus >= 100 &&
      providerStatus <= 599
    ) {
      return new ModelCallError('http-response', providerStatus, providerError);
    }
  }
  if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
    return new DOMException('The model request was aborted.', 'AbortError');
  }
  return new ModelCallError('provider-error');
}
