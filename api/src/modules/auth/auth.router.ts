/**
 * Auth module router (plan.md Phase 3 step 4).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/logout
 *   GET  /api/v1/me
 *   POST /api/v1/auth/password-reset/request
 *   POST /api/v1/auth/password-reset/confirm
 *
 * This is the "interface adapter" layer in the router -> service -> repository
 * chain (architecture.md §6 "Clean layering"): it parses/validates HTTP input
 * (via `validate()` + the Zod schemas in `auth.schemas.ts`), translates
 * between Express's session/cookie/request world and `AuthService`'s
 * plain-data contract, and shapes responses. NO business rules live here —
 * every domain decision (is this credential pair valid? is this account
 * active? is this reset token redeemable?) is `AuthService`'s job; see that
 * file's extensive doc-comments for the *why* behind each one.
 *
 * A factory (`createAuthRouter`), not a module-level `router` — mirrors the
 * `createSessionMiddleware()`/`createAuthService()` factory convention, and
 * lets `app.ts` (the composition root) inject the `AuthService` instance
 * (itself constructed with the shared `db`/`mailService`/`logger`) rather than
 * this file reaching for module-level singletons that tests can't substitute.
 *
 * ===========================================================================
 * Session lifecycle — why `regenerate` on login, `destroy` on logout
 * ===========================================================================
 * `login` calls `req.session.regenerate(...)` BEFORE stamping `userId` —
 * this is the standard session-fixation defense: issuing a brand-new session
 * id on privilege escalation (anonymous -> authenticated) ensures an
 * attacker who fixed/predicted/observed the PRE-login session id gains
 * nothing by it; the post-login session is a different id entirely. Without
 * this, an attacker could plant a known session id in a victim's browser
 * (e.g. via a crafted link, if the cookie weren't HttpOnly/SameSite=Lax —
 * defense in depth, not reliance on a single control) and then use that same
 * id themselves once the victim authenticates under it.
 *
 * `logout` calls `req.session.destroy(...)` (removing the store row entirely)
 * and `res.clearCookie(...)` (telling the browser to drop the cookie) — the
 * full, immediate revocation ADR-0002 promises. `AuthService.logout` is NOT
 * used for the "current session" path (it operates on an arbitrary
 * `sessionId` from outside the owning request — see its doc-comment for why
 * that's a deliberately different, narrower contract); the router owns
 * destroying *this* request's own session because only it holds the live
 * `req.session` object Express needs to clear the cookie correctly.
 *
 * ===========================================================================
 * Rate limiting — per IP+email on login AND password-reset-request
 * ===========================================================================
 * architecture.md §14 names the invariant explicitly for login ("failed
 * attempts are rate-limited per IP+email combo"); architecture.md §12
 * extends the same posture to "the public RSVP and login endpoints" broadly,
 * and §9.4 to password-reset (it shares the same credential-stuffing/
 * brute-force threat shape as login — both are "submit a secret, get told if
 * it was right"). Both routes below use `rateLimiter()` with a custom
 * `keyGenerator` combining the resolved client IP with the submitted email
 * (lower-cased, matching the schema's `.toLowerCase()` normalization) —
 * see `loginRateLimitKey` for why IP-alone or email-alone would each be
 * insufficient on their own.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';

import { rateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import type { AuthService } from './auth.service';
import {
  confirmPasswordResetSchema,
  loginSchema,
  requestPasswordResetSchema,
  type ConfirmPasswordResetInput,
  type LoginInput,
  type RequestPasswordResetInput,
} from './auth.schemas';
import { SESSION_COOKIE_NAME } from './session';

/**
 * Combines the (proxy-aware — see `app.set('trust proxy', 1)` in `app.ts`)
 * client IP with the submitted email into one rate-limit bucket key.
 *
 * WHY BOTH, not just one:
 *   - IP alone over-penalizes shared networks (an office, a church's own
 *     guest wifi, a carrier-grade NAT) — one slow/forgetful legitimate user
 *     mistyping their password repeatedly could lock out every OTHER staff
 *     member behind the same IP from logging in at all. A small org with a
 *     handful of staff (architecture.md §3) makes this a real, not
 *     theoretical, scenario.
 *   - Email alone is trivially evaded — an attacker just rotates source IPs
 *     (or, more realistically at this scale, doesn't even need to: a single
 *     IP making thousands of attempts against ONE email would still need
 *     *some* per-IP ceiling to be slowed down at all) while still being able
 *     to hammer a SINGLE target account from many vantage points.
 *   - Combined, an attacker must control both a specific target email AND
 *     stay within one source IP's budget to make progress — exactly the
 *     "per IP+email combo" shape architecture.md §14 specifies, and the
 *     tightest practical bound without a CAPTCHA (explicitly named as
 *     "likely overkill" for this scale in architecture.md §9.4).
 *
 * Reads `req.body?.email` directly (NOT `req.ip` + the Zod-PARSED body —
 * this middleware runs BEFORE `validate()` in the chain, deliberately: a
 * malformed request should still count against its claimed email's budget,
 * not get a free pass by virtue of being invalid). Lower-cased to match
 * `loginSchema`/`requestPasswordResetSchema`'s `.toLowerCase()` normalization
 * — so `Attacker@Example.com` and `attacker@example.com` share one bucket
 * rather than each getting their own fresh budget.
 */
function ipAndEmailRateLimitKey(req: Request): string {
  const rawEmail = (req.body as { email?: unknown } | undefined)?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '(no-email)';
  return `${req.ip ?? '(no-ip)'}:${email}`;
}

/**
 * Login attempt budget: 10 attempts per 15-minute window per IP+email combo.
 * Generous enough that a legitimate staff member who mistypes their password
 * a few times in a row (a very normal human thing to do) never gets
 * needlessly locked out mid-task, while still bounding an automated
 * credential-stuffing run against a single known/guessed staff email to a
 * trickle (10 guesses / 15 minutes ~= 960/day — far below what's needed to
 * brute-force an argon2id-hashed, reasonable-length password, and the
 * argon2id cost itself — see `password.ts` — adds real wall-clock cost on
 * top of this ceiling).
 */
const LOGIN_RATE_LIMIT = { windowMs: 15 * 60_000, max: 10 };

/**
 * Password-reset-request budget: deliberately TIGHTER than login (5 per
 * 15-minute window). Two reasons: (1) a legitimate user has essentially no
 * reason to request a reset more than once or twice in quick succession —
 * unlike login, where mistyped passwords are routine; repeated requests
 * are either confusion (one request is enough — the email says so) or abuse;
 * (2) it doubles as a blunt instrument against email-bombing a target
 * address with reset-notification spam (a minor but real annoyance/abuse
 * vector this endpoint could otherwise enable even WITH the
 * enumeration-safe generic response — the response being identical doesn't
 * stop someone from making the target's inbox unpleasant).
 */
const PASSWORD_RESET_REQUEST_RATE_LIMIT = { windowMs: 15 * 60_000, max: 5 };

export interface CreateAuthRouterOptions {
  authService: AuthService;
}

export function createAuthRouter(options: CreateAuthRouterOptions): Router {
  const { authService } = options;
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------
  router.post(
    '/auth/login',
    rateLimiter({
      ...LOGIN_RATE_LIMIT,
      keyGenerator: ipAndEmailRateLimitKey,
      message: 'Too many login attempts — please try again in a few minutes',
    }),
    validate({ body: loginSchema }),
    (req: Request<unknown, unknown, LoginInput>, res: Response, next) => {
      const { email, password } = req.body;

      authService
        .login(email, password)
        .then((user) => {
          // Session-fixation defense — see file-header note. `regenerate`
          // discards the pre-login session (anonymous, never persisted —
          // `saveUninitialized: false`) and assigns a fresh id BEFORE we
          // stamp any auth state onto it.
          req.session.regenerate((regenerateErr) => {
            if (regenerateErr) {
              next(regenerateErr);
              return;
            }

            (req.session as unknown as { userId: string }).userId = user.id;

            req.session.save((saveErr) => {
              if (saveErr) {
                next(saveErr);
                return;
              }

              res.status(200).json({ user });
            });
          });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  // Deliberately NOT gated by `requireAuth()` — logging out an
  // already-logged-out (or never-logged-in) caller is a no-op success, not
  // an error (mirrors `AuthService.logout`'s documented idempotency: "there
  // is no 'you weren't logged in' error to report distinctly from 'you're
  // now logged out'"). Gating this behind auth would turn "I clicked logout
  // twice" or "my session already expired, then I clicked logout" into a
  // confusing 401 on an action whose entire point is "make sure I'm logged
  // out" — the user IS logged out either way; the response should say so.
  router.post('/auth/logout', (req: Request, res: Response, next) => {
    if (!req.session) {
      res.status(204).end();
      return;
    }

    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }

      res.clearCookie(SESSION_COOKIE_NAME);
      res.status(204).end();
    });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  // Mounted at `/me` (NOT `/auth/me`) per the brief's exact route list —
  // this is the SPA's "am I logged in, and as whom?" bootstrap call, used on
  // every page load to decide whether to render the public or admin shell
  // (architecture.md §10.2). Built directly on `authService.getCurrentUser`
  // — the SAME shared primitive `requireAuth()`/`requireRole()` use (see
  // `auth.service.ts`'s "isActive enforcement" note) — rather than
  // `requireAuth()` middleware, because the two have subtly different
  // contracts here: `requireAuth()` THROWS 401 for "not logged in" (correct
  // for protected resources — the request can't proceed without a user);
  // `GET /me` instead returns a successful, structured "you are
  // unauthenticated" response (`{ user: null }`), because "am I logged in?"
  // is a perfectly normal QUESTION an anonymous visitor's SPA bootstrap asks
  // on every single page load — treating that as an error would mean every
  // anonymous page view logs/produces a 401, which is both semantically
  // wrong (nothing actually went wrong) and noisy.
  router.get('/me', (req: Request, res: Response, next) => {
    const userId = (req.session as unknown as { userId?: string } | undefined)?.userId;

    if (!userId) {
      res.status(200).json({ user: null });
      return;
    }

    authService
      .getCurrentUser(userId)
      .then((user) => {
        res.status(200).json({ user });
      })
      .catch(next);
  });

  // -------------------------------------------------------------------------
  // POST /auth/password-reset/request
  // -------------------------------------------------------------------------
  router.post(
    '/auth/password-reset/request',
    rateLimiter({
      ...PASSWORD_RESET_REQUEST_RATE_LIMIT,
      keyGenerator: ipAndEmailRateLimitKey,
      message: 'Too many password reset requests — please try again later',
    }),
    validate({ body: requestPasswordResetSchema }),
    (req: Request<unknown, unknown, RequestPasswordResetInput>, res: Response, next) => {
      const { email } = req.body;

      authService
        .requestPasswordReset(email)
        // ALWAYS 200 with the SAME body shape — see `AuthService
        // .requestPasswordReset`'s extensive enumeration-safety doc-comment.
        // This handler has exactly one response branch by construction,
        // mirroring the service's "exactly one return statement" guarantee —
        // there is structurally nowhere for a status/shape difference to
        // sneak in here even if the service's internal branching changes.
        .then(({ message }) => {
          res.status(200).json({ message });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /auth/password-reset/confirm
  // -------------------------------------------------------------------------
  // Deliberately NOT additionally rate-limited here — the token itself is the
  // binding secret (256 bits of entropy, single-use, 30-minute-lived; see
  // `auth.service.ts`'s `RESET_TOKEN_BYTES`/`PASSWORD_RESET_TOKEN_TTL_MS`),
  // and `AuthService.confirmPasswordReset` already collapses every failure
  // mode into one generic, non-distinguishing error. Rate-limiting "guess
  // the token" attempts would be security theatre — 2^256 worth of guesses
  // isn't meaningfully slowed by a request-count ceiling; the entropy IS the
  // defense. (Contrast `login`/`request`, where the "secret" is a
  // human-chosen password or a real email address — both far lower-entropy,
  // and exactly where rate limiting earns its keep.)
  router.post(
    '/auth/password-reset/confirm',
    validate({ body: confirmPasswordResetSchema }),
    (req: Request<unknown, unknown, ConfirmPasswordResetInput>, res: Response, next) => {
      const { token, newPassword } = req.body;

      authService
        .confirmPasswordReset(token, newPassword)
        .then(() => {
          res.status(204).end();
        })
        .catch(next);
    },
  );

  return router;
}
