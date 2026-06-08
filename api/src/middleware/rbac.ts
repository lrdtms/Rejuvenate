/**
 * RBAC middleware (plan.md Phase 3 step 5): `requireAuth()` and
 * `requireRole(...roles)`.
 *
 * Two small, composable Express middlewares — exactly the shape
 * architecture.md §9.2 specifies ("implemented as two composable Express
 * middlewares ... applied per-route, plus a service-layer ownership check").
 * No permission-engine, no dynamic policy DSL — a small, fixed, three-role
 * matrix is the simplest model that satisfies the requirement (CUPID
 * *Predictable*, named explicitly in the architecture doc).
 *
 * ===========================================================================
 * Composition contract — `requireRole` calls `requireAuth` internally
 * ===========================================================================
 * DECISION: `requireRole(...roles)` does NOT assume `requireAuth()` already
 * ran earlier in the chain — it performs the full authentication check
 * itself (by delegating to the same underlying primitive `requireAuth()`
 * uses) before checking the role. Concretely, both are built on top of one
 * shared async helper, `loadAuthenticatedUser(req)`, which is the single
 * place "is there a valid, active, authenticated user for this request?" is
 * answered.
 *
 * Why this direction (self-sufficient, not "assumes auth already ran"):
 *   - It makes EVERY route protected by `requireRole(...)` alone correctly
 *     401 an unauthenticated caller rather than letting an un-authenticated
 *     `req.user` of `undefined` fall through to a confusing 403 ("forbidden"
 *     implies "we know who you are and you're not allowed" — a much worse
 *     signal to send an anonymous caller than "please log in"). A route
 *     author who writes `router.get('/admin/x', requireRole('ADMIN'), ...)`
 *     and forgets `requireAuth()` gets the CORRECT behaviour by construction,
 *     not a subtle bug that only surfaces when an anonymous user probes the
 *     route.
 *   - It costs nothing extra in the common case: `requireAuth()` is cheap (one
 *     `getCurrentUser` lookup — already a single indexed `findUnique`), and
 *     Express doesn't re-run earlier middleware just because a later one also
 *     wants the same guarantee. Stacking BOTH (`requireAuth(), requireRole(...)`)
 *     on one route is harmless — `requireAuth` populates `req.user` and calls
 *     `next()`, then `requireRole` re-derives the same result (one extra,
 *     cheap DB read) and proceeds. Phase 4 module authors are free to write
 *     either `requireRole('ADMIN')` alone OR `requireAuth(), requireRole('ADMIN')`
 *     — both are correct; the former is simply the more concise idiom this
 *     module recommends.
 *
 * ===========================================================================
 * `req.user` — populated for downstream handlers
 * ===========================================================================
 * Both middlewares attach the resolved `AuthenticatedUser` to `req.user` (via
 * the module augmentation below) before calling `next()`. Downstream route
 * handlers and service-layer ownership checks (`canEditPost` — Phase 3 step 6,
 * `ownership.ts`) read `req.user` rather than re-deriving it — one resolution
 * per request, shared by every middleware/handler that needs it. A second
 * `requireAuth()`/`requireRole()` later in the SAME request's chain (see
 * "stacking" note above) overwrites `req.user` with an equivalent value — by
 * construction the same user, since both resolve from the same `req.session`
 * — so this is safe, just a (cheap, harmless) redundant lookup.
 *
 * ===========================================================================
 * Why `getCurrentUser`, not a session-cached snapshot
 * ===========================================================================
 * Both middlewares resolve the user via `authService.getCurrentUser(userId)`
 * — the SAME shared primitive `GET /me` uses (see `auth.service.ts`'s
 * extensive "isActive enforcement" doc-comment) — rather than trusting
 * anything cached on `req.session`. This is THE mechanism that makes
 * "deactivation takes effect immediately" (ADR-0002's promise) actually true
 * for already-logged-in sessions on every protected route, not just `GET
 * /me`. Re-deriving on every request costs one indexed `findUnique` —
 * negligible on this app's single-VPS, low-traffic profile (architecture.md
 * §3) — and buys a correctness guarantee that a cached snapshot cannot.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '@prisma/client';

import { forbidden, unauthorized } from '../lib/errors';
import type { AuthenticatedUser, AuthService } from '../modules/auth/auth.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by `requireAuth()`/`requireRole()` once a valid, active
       * session has been resolved to a live user row. `undefined` for
       * anonymous requests and for any request that never reached one of
       * these middlewares (e.g. public routes) — callers must not assume
       * its presence outside a route chain that includes one of them. */
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Resolves the current request's authenticated user, or `null` if there
 * isn't one — no session, no `userId` stamped on the session, the user no
 * longer exists, or the user has been deactivated (all collapsed into one
 * "not authenticated" outcome by `AuthService.getCurrentUser`, per its own
 * doc-comment). Shared by both `requireAuth()` and `requireRole()` so there
 * is exactly one code path that answers "is this request authenticated?"
 *
 * Not exported — this is an internal composition detail of this file, not a
 * public primitive other modules should reach for (they should use
 * `requireAuth()`/`requireRole()`, or — for non-middleware contexts —
 * `AuthService.getCurrentUser` directly).
 */
async function loadAuthenticatedUser(
  req: Request,
  authService: AuthService,
): Promise<AuthenticatedUser | null> {
  const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;
  if (!userId) {
    return null;
  }

  return authService.getCurrentUser(userId);
}

/**
 * Requires that the request carries a valid session for an existing, active
 * user. On success, attaches the resolved user to `req.user` and calls
 * `next()`. On failure, throws `unauthorized()` (401) — translated by the
 * central error handler into `{ error: { code: 'UNAUTHORIZED', message } }`.
 *
 * A factory (not a bare middleware export) so it takes an `AuthService`
 * dependency explicitly — mirrors `rateLimiter()`/`validate()`/
 * `createSessionMiddleware()`'s factory convention, and keeps this module
 * trivially testable against a hand-rolled fake `AuthService` (see
 * `rbac.test.ts`) without touching a real database or session store.
 *
 * Usage: `router.get('/admin/x', requireAuth(authService), handler)`.
 */
export function requireAuth(authService: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    loadAuthenticatedUser(req, authService)
      .then((user) => {
        if (!user) {
          next(unauthorized());
          return;
        }

        req.user = user;
        next();
      })
      .catch(next);
  };
}

/**
 * Requires that the request is authenticated (see `requireAuth()` — this
 * performs the identical check, see file-header "composition contract" note
 * for why it's self-sufficient rather than chain-order-dependent) AND that
 * the resolved user's `role` is one of `roles`. On success, attaches the user
 * to `req.user` and calls `next()`. On failure, throws `unauthorized()` (401)
 * for "not authenticated at all" or `forbidden()` (403) for "authenticated,
 * but wrong role" — the standard, meaningful distinction between "please log
 * in" and "you're logged in, but you can't do that."
 *
 * Usage: `router.delete('/admin/blog/posts/:id', requireRole(authService, 'ADMIN', 'BLOGGER'), handler)`.
 *
 * Takes `authService` as its FIRST argument (mirroring `requireAuth`'s
 * signature), with the allowed roles as a trailing rest-parameter — this
 * keeps both factories' call shape `fn(authService, ...)` rather than forcing
 * route authors to remember that one of the two takes its dependency in a
 * different position/via a returned-function indirection. `requireRole(authService)`
 * with zero roles is legal but useless (every authenticated user is
 * "forbidden" — `roles.includes(user.role)` is vacuously `false`); TypeScript
 * doesn't forbid it, but a route author who writes that almost certainly
 * meant `requireAuth(authService)` instead.
 *
 * NOTE — this middleware proves the caller is *some* user with an allowed
 * role; it does NOT prove they own the specific resource being acted on.
 * Per-resource ownership (e.g. "this Blogger may edit THIS post because they
 * authored it, or because they're an Admin") is a service-layer concern —
 * see `canEditPost` in `modules/auth/ownership.ts` (Phase 3 step 6). Module
 * authors must call that explicitly wherever a route both (a) requires a
 * role AND (b) targets a specific, ownable resource — `requireRole` alone is
 * not sufficient there (architecture.md §9.2 / plan.md Phase 4a step 4 spell
 * this out for the Blog module specifically; the same shape recurs for Media).
 */
export function requireRole(authService: AuthService, ...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    loadAuthenticatedUser(req, authService)
      .then((user) => {
        if (!user) {
          next(unauthorized());
          return;
        }

        if (!roles.includes(user.role)) {
          next(forbidden());
          return;
        }

        req.user = user;
        next();
      })
      .catch(next);
  };
}
