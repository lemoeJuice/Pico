const serviceErrorBrand = Symbol.for('pico.service-error');
const codes = {
  400: 'invalid_request',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
} as const;

export type ServiceErrorStatus = keyof typeof codes;
export type ServiceErrorCode = (typeof codes)[ServiceErrorStatus];

/** An explicitly safe error intended for a service caller. */
export class ServiceError extends Error {
  readonly [serviceErrorBrand] = true;
  readonly code: ServiceErrorCode;

  constructor(
    readonly status: ServiceErrorStatus,
    message: string,
  ) {
    super(message);
    this.code = codes[status];
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  if (!(error instanceof Error)) return false;
  const candidate = error as ServiceError;
  return (
    candidate[serviceErrorBrand] === true &&
    Object.hasOwn(codes, candidate.status) &&
    codes[candidate.status] === candidate.code &&
    typeof candidate.message === 'string'
  );
}
