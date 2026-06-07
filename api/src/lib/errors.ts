/**
 * Shared error shape for the API, per architecture.md §8:
 *
 *   { error: { code, message, fields? } }
 *
 * `AppError` is thrown from service/router code and translated to this shape by the
 * central error-handling middleware (added in Phase 2 alongside the rest of the
 * Express skeleton). Kept here in Phase 0 so the convention is established up front.
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields?: Record<string, string[]>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

export function notFound(message = 'Resource not found'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function unauthorized(message = 'Authentication required'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = 'You do not have permission to do that'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function badRequest(
  message = 'Invalid request',
  fields?: Record<string, string[]>,
): AppError {
  return new AppError(400, 'BAD_REQUEST', message, fields);
}

export function conflict(message = 'Conflicting request'): AppError {
  return new AppError(409, 'CONFLICT', message);
}
