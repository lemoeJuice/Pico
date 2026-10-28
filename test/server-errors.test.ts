import { describe, expect, it } from 'vitest';
import { ServiceError } from '../src/contracts/service-error.js';
import { errorResponse, parserError } from '../src/server-errors.js';

describe('API error classification', () => {
  it('only exposes explicitly safe errors', () => {
    expect(errorResponse(new ServiceError(409, 'Conflict.'))).toEqual({
      status: 409,
      message: 'Conflict.',
      code: 'conflict',
    });
    expect(errorResponse(new Error('secret not found'))).toEqual({
      status: 500,
      message: 'Internal server error.',
      code: 'internal_error',
    });
    expect(errorResponse({ type: 'entity.parse.failed', message: 'secret' })).toEqual({
      status: 500,
      message: 'Internal server error.',
      code: 'internal_error',
    });
  });

  it('recognizes a bundled copy while rejecting an ordinary status-bearing error', () => {
    class BundledServiceError extends Error {
      constructor(message: string) {
        super(message);
        Object.defineProperty(this, Symbol.for('pico.service-error'), { value: true });
      }
      readonly status = 404;
      readonly code = 'not_found';
    }
    expect(errorResponse(new BundledServiceError('Missing.'))).toEqual({
      status: 404,
      message: 'Missing.',
      code: 'not_found',
    });
    expect(errorResponse(Object.assign(new Error('secret'), { status: 404 }))).toEqual({
      status: 500,
      message: 'Internal server error.',
      code: 'internal_error',
    });
    expect(errorResponse(Object.assign(new BundledServiceError('secret'), { code: 'invalid_request' }))).toEqual({
      status: 500,
      message: 'Internal server error.',
      code: 'internal_error',
    });
  });

  it('maps parser failures to fixed responses', () => {
    expect(errorResponse(parserError({ type: 'entity.parse.failed', message: 'secret' }))).toEqual({
      status: 400,
      message: 'Invalid JSON request body.',
      code: 'invalid_request',
    });
    expect(errorResponse(parserError({ type: 'entity.too.large' }))).toEqual({
      status: 413,
      message: 'Request body is too large.',
      code: 'payload_too_large',
    });
  });
});
