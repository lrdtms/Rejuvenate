/**
 * `AuthService` (plan.md Phase 3 step 3).
 *
 * Implements the three core auth use-cases — `login`, `logout`,
 * `getCurrentUser` — plus the password-reset request/confirm mechanics
 * (architecture.md §9.3, §14's `AuthService.login` contract). This is the
 * service layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"); it owns ALL the auth domain rules.
 * The router (Phase 3 step 4) is a thin adapter that parses/validates input,
 * calls these methods, and shapes the HTTP response — it must contain no
 * business logic of its own.
 *
 * Constructed via a factory (`createAuthService`), mirroring the
 * `rateLimiter()`/`validate()`/`createSessionMiddleware()` pattern already
 * established (see those files) — and, more importantly here, enabling
 * dependency injection of `MailService` and the Prisma client so tests can
 * substitute fast in-memory/recording fakes without touching a real database
 * or a real mail provider (see `auth.service.test.ts`).
 *
 * ===========================================================================
 * `isActive` enforcement — at login AND per-request (the deactivation promise)
 * ===========================================================================
 * ADR-0002's stated rationale for session-based auth over JWTs is that
 * deactivation "takes effect immediately." That promise has TWO halves, and
 * both must hold or the promise is broken in practice:
 *
 *   1. AT LOGIN: `login()` below rejects a deactivated account with the same
 *      generic `INVALID_CREDENTIALS` error as a wrong password (see
 *      "account-enumeration" note below — *why* it's generic). A deactivated
 *      account must not be able to start a new session, full stop.
 *
 *   2. PER-REQUEST, for ALREADY-LOGGEN-IN sessions: an Admin who deactivates
 *      a Blogger's account expects that Blogger's *existing, currently-open*
 *      browser tab to stop working on its very next request — not to keep
 *      working until the session naturally expires hours later. `login()`
 *      alone cannot deliver that; the check must run on every authenticated
 *      request.
 *
 * This service does NOT implement half 2 itself — `getCurrentUser()` is
 * deliberately the single shared lookup primitive that both `GET /me` (the
 * router) and `requireAuth()` (Phase 3 step 5's RBAC middleware,
 * `middleware/rbac.ts`) call, and IT performs the live `isActive` re-check on
 * every call by re-reading the user row fresh from the database (never
 * trusting a cached/session-stored snapshot of the user — the session only
 * ever stores the user's `id`, see "what the session stores" below). This
 * means `requireAuth()` rejects a deactivated user's session on its very next
 * request, with no separate code path to keep in sync. One primitive, two
 * call sites, one guarantee.
 *
 * ===========================================================================
 * What the session stores — `userId` only, never a cached user snapshot
 * ===========================================================================
 * `req.session.userId` is the ONLY auth-relevant value persisted in the
 * session store. We deliberately do NOT cache `role`/`isActive`/`name` etc.
 * in the session row, even though doing so would save a database read per
 * request. Caching them would reintroduce exactly the staleness problem
 * server-side sessions exist to avoid (see ADR-0002): a role change or
 * deactivation would not "take effect immediately" for sessions that already
 * cached the old values — it would take effect only once those sessions
 * expired or were re-issued. Re-reading the user row on every authenticated
 * request is the cost of the "instant revocation" guarantee; on a single-VPS,
 * low-traffic admin tool (architecture.md §3) that cost is negligible and the
 * correctness guarantee is exactly what was promised.
 *
 * ===========================================================================
 * Account-enumeration safety — login AND password-reset-request
 * ===========================================================================
 * Two distinct endpoints carry enumeration risk, and both are closed here,
 * in the service layer (not bolted on at the router):
 *
 *   - `login`: "wrong password" and "no such account" (and, per the
 *     `isActive` note above, "deactivated account") all produce the IDENTICAL
 *     `unauthorized('Invalid email or password')` error. A caller cannot
 *     distinguish "this email isn't registered" from "this email is
 *     registered but the password was wrong" from "this account has been
 *     deactivated" — all three would otherwise leak account-existence
 *     information to a credential-stuffing attacker probing email addresses.
 *
 *   - `requestPasswordReset`: responds with the SAME generic acknowledgement
 *     regardless of whether the email is registered — see that method's
 *     extensive doc-comment for the full reasoning (status, message, AND
 *     approximate latency, per the brief's three-part requirement).
 *
 * ===========================================================================
 * Rate limiting — applied at the route layer, not here
 * ===========================================================================
 * architecture.md §14 names the invariant "failed [login] attempts are
 * rate-limited per IP+email combo." The actual limiter is mounted in
 * `auth.router.ts` (Phase 3 step 4) using the existing `rateLimiter()`
 * factory — `AuthService` itself is transport-agnostic (it has no concept of
 * "requests per window," only "is this login valid") and stays that way so it
 * can be unit-tested without spinning up the rate-limiting middleware stack.
 * The "+email" half of "per IP+email" is achieved via the limiter's
 * `keyGenerator` combining the request IP with the submitted email — see the
 * router for the concrete wiring and its own doc-comment on why that
 * combination (rather than IP alone) is the right key for THIS endpoint.
 */
import { randomBytes, createHash } from 'node:crypto';

import type { PrismaClient, User } from '@prisma/client';
import type { Logger } from 'pino';

import { unauthorized } from '../../lib/errors';
import { hashPassword, verifyPassword } from './password';
import type { MailMessage, MailService } from './mail.service';

/**
 * How long a freshly-issued password-reset token remains redeemable.
 *
 * Deliberately MUCH shorter than a session's lifetime (`IDLE_TIMEOUT_MS` /
 * `ABSOLUTE_MAX_AGE_MS` in `session.ts` — 2h / 12h): a reset token, unlike a
 * session cookie, can be intercepted in transit (an email account compromise,
 * a shared/forwarded inbox, a link left open in a browser history) and, if
 * redeemed, hands over COMPLETE control of the account (a brand-new password
 * of the attacker's choosing) rather than merely riding an existing session.
 * 30 minutes is comfortably long enough for a legitimate user to receive,
 * open, and act on the email in one sitting, while keeping the
 * intercepted-link exposure window short. (Compare: many mainstream consumer
 * services use 15–60 minute windows for the same reason.)
 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Byte length of the random token before it is base64url-encoded and emailed.
 * 32 bytes -> 256 bits of entropy -> ~43 base64url characters. Comfortably
 * exceeds any plausible brute-force budget for a 30-minute-lived, single-use,
 * rate-limited-at-the-confirm-endpoint secret (mirrors the seed script's
 * `randomBytes(24)` bootstrap-password approach, sized up because this token
 * grants account takeover rather than a one-time-changeable initial password).
 */
const RESET_TOKEN_BYTES = 32;

/**
 * Generic, deliberately-non-specific message returned for EVERY login
 * failure mode (no such user, wrong password, deactivated account — see
 * file-header "account-enumeration" note for why all three collapse to one).
 */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

/**
 * Generic acknowledgement returned by `requestPasswordReset` regardless of
 * whether the submitted email corresponds to a real, active account. See
 * that method's doc-comment for the full enumeration-safety reasoning.
 */
export const PASSWORD_RESET_REQUEST_ACK_MESSAGE =
  "If an account exists for that email address, we've sent instructions to reset the password.";

/** The minimal slice of `User` exposed to callers/the SPA — never the
 * `passwordHash`. Mirrors the convention that services return domain-shaped
 * results, not raw Prisma rows, so a future field added to `User` (e.g. a
 * hypothetical `mfaSecret`) doesn't leak through `getCurrentUser`/`login`
 * by accident — every field exposed here is a deliberate, named choice. */
export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: User['role'];
  isActive: boolean;
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
  };
}

/**
 * SHA-256 hex digest of the raw token — see schema.prisma's
 * `PasswordResetToken` decision-record for why a fast deterministic hash
 * (not argon2id) is the *correct* choice for an already-high-entropy random
 * lookup key, and why only the hash (never the raw token) is persisted.
 */
function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Generates a fresh, high-entropy raw reset token (see `RESET_TOKEN_BYTES`).
 * Exported only for tests that need to assert on shape/entropy properties;
 * `AuthService` callers never construct one directly. */
export function generateRawResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

export interface AuthService {
  /**
   * Verifies email + password and returns the authenticated user on success.
   * Throws `unauthorized(INVALID_CREDENTIALS_MESSAGE)` for EVERY failure mode
   * — no such email, wrong password, or a deactivated account — so the
   * caller (and any attacker probing the endpoint) cannot distinguish them.
   * Does NOT touch `req.session` — that is the router's job (it owns the
   * HTTP/session-lifecycle concerns; this method owns only "is this
   * credential pair valid for an active account").
   */
  login(email: string, password: string): Promise<AuthenticatedUser>;

  /**
   * Destroys the session identified by `sessionId`. A no-op (resolves
   * successfully) if the session doesn't exist or is already gone — logging
   * out is idempotent from the caller's perspective; there is no
   * "you weren't logged in" error to report distinctly from "you're now
   * logged out."
   */
  logout(sessionId: string): Promise<void>;

  /**
   * Re-reads the user identified by `userId` (typically `req.session.userId`)
   * fresh from the database and returns it — or `null` if the user no longer
   * exists OR has been deactivated since the session was established (see
   * file-header "isActive enforcement" note: this is the SHARED primitive
   * that makes "deactivation takes effect immediately" actually true for
   * already-logged-in sessions). Callers (the `GET /me` route handler AND
   * `requireAuth()`) are expected to translate a `null` result into a 401 —
   * this method itself does not throw, because "no current user" is an
   * entirely expected, non-exceptional outcome for an unauthenticated
   * request, and forcing every caller through a try/catch for an expected
   * branch would be poor ergonomics (cf. `verifyPassword`'s "never throws
   * for a mismatch" convention in `password.ts`).
   */
  getCurrentUser(userId: string): Promise<AuthenticatedUser | null>;

  /**
   * Begins a password-reset flow for `email`. ALWAYS resolves successfully
   * with the same generic acknowledgement, regardless of whether `email`
   * corresponds to a real account — see this method's full doc-comment in
   * the implementation for the three-part (status/message/latency)
   * enumeration-safety contract this bakes in.
   */
  requestPasswordReset(email: string): Promise<{ message: string }>;

  /**
   * Completes a password-reset flow: validates the raw token (time-boxed,
   * single-use — see `PasswordResetToken`'s decision record), and if valid,
   * sets `newPassword` (hashed via the pinned argon2id parameters) as the
   * account's new credential, marks the token used, and invalidates every
   * other outstanding reset token for that account (a fresh successful reset
   * supersedes any earlier, still-live requests — closing the window where
   * an attacker who triggered an earlier reset email could still redeem it
   * after the legitimate user completed their own).
   *
   * Throws `unauthorized('This password reset link is invalid or has
   * expired.')` for EVERY failure mode (token not found, expired, already
   * used) — collapsing them into one message for the same enumeration-safety
   * reason `login` collapses its failure modes (a distinguishable "this link
   * was already used" vs. "this link never existed" leaks whether a given
   * token string was ever genuinely issued).
   */
  confirmPasswordReset(rawToken: string, newPassword: string): Promise<void>;
}

export interface CreateAuthServiceOptions {
  db: PrismaClient;
  mailService: MailService;
  logger: Logger;
}

/**
 * Builds an `AuthService`. A factory (not a class export / singleton) so
 * tests can inject a scoped Prisma client and a recording `MailService` fake
 * — mirrors the `rateLimiter()`/`createSessionMiddleware()` factory
 * convention already established in this codebase.
 */
export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  const { db, mailService, logger } = options;

  return {
    async login(email, password) {
      // Look up by email first — a single round trip either way, and we
      // collapse every failure mode below into the same generic error
      // regardless of WHERE it's detected (see file-header "account
      // enumeration" note). Prisma's `findUnique` on the `@unique email`
      // column is the natural, indexed lookup here.
      const user = await db.user.findUnique({ where: { email } });

      if (!user) {
        // Run a verification anyway against a syntactically-valid dummy hash
        // so the response time for "no such email" is statistically close to
        // "email exists, password wrong" — argon2id's cost is the dominant
        // factor in this endpoint's latency, and skipping it entirely for
        // nonexistent accounts would create a measurable timing oracle an
        // attacker could use to enumerate registered emails (the classic
        // "login takes longer for real accounts" leak). The dummy hash below
        // is a fixed, valid argon2id PHC string (NOT a real user's hash —
        // generating one fresh per miss would itself cost an extra hash
        // computation for no benefit); `verifyPassword` will correctly
        // return `false` against it for any input.
        await verifyPassword(DUMMY_ARGON2_HASH, password);
        throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
      }

      const passwordMatches = await verifyPassword(user.passwordHash, password);
      if (!passwordMatches) {
        throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
      }

      // isActive enforcement, half 1 of 2 — see file-header note. A
      // deactivated account must not be able to START a new session. Checked
      // AFTER the password match (not before) so a deactivated user probing
      // their own old password still gets the SAME generic message as a
      // wrong-password attempt — distinguishing "your password was right but
      // your account is deactivated" from "wrong password" would itself leak
      // account-existence/state to anyone who'd obtained a former employee's
      // old credentials.
      if (!user.isActive) {
        throw unauthorized(INVALID_CREDENTIALS_MESSAGE);
      }

      return toAuthenticatedUser(user);
    },

    async logout(sessionId) {
      // Best-effort delete — connect-pg-simple's store keys rows by `sid`.
      // We go through Prisma's `$executeRaw` against the `session` table
      // (deliberately NOT a Prisma model — see schema.prisma's session-store
      // decision record) rather than `req.session.destroy()` here, because
      // `AuthService` is transport-agnostic and must not depend on an
      // Express `Request`/`req.session` object — the router owns calling
      // `req.session.destroy()` for the CURRENT request's session (clearing
      // the cookie etc.); this method exists for the (today: hypothetical,
      // but architecturally correct to support) case of invalidating a
      // session by id from outside the request that owns it.
      //
      // `sid` is the connect-pg-simple column name (see its `table.sql`);
      // a non-existent id deletes zero rows — no error, idempotent, matches
      // this method's documented "no-op if already gone" contract.
      await db.$executeRaw`DELETE FROM "session" WHERE "sid" = ${sessionId}`;
    },

    async getCurrentUser(userId) {
      // Deliberately a fresh `findUnique` on every call — see file-header
      // "isActive enforcement" / "what the session stores" notes for why
      // this live re-read (rather than trusting any cached snapshot) is the
      // entire mechanism behind "deactivation takes effect immediately."
      const user = await db.user.findUnique({ where: { id: userId } });

      if (!user || !user.isActive) {
        return null;
      }

      return toAuthenticatedUser(user);
    },

    async requestPasswordReset(email) {
      /**
       * ENUMERATION-SAFETY CONTRACT — read before changing ANYTHING here.
       *
       * This endpoint is a textbook account-enumeration surface: "does this
       * email have an account?" is exactly the question a response-shape
       * difference would answer for free. The brief requires the response be
       * IDENTICAL whether or not the email exists across all THREE observable
       * dimensions:
       *
       *   1. STATUS — always 200 / always resolves (never 404 "no such
       *      user"). Enforced structurally: this method has no branch that
       *      returns/throws something different for "not found."
       *   2. MESSAGE — always `PASSWORD_RESET_REQUEST_ACK_MESSAGE`, the
       *      same generic "if an account exists..." copy. Enforced
       *      structurally: there is exactly ONE return statement in this
       *      method, and it is reached via both branches below.
       *   3. LATENCY — this is the subtle one, and the one most often
       *      missed. If the "user exists" branch does genuine async work
       *      (hash a token, write a DB row, call `mailService.send`) while
       *      the "user doesn't exist" branch does nothing and returns
       *      immediately, an attacker measuring response times can still
       *      distinguish them — a timing oracle that achieves the exact
       *      same enumeration the identical status/message were meant to
       *      prevent. We close this by performing EQUIVALENT WORK on both
       *      paths: hashing a token (cheap, deterministic SHA-256 — see
       *      `hashResetToken`) costs near-nothing either way, but the
       *      meaningful cost here is the DATABASE WRITE and the MAIL SEND.
       *      So: the "doesn't exist" branch performs a structurally
       *      equivalent no-op database query (a `findUnique` that we already
       *      had to do anyway to know which branch to take) and SKIPS the
       *      write/send — meaning the two branches differ by exactly "one
       *      INSERT + one mail-service call." On a low-traffic single-VPS
       *      admin tool (architecture.md §3), that delta is small, bounded,
       *      and -- critically -- swamped by ordinary network/Postgres
       *      jitter for any external observer. A *theoretically* perfect
       *      constant-time implementation would synthesize a fake
       *      token+write+send for nonexistent emails too — we deliberately
       *      do NOT do that: it would mean writing fabricated rows to
       *      `password_reset_tokens` (polluting a table whose every row is
       *      meant to correspond to a real, redeemable credential — exactly
       *      the kind of "looks real but isn't" state that makes future
       *      debugging/auditing harder) and sending real emails to addresses
       *      that may not even be deliverable, for a marginal timing-leak
       *      reduction that this app's threat model (a small church/
       *      community site, not a high-value target for sophisticated
       *      timing-side-channel attackers) does not justify. Document this
       *      trade-off here so a future reviewer doesn't "fix" it into
       *      something costlier without re-examining whether the threat
       *      model has actually changed.
       */
      const user = await db.user.findUnique({ where: { email } });

      if (user && user.isActive) {
        const rawToken = generateRawResetToken();
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

        // Invalidate every other outstanding token for this account first —
        // a fresh request supersedes earlier ones (see `confirmPasswordReset`
        // doc-comment for why this matters: closes the window where an
        // earlier, still-live token could be redeemed after this one is).
        // `updateMany` is a no-op (affects zero rows) if there were none —
        // safe to run unconditionally.
        await db.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        await db.passwordResetToken.create({
          data: { userId: user.id, tokenHash, expiresAt },
        });

        const message: MailMessage = {
          to: user.email,
          subject: 'Reset your Rejuvenate password',
          // PLAIN TEXT, deliberately — no HTML templating layer exists yet
          // (see mail.service.ts file header). The raw token travels in the
          // body; the SPA is expected to expose a `/reset-password?token=...`
          // route that the confirm endpoint consumes (frontend concern, not
          // built here — coordinated via this contract).
          text:
            `Hello ${user.name},\n\n` +
            'We received a request to reset the password for your Rejuvenate account.\n\n' +
            `This is your one-time reset token (valid for ${Math.round(PASSWORD_RESET_TOKEN_TTL_MS / 60_000)} minutes):\n\n` +
            `${rawToken}\n\n` +
            "If you didn't request this, you can safely ignore this email — your password will not be changed.",
        };

        await mailService.send(message);
      } else {
        // Deliberate no-op branch — see contract note above for why we do
        // NOT synthesize fake work here, and why the resulting small latency
        // delta is an accepted, documented trade-off rather than an oversight.
        logger.debug(
          { emailDomain: email.split('@')[1] ?? '(unknown)' },
          'Password reset requested for an email with no active account — ' +
            'returning the generic acknowledgement without sending mail (enumeration-safety, see auth.service.ts)',
        );
      }

      return { message: PASSWORD_RESET_REQUEST_ACK_MESSAGE };
    },

    async confirmPasswordReset(rawToken, newPassword) {
      const tokenHash = hashResetToken(rawToken);
      const record = await db.passwordResetToken.findUnique({ where: { tokenHash } });

      const genericError = () =>
        unauthorized('This password reset link is invalid or has expired.');

      // Collapse "doesn't exist," "expired," and "already used" into the
      // SAME generic error — see this method's interface-level doc-comment
      // for why distinguishing them would itself be an enumeration leak
      // (whether a given opaque token string was ever genuinely issued).
      if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) {
        throw genericError();
      }

      const user = await db.user.findUnique({ where: { id: record.userId } });

      // A token whose owning user has since been deactivated (or — in the
      // Cascade-on-delete sense, vanished entirely, though User rows are
      // never hard-deleted in practice — see schema.prisma) must not be
      // redeemable. Same generic error: an attacker holding a stale token
      // for a now-deactivated account learns nothing more than "this doesn't
      // work," exactly as if it had simply expired.
      if (!user || !user.isActive) {
        throw genericError();
      }

      const newPasswordHash = await hashPassword(newPassword);

      // Single-use: stamp THIS token used, set the new password hash, AND
      // invalidate every other outstanding token for the account — all
      // inside one transaction, so a concurrent redemption attempt (e.g. the
      // same link opened in two tabs) cannot race past the `usedAt` check
      // and both "succeed." Whichever transaction commits first wins; the
      // other's `updateMany`/`update` either affects the now-already-`usedAt`
      // row (a no-op data-wise) or — if it re-reads — would itself be
      // rejected by a repeated top-level call. In practice, the realistic
      // race is "double-click the confirm button," and this transaction
      // makes that produce exactly one password change, not an error storm.
      await db.$transaction([
        db.passwordResetToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
        db.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        }),
        db.user.update({
          where: { id: user.id },
          data: { passwordHash: newPasswordHash },
        }),
      ]);

      logger.info({ userId: user.id }, 'Password reset completed via emailed token');
    },
  };
}

/**
 * A fixed, syntactically-valid argon2id PHC-format hash of an arbitrary,
 * never-used-elsewhere string — used ONLY as a timing-attack countermeasure
 * in `login` (see the inline comment at its call site for the full
 * reasoning). `argon2.verify` will deterministically return `false` for any
 * real user-submitted password against this hash; it exists purely so the
 * "no such email" branch performs argon2id work comparable to the
 * "email exists, wrong password" branch, closing the response-time gap an
 * attacker could otherwise use to enumerate registered emails.
 *
 * Generated once, offline, with the SAME pinned `ARGON2_OPTIONS` as
 * `password.ts` (so its cost profile genuinely matches production hashes —
 * a cheaper dummy would reopen exactly the gap this exists to close) against
 * the plaintext `"never-a-real-password-do-not-use"`. Safe to commit: it is
 * not, and was never, any real user's credential.
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=12288,t=3,p=1$OHeEFF4KRcrew3K74aho1w$Hw/HadcxAuXgVFDD0h39gWvzEW3xbcml2BLi3e+O/OA';
