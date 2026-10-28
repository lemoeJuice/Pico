import { isServiceError, ServiceError, type ServiceErrorCode } from './contracts/service-error.js';

export function parserError(error: unknown): ServiceError | undefined {
  // body-parser assigns these fixed types; its error message can include request data.
  if (error && typeof error === 'object' && 'type' in error) {
    switch (error.type) {
      case 'entity.parse.failed':
        return new ServiceError(400, 'Invalid JSON request body.');
      case 'entity.too.large':
        return new ServiceError(413, 'Request body is too large.');
      case 'charset.unsupported':
      case 'encoding.unsupported':
        return new ServiceError(415, 'Unsupported request body encoding.');
      case 'request.aborted':
      case 'request.size.invalid':
        return new ServiceError(400, 'Invalid request body.');
    }
  }
  return undefined;
}

export function errorResponse(error: unknown): {
  status: number;
  message: string;
  code: ServiceErrorCode | 'internal_error';
} {
  if (isServiceError(error)) return { status: error.status, message: error.message, code: error.code };
  return { status: 500, message: 'Internal server error.', code: 'internal_error' };
}
