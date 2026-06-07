/**
 * Unit tests for the `AppError` factory taxonomy (plan.md Phase 2 step 3 —
 * "get this taxonomy agreed before modules start throwing ad-hoc errors").
 *
 * Each factory is asserted against the agreed table documented in the
 * `errors.ts` file-header comment: HTTP status code, `code` string, `fields`
 * presence/shape where applicable, and (for the newly-added, more specific
 * factories) message content. We don't re-test `AppError` construction itself
 * beyond what's needed to pin down each factory's contract — the class is a
 * trivial data holder.
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
  badRequest,
  capacityExceeded,
  conflict,
  forbidden,
  notFound,
  unauthorized,
  unknownSlot,
  validationError,
} from './errors';

describe('error factories', () => {
  it('notFound() -> 404 NOT_FOUND', () => {
    const err = notFound();
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Resource not found');
    expect(err.fields).toBeUndefined();
  });

  it('notFound() accepts a custom message', () => {
    const err = notFound('Event not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Event not found');
  });

  it('unauthorized() -> 401 UNAUTHORIZED', () => {
    const err = unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Authentication required');
    expect(err.fields).toBeUndefined();
  });

  it('forbidden() -> 403 FORBIDDEN', () => {
    const err = forbidden();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('You do not have permission to do that');
    expect(err.fields).toBeUndefined();
  });

  describe('badRequest()', () => {
    it('-> 400 BAD_REQUEST with no fields by default', () => {
      const err = badRequest();
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('Invalid request');
      expect(err.fields).toBeUndefined();
    });

    it('passes through an optional fields map and custom message', () => {
      const err = badRequest('Bad input', { age: ['must be a positive integer'] });
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('Bad input');
      expect(err.fields).toEqual({ age: ['must be a positive integer'] });
    });
  });

  describe('validationError()', () => {
    it('-> 400 VALIDATION_ERROR with the given fields map and a default message', () => {
      const err = validationError({ email: ['Invalid email address'] });
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Validation failed');
      expect(err.fields).toEqual({ email: ['Invalid email address'] });
    });

    it('accepts a custom message alongside the fields map', () => {
      const err = validationError(
        { age: ['must be between 0 and 120'] },
        'Registration details are invalid',
      );
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toBe('Registration details are invalid');
      expect(err.fields).toEqual({ age: ['must be between 0 and 120'] });
    });

    it('carries a distinct code from badRequest() despite sharing HTTP 400', () => {
      const validation = validationError({ foo: ['bar'] });
      const generic = badRequest();
      expect(validation.statusCode).toBe(generic.statusCode);
      expect(validation.code).not.toBe(generic.code);
    });
  });

  describe('conflict()', () => {
    it('-> 409 CONFLICT', () => {
      const err = conflict();
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toBe('Conflicting request');
      expect(err.fields).toBeUndefined();
    });
  });

  describe('capacityExceeded()', () => {
    it('-> 409 CAPACITY_EXCEEDED with a default, user-facing message', () => {
      const err = capacityExceeded();
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CAPACITY_EXCEEDED');
      expect(err.message).toBe('This event has reached capacity');
      expect(err.fields).toBeUndefined();
    });

    it('accepts a custom message', () => {
      const err = capacityExceeded('Sorry, this event is fully booked');
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CAPACITY_EXCEEDED');
      expect(err.message).toBe('Sorry, this event is fully booked');
    });

    it('carries a distinct code from conflict() despite sharing HTTP 409', () => {
      const capacity = capacityExceeded();
      const generic = conflict();
      expect(capacity.statusCode).toBe(generic.statusCode);
      expect(capacity.code).not.toBe(generic.code);
    });
  });

  describe('unknownSlot()', () => {
    it('-> 400 UNKNOWN_SLOT with a default message naming the offending slotKey', () => {
      const err = unknownSlot('homepage.hero.banner');
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('UNKNOWN_SLOT');
      expect(err.message).toContain('homepage.hero.banner');
      expect(err.fields).toBeUndefined();
    });

    it('accepts a custom message that overrides the default', () => {
      const err = unknownSlot('bogus.slot', 'That slot does not exist in the registry');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('UNKNOWN_SLOT');
      expect(err.message).toBe('That slot does not exist in the registry');
    });

    it('carries a distinct code from badRequest()/validationError() despite sharing HTTP 400', () => {
      const slot = unknownSlot('foo.bar');
      expect(slot.statusCode).toBe(400);
      expect(slot.code).not.toBe(badRequest().code);
      expect(slot.code).not.toBe(validationError({}).code);
    });
  });
});
