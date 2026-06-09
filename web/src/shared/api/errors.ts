/**
 * Typed error types for the API client.
 *
 * The backend always returns non-2xx errors in the shape:
 *   { error: { code: string, message: string, fields?: Record<string, string[]> } }
 *
 * `fields` is flat-keyed by top-level field name (e.g. { age: ["must be a positive integer"] })
 * to map 1:1 onto React Hook Form's setError(name, { message }) — coordinate with backend
 * to keep this flat (architecture.md §Phase 6 note on fields shape).
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  /** Flat field-level validation errors; key = field name, value = array of messages */
  fields?: Record<string, string[]>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
