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

  constructor(code: ModelCallErrorCode, status?: number) {
    const safeCode = Object.hasOwn(modelCallErrorMessages, code) ? code : 'provider-error';
    const safeStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    const message =
      safeCode === 'http-response' && safeStatus !== undefined
        ? `Model provider returned HTTP ${safeStatus}.`
        : modelCallErrorMessages[safeCode] || modelCallErrorMessages['provider-error'];
    super(message);
    this.code = safeCode;
    this.status = safeStatus;
    this.name = 'ModelCallError';
  }
}

export function sanitizeModelCallError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof ModelCallError) {
    try {
      return new ModelCallError(error.code, error.status);
    } catch {
      return new ModelCallError('provider-error');
    }
  }
  if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
    return new DOMException('The model request was aborted.', 'AbortError');
  }
  return new ModelCallError('provider-error');
}
