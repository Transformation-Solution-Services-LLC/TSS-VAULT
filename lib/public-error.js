import crypto from 'node:crypto';

export class PublicError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
    this.diagnosticId = options.diagnosticId || crypto.randomUUID();
    this.category = options.category || code;
  }
}

export function normalizePublicError(error) {
  if (error instanceof PublicError) return error;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  const code = status === 500 ? 'internal_error' : (error?.code || 'request_rejected');
  const message = status === 500 ? 'The request could not be completed' : (error?.publicMessage || error?.message || 'The request was rejected');
  return new PublicError(status, code, message, { cause: error, category: error?.category || code });
}

export function publicErrorBody(error) {
  const normalized = normalizePublicError(error);
  return {
    error: normalized.message,
    code: normalized.code,
    diagnostic_id: normalized.diagnosticId,
  };
}

export function safeErrorDiagnostic(error, fallbackCategory = 'internal_error') {
  const normalized = error instanceof PublicError
    ? error
    : new PublicError(500, 'internal_error', 'The request could not be completed', {
      cause: error,
      category: fallbackCategory,
    });
  return {
    diagnostic_id: normalized.diagnosticId,
    category: normalized.category || fallbackCategory,
    status: normalized.status,
  };
}

export function logSafeError(logger, error, category) {
  const diagnostic = safeErrorDiagnostic(error, category);
  const write = logger?.error || logger?.log || console.error;
  write.call(logger || console, 'request failed', diagnostic);
  return diagnostic;
}

export function providerFailure(error, category = 'provider_request_failed') {
  if (error instanceof PublicError && error.category === category) return error;
  return new PublicError(502, 'provider_request_failed', 'The provider request failed', {
    cause: error,
    category,
  });
}
