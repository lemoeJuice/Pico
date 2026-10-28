import type { ProviderHttpError } from './model.js';

type ModelCallErrorCode =
  | 'missing-model'
  | 'unsupported-images'
  | 'unsupported-protocol'
  | 'adapter-unavailable'
  | 'target-mismatch'
  | 'connection-unavailable'
  | 'missing-base-url'
  | 'invalid-base-url'
  | 'invalid-options'
  | 'unsupported-parameters'
  | 'provider-unavailable'
  | 'http-response'
  | 'provider-error';

export type ProviderFailurePhase = 'oauth_token' | 'responses_request' | 'responses_stream' | 'response_validation';

const SAFE_PROVIDER_FAILURE_CODES = new Set([
  'aborted',
  'auth',
  'empty_output',
  'empty_stream',
  'fetch_failed',
  'invalid_client',
  'invalid_grant',
  'incomplete_function_call',
  'invalid_json',
  'invalid_stream',
  'invalid_scope',
  'invalid_token_response',
  'missing_completion',
  'missing_function_name',
  'protocol',
  'provider_error',
  'response_failed',
  'server_error',
  'temporarily_unavailable',
  'timeout',
  'transport',
  'unauthorized_client',
  'unsupported_grant_type',
]);

const SAFE_PROVIDER_NETWORK_CODES = new Set([
  'EACCES',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const SAFE_PROVIDER_FAILURE_PHASES = new Set<ProviderFailurePhase>([
  'oauth_token',
  'responses_request',
  'responses_stream',
  'response_validation',
]);

export function sanitizeProviderFailureCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 80 || !/^[a-z0-9_.:-]+$/i.test(value)) return undefined;
  if (/^http_[1-5][0-9]{2}$/i.test(value)) return value.toLowerCase();
  const lower = value.toLowerCase();
  if (SAFE_PROVIDER_FAILURE_CODES.has(lower)) return lower;
  const upper = value.toUpperCase();
  return SAFE_PROVIDER_NETWORK_CODES.has(upper) ? upper : undefined;
}

export function sanitizeProviderFailurePhase(value: unknown): ProviderFailurePhase | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const phase = value.toLowerCase() as ProviderFailurePhase;
  return SAFE_PROVIDER_FAILURE_PHASES.has(phase) ? phase : undefined;
}

export function modelRequestFailureMessage(code: unknown, phase?: unknown): string | undefined {
  const safeCode = sanitizeProviderFailureCode(code);
  if (!safeCode || /^http_[1-5][0-9]{2}$/.test(safeCode)) return undefined;
  const safePhase = sanitizeProviderFailurePhase(phase);
  return `Model request failed (${safeCode}${safePhase ? `; phase=${safePhase}` : ''}).`;
}

const modelCallErrorMessages: Record<ModelCallErrorCode, string> = {
  'missing-model': 'Choose a model and adapter before sending a message.',
  'unsupported-images': 'The selected model does not support image inputs.',
  'unsupported-protocol': 'The selected model protocol is unsupported.',
  'adapter-unavailable': 'The saved adapter or parameters are unavailable. Select again.',
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
  readonly providerFailureCode: string | undefined;
  readonly providerPhase: ProviderFailurePhase | undefined;

  constructor(
    code: ModelCallErrorCode,
    status?: number,
    providerError?: unknown,
    failure?: { providerFailureCode?: unknown; providerPhase?: unknown },
  ) {
    const safeCode = Object.hasOwn(modelCallErrorMessages, code) ? code : 'provider-error';
    const safeStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    const safeProviderError = sanitizeProviderHttpError(providerError);
    const safeProviderFailureCode = sanitizeProviderFailureCode(failure?.providerFailureCode);
    const safeProviderPhase = sanitizeProviderFailurePhase(failure?.providerPhase);
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
    const httpDetails = [providerDetails || undefined, safeProviderPhase ? `phase=${safeProviderPhase}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join('; ');
    const message =
      safeCode === 'http-response' && safeStatus !== undefined
        ? `Model provider returned HTTP ${safeStatus}${httpDetails ? ` (${httpDetails})` : ''}.`
        : safeCode === 'provider-error' && safeProviderFailureCode
          ? modelRequestFailureMessage(safeProviderFailureCode, safeProviderPhase)!
          : modelCallErrorMessages[safeCode] || modelCallErrorMessages['provider-error'];
    super(message);
    this.code = safeCode;
    this.status = safeStatus;
    this.providerError = safeProviderError;
    this.providerFailureCode = safeProviderFailureCode;
    this.providerPhase = safeProviderPhase;
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
      return new ModelCallError(error.code, error.status, error.providerError, {
        providerFailureCode: error.providerFailureCode,
        providerPhase: error.providerPhase,
      });
    } catch {
      return new ModelCallError('provider-error');
    }
  }
  if (error && typeof error === 'object') {
    const details = error as {
      code?: unknown;
      providerStatus?: unknown;
      providerError?: unknown;
      providerPhase?: unknown;
    };
    const providerStatus = details.providerStatus;
    const providerError = details.providerError;
    const providerFailureCode = sanitizeProviderFailureCode(details.code);
    const providerPhase = sanitizeProviderFailurePhase(details.providerPhase);
    if (
      typeof providerStatus === 'number' &&
      Number.isInteger(providerStatus) &&
      providerStatus >= 100 &&
      providerStatus <= 599
    ) {
      return new ModelCallError('http-response', providerStatus, providerError, { providerPhase });
    }
    const statusFromCode = /^http_([1-5][0-9]{2})$/i.exec(providerFailureCode ?? '')?.[1];
    if (statusFromCode) {
      return new ModelCallError('http-response', Number(statusFromCode), providerError, { providerPhase });
    }
    if (providerFailureCode) {
      return new ModelCallError('provider-error', undefined, undefined, {
        providerFailureCode,
        providerPhase,
      });
    }
  }
  if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
    return new DOMException('The model request was aborted.', 'AbortError');
  }
  return new ModelCallError('provider-error');
}
