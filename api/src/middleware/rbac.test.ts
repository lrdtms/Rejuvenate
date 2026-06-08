/**
 * Unit tests for `requireAuth()`/`requireRole()` (plan.md Phase 3 step 5).
 *
 * Deliberately UNIT-style — hand-rolled fake `AuthService` plus mock
 * `req`/`res`/`next` — rather than integration-style through `createApp()`.
 * The brief explicitly calls these out as "building blocks Phase 4 will
 * apply globally" with "no admin routes exist [yet], just build and unit-test
 * them against a mock req/res/next" — and the thing genuinely worth pinning
 * down here is the AUTHORIZATION DECISION MATRIX (no session / no user found
 * / inactive user / wrong role / right role), which a fake `AuthService`
 * isolates far more precisely and quickly than spinning up a real database +
 * session store would (that integration is already covered end-to-end by
 * `auth.service.test.ts` + `session.test.ts`).
 *
 * The fake `AuthService.getCurrentUser` is the SAME shared primitive both
 * middlewares delegate to (see `rbac.ts`'s "why getCurrentUser, not a
 * session-cached snapshot" note) — by controlling exactly what it returns per
 * test, we can deterministically exercise every branch of the matrix without
 * needing real users, real deactivation timing, or a real Postgres-backed
 * session store.
 */
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../lib/errors';
import type { AuthenticatedUser, AuthService } from '../modules/auth/auth.service';
import { requireAuth, requireRole } from './rbac';

const ADMIN_USER: AuthenticatedUser = {
  id: 'user-admin-1',
  name: 'Ada Admin',
  email: 'ada@example.invalid',
  role: 'ADMIN',
  isActive: true,
};

const BLOGGER_USER: AuthenticatedUser = {
  id: 'user-blogger-1',
  name: 'Bob Blogger',
  email: 'bob@example.invalid',
  role: 'BLOGGER',
  isActive: true,
};

const EVENT_MANAGER_USER: AuthenticatedUser = {
  id: 'user-event-manager-1',
  name: 'Eve EventManager',
  email: 'eve@example.invalid',
  role: 'EVENT_MANAGER',
  isActive: true,
};

/** Builds a fake `AuthService` whose `getCurrentUser` returns a fixed,
 * pre-determined result regardless of the `userId` it's called with — exactly
 * what these unit tests need (they're not testing `AuthService` itself, just
 * how `rbac.ts` reacts to its documented `AuthenticatedUser | null` contract).
 * `login`/`logout`/reset methods are never called by `rbac.ts` — stubbed to
 * satisfy the type without adding meaningless assertions. */
function fakeAuthService(getCurrentUserResult: AuthenticatedUser | null): AuthService {
  return {
    login: vi.fn().mockRejectedValue(new Error('not used in these tests')),
    logout: vi.fn().mockResolvedValue(undefined),
    getCurrentUser: vi.fn().mockResolvedValue(getCurrentUserResult),
    requestPasswordReset: vi.fn().mockRejectedValue(new Error('not used in these tests')),
    confirmPasswordReset: vi.fn().mockRejectedValue(new Error('not used in these tests')),
  };
}

/** Builds a minimal mock `Request` carrying just enough shape for `rbac.ts`
 * to read `req.session.userId` and write `req.user`. Cast through `unknown`
 * — a full `express.Request` is far more than this middleware touches, and
 * the project's established mock-req convention (see other `*.test.ts`
 * files) favours minimal, purpose-built fakes over heavyweight stubbing
 * libraries for exactly this reason. */
function mockRequest(sessionUserId: string | undefined): Request {
  return {
    session: sessionUserId === undefined ? undefined : { userId: sessionUserId },
  } as unknown as Request;
}

function mockResponse(): Response {
  return {} as unknown as Response;
}

/**
 * Invokes a `requireAuth()`/`requireRole()`-shaped middleware against a mock
 * request and resolves once `next` has been called — capturing whatever it
 * was called with (`undefined` for "proceed", or the forwarded error/`AppError`
 * for "stop here").
 *
 * WHY a promise-based wait, not a bare `await middleware(req, res, next)`:
 * both `requireAuth`/`requireRole` return a SYNCHRONOUS `(req, res, next) =>
 * void` (the standard Express middleware shape — Express never awaits a
 * middleware's return value, it relies entirely on `next` being called). The
 * async user-resolution work happens in a `.then()/.catch()` chain that is
 * deliberately NOT returned/awaited by the middleware itself (matching
 * Express's expected void-returning signature) — so `await middleware(...)`
 * resolves immediately, before `next` has actually been invoked, and any
 * assertion on `calls`/`req.user` made right after would observe the
 * PRE-resolution state. Resolving on the FIRST `next` call sidesteps that
 * race correctly, without needing to reach into the middleware's internals
 * or add test-only hooks to production code.
 */
function invoke(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
): Promise<{ calls: unknown[] }> {
  const calls: unknown[] = [];
  return new Promise((resolve) => {
    const next = ((err?: unknown) => {
      calls.push(err);
      resolve({ calls });
    }) as NextFunction;
    middleware(req, mockResponse(), next);
  });
}

describe('requireAuth() (plan.md Phase 3 step 5)', () => {
  it('calls next() with no error and attaches req.user when the session resolves to an active user', async () => {
    const authService = fakeAuthService(BLOGGER_USER);
    const req = mockRequest('user-blogger-1');

    const { calls } = await invoke(requireAuth(authService), req);

    expect(calls).toEqual([undefined]);
    expect(req.user).toEqual(BLOGGER_USER);
    expect(authService.getCurrentUser).toHaveBeenCalledWith('user-blogger-1');
  });

  it('forwards a 401 unauthorized() AppError when there is no session at all', async () => {
    const authService = fakeAuthService(null);
    const req = mockRequest(undefined);

    const { calls } = await invoke(requireAuth(authService), req);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(AppError);
    expect(calls[0]).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(req.user).toBeUndefined();
    // No userId on the session — getCurrentUser must not even be called.
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
  });

  it('forwards a 401 unauthorized() AppError when the session has no userId stamped on it', async () => {
    const authService = fakeAuthService(null);
    const req = { session: {} } as unknown as Request;

    const { calls } = await invoke(requireAuth(authService), req);

    expect(calls[0]).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(authService.getCurrentUser).not.toHaveBeenCalled();
  });

  it(
    'forwards a 401 unauthorized() AppError when getCurrentUser returns null ' +
      '(covers BOTH "user no longer exists" AND "user has been deactivated" — ' +
      'see auth.service.ts: both collapse to null by design)',
    async () => {
      const authService = fakeAuthService(null);
      const req = mockRequest('user-deactivated-or-deleted');

      const { calls } = await invoke(requireAuth(authService), req);

      expect(calls[0]).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(req.user).toBeUndefined();
    },
  );

  it('forwards (does not throw) an unexpected error from getCurrentUser via next()', async () => {
    const boom = new Error('database is on fire');
    const authService: AuthService = {
      login: vi.fn(),
      logout: vi.fn(),
      getCurrentUser: vi.fn().mockRejectedValue(boom),
      requestPasswordReset: vi.fn(),
      confirmPasswordReset: vi.fn(),
    } as unknown as AuthService;
    const req = mockRequest('user-1');

    const { calls } = await invoke(requireAuth(authService), req);

    expect(calls).toEqual([boom]);
  });
});

describe('requireRole() (plan.md Phase 3 step 5)', () => {
  /**
   * The authorization decision matrix this suite pins down — every
   * combination of "is there a valid session?" x "does the resolved role
   * match an allowed one?" and the (status, code) it must produce. This
   * table format makes the matrix legible as a single artifact rather than
   * scattered across many `it` blocks with subtly different setups.
   */
  const matrix: Array<{
    description: string;
    sessionUserId: string | undefined;
    resolvedUser: AuthenticatedUser | null;
    allowedRoles: Array<AuthenticatedUser['role']>;
    expected: 'next' | { statusCode: number; code: string };
  }> = [
    {
      description: 'unauthenticated caller (no session) -> 401, not 403',
      sessionUserId: undefined,
      resolvedUser: null,
      allowedRoles: ['ADMIN'],
      expected: { statusCode: 401, code: 'UNAUTHORIZED' },
    },
    {
      description: 'session present but resolves to no user (deleted/deactivated) -> 401, not 403',
      sessionUserId: 'ghost-user',
      resolvedUser: null,
      allowedRoles: ['ADMIN'],
      expected: { statusCode: 401, code: 'UNAUTHORIZED' },
    },
    {
      description: 'authenticated Blogger hitting an Admin-only route -> 403 forbidden',
      sessionUserId: BLOGGER_USER.id,
      resolvedUser: BLOGGER_USER,
      allowedRoles: ['ADMIN'],
      expected: { statusCode: 403, code: 'FORBIDDEN' },
    },
    {
      description:
        'authenticated Event Manager hitting a Blogger/Admin-only route -> 403 forbidden',
      sessionUserId: EVENT_MANAGER_USER.id,
      resolvedUser: EVENT_MANAGER_USER,
      allowedRoles: ['ADMIN', 'BLOGGER'],
      expected: { statusCode: 403, code: 'FORBIDDEN' },
    },
    {
      description: 'authenticated Admin hitting an Admin-only route -> proceeds',
      sessionUserId: ADMIN_USER.id,
      resolvedUser: ADMIN_USER,
      allowedRoles: ['ADMIN'],
      expected: 'next',
    },
    {
      description: 'authenticated Blogger hitting a route allowing ADMIN or BLOGGER -> proceeds',
      sessionUserId: BLOGGER_USER.id,
      resolvedUser: BLOGGER_USER,
      allowedRoles: ['ADMIN', 'BLOGGER'],
      expected: 'next',
    },
    {
      description:
        'authenticated Admin hitting ANY role-gated route (Admin is allowed everywhere it is listed) -> proceeds',
      sessionUserId: ADMIN_USER.id,
      resolvedUser: ADMIN_USER,
      allowedRoles: ['EVENT_MANAGER', 'ADMIN'],
      expected: 'next',
    },
  ];

  it.each(matrix)(
    '$description',
    async ({ sessionUserId, resolvedUser, allowedRoles, expected }) => {
      const authService = fakeAuthService(resolvedUser);
      const req = mockRequest(sessionUserId);

      const { calls } = await invoke(requireRole(authService, ...allowedRoles), req);

      if (expected === 'next') {
        expect(calls).toEqual([undefined]);
        expect(req.user).toEqual(resolvedUser);
      } else {
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBeInstanceOf(AppError);
        expect(calls[0]).toMatchObject(expected);
        expect(req.user).toBeUndefined();
      }
    },
  );

  it('does not require requireAuth() to have run first — performs its own full authentication check', async () => {
    // No `requireAuth()` in the chain; req.user starts undefined.
    const authService = fakeAuthService(ADMIN_USER);
    const req = mockRequest(ADMIN_USER.id);
    expect(req.user).toBeUndefined();

    const { calls } = await invoke(requireRole(authService, 'ADMIN'), req);

    expect(calls).toEqual([undefined]);
    expect(req.user).toEqual(ADMIN_USER);
  });

  it('forwards (does not throw) an unexpected error from getCurrentUser via next()', async () => {
    const boom = new Error('database is on fire');
    const authService: AuthService = {
      login: vi.fn(),
      logout: vi.fn(),
      getCurrentUser: vi.fn().mockRejectedValue(boom),
      requestPasswordReset: vi.fn(),
      confirmPasswordReset: vi.fn(),
    } as unknown as AuthService;
    const req = mockRequest('user-1');

    const { calls } = await invoke(requireRole(authService, 'ADMIN'), req);

    expect(calls).toEqual([boom]);
  });
});
