/**
 * Shared error shape for the API, per architecture.md §8:
 *
 *   { error: { code, message, fields? } }
 *
 * `AppError` is thrown from service/router code and translated to this shape by the
 * central error-handling middleware (added in Phase 2 alongside the rest of the
 * Express skeleton). Kept here in Phase 0 so the convention is established up front.
 *
 * ---------------------------------------------------------------------------
 * Agreed error taxonomy (plan.md Phase 2 step 3) — the FULL list of error kinds
 * modules should throw, their HTTP status, their `code` string, and the factory
 * that produces them. New error kinds should be added to this table AND as a
 * factory below — module authors should not construct ad-hoc `AppError`s that
 * don't appear here.
 *
 *   Kind (plan.md name)       | Status | `code`             | Factory
 *   --------------------------|--------|--------------------|---------------------------
 *   ValidationError           |   400  | VALIDATION_ERROR   | validationError(fields, message?)
 *   UnknownSlotError          |   400  | UNKNOWN_SLOT       | unknownSlot(slotKey, message?)
 *   (generic bad request)     |   400  | BAD_REQUEST        | badRequest(message?, fields?)
 *   AuthError / Unauthenticated |  401 | UNAUTHORIZED       | unauthorized(message?)
 *   ForbiddenError            |   403  | FORBIDDEN          | forbidden(message?)
 *   NotFoundError             |   404  | NOT_FOUND          | notFound(message?)
 *   ConflictError             |   409  | CONFLICT           | conflict(message?)
 *   CapacityExceededError     |   409  | CAPACITY_EXCEEDED  | capacityExceeded(message?)
 *   RateLimitedError          |   429  | RATE_LIMITED       | tooManyRequests(message?)
 *
 * Note both `ConflictError` and `CapacityExceededError` map to HTTP 409, but carry
 * distinct `code`s — this lets the SPA tell "duplicate/conflicting submission" apart
 * from "this event is full" even though the transport-level status is the same.
 * ---------------------------------------------------------------------------
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

/**
 * Request-body/query/params failed schema validation (e.g. the upcoming Zod
 * `validate()` middleware). Distinct from `badRequest` — same HTTP status (400),
 * but a dedicated `VALIDATION_ERROR` code and a *required* `fields` map, so
 * callers (and the SPA) can rely on `error.fields` always being present for this
 * specific kind rather than treating it as optional. `badRequest` remains the
 * right choice for malformed-but-not-schema-shaped requests (e.g. bad JSON,
 * missing route params) where there's no natural per-field breakdown.
 */
export function validationError(
  fields: Record<string, string[]>,
  message = 'Validation failed',
): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message, fields);
}

export function conflict(message = 'Conflicting request'): AppError {
  return new AppError(409, 'CONFLICT', message);
}

/**
 * An RSVP/registration was rejected because the event has reached its configured
 * `capacity` (architecture.md §7.3 — enforced transactionally, no waitlisting in
 * v1: hard-reject with a clear message). Maps to 409 like `conflict`, but with a
 * distinct `CAPACITY_EXCEEDED` code so the SPA can show "this event is full"
 * rather than a generic "conflicting request" message.
 */
export function capacityExceeded(message = 'This event has reached capacity'): AppError {
  return new AppError(409, 'CAPACITY_EXCEEDED', message);
}

/**
 * A client exceeded a per-route rate limit (plan.md Phase 2 step 7 — login and RSVP
 * are the two routes that wire this up, in Phases 3/4 respectively). Maps to HTTP 429
 * (`Too Many Requests`, RFC 6585) with a dedicated `RATE_LIMITED` code so the SPA can
 * show a "slow down and try again shortly" message distinct from any other 4xx.
 *
 * Used by `middleware/rateLimit.ts`'s custom `handler` to keep the limiter's response
 * in the same `{ error: { code, message } }` shape as the rest of the API rather than
 * express-rate-limit's own plain-text/JSON default body.
 */
export function tooManyRequests(message = 'Too many requests — please try again later'): AppError {
  return new AppError(429, 'RATE_LIMITED', message);
}

/**
 * A CMS write targeted a `slotKey` outside the fixed slot registry (architecture.md
 * §7.3 invariant #8 / ADR-0007 — CMSContent is fixed named slots, never a generic
 * page builder). The message names the offending key so editors can see exactly
 * what was rejected and why.
 */
export function unknownSlot(slotKey: string, message?: string): AppError {
  return new AppError(400, 'UNKNOWN_SLOT', message ?? `Unknown CMS slot key: "${slotKey}"`);
}
