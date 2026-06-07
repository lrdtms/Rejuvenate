/**
 * Session middleware (plan.md Phase 3 step 1 — "Session store").
 *
 * Wires `express-session` to a Postgres-backed store (`connect-pg-simple`,
 * already pinned in package.json) per ADR-0002 ("server-side sessions backed by
 * a PostgreSQL session store"). The `session` table itself is owned by
 * `connect-pg-simple` OUTSIDE Prisma's migration history — see the ~35-line
 * decision-record comment block at the top of `prisma/schema.prisma` before
 * changing anything here. We rely on that comment's documented "simplest path"
 * (`createTableIfMissing: true`) rather than hand-running `table.sql`, which
 * keeps a fresh local/dev/CI database self-bootstrapping on first run.
 *
 * ---------------------------------------------------------------------------
 * Cookie name — `rejuvenate.sid`, not the default `connect.sid`
 * ---------------------------------------------------------------------------
 * Trivial hardening: the default name advertises "this app runs express-session"
 * to anyone inspecting cookies, which is free reconnaissance for an attacker
 * probing for known framework defaults/CVEs. Costs nothing to rename.
 *
 * ---------------------------------------------------------------------------
 * `cookie.secure` — derived from `NODE_ENV`, never hardcoded
 * ---------------------------------------------------------------------------
 * We use an EXPLICIT boolean (`env.NODE_ENV === 'production'`) rather than
 * express-session's `cookie.secure = 'auto'`. Both would technically work given
 * `app.set('trust proxy', 1)` is already configured (see app.ts) — `'auto'`
 * inspects `req.secure`, which Express derives from `X-Forwarded-Proto` once
 * `trust proxy` is set. We prefer the explicit derivation because:
 *
 *   - It is predictable independent of proxy/header configuration: if Nginx
 *     ever fails to set `X-Forwarded-Proto` correctly (a real misconfiguration
 *     risk — it's an easy line to omit from a reverse-proxy location block),
 *     `'auto'` would silently start minting non-Secure cookies in production,
 *     which is exactly the class of bug that's invisible until an audit/incident.
 *     An explicit `NODE_ENV`-derived boolean fails in the *opposite*, safer
 *     direction: it can never accidentally weaken cookie security based on a
 *     proxy header it didn't intend to trust.
 *   - It keeps local dev (`NODE_ENV=development`/`test`, plain HTTP, no TLS)
 *     working without any proxy-header gymnastics — `secure: false` so the
 *     browser will still store/send the cookie over `http://localhost`.
 *   - It matches the "gate on NODE_ENV/trust proxy, not hardcode" instruction
 *     literally: the boolean *is* gated on `NODE_ENV`, and the deployment
 *     topology (architecture.md §11 — Nginx terminates TLS, proxies to Node
 *     over plain HTTP on localhost) guarantees "production" only ever serves
 *     over HTTPS in the first place, so `NODE_ENV === 'production'` and
 *     "served over HTTPS" are one and the same fact in this system.
 *
 * ---------------------------------------------------------------------------
 * TTL — rolling idle timeout AND a separate absolute max age
 * ---------------------------------------------------------------------------
 * `express-session` natively supports a *rolling* idle timeout: with
 * `rolling: true` and `cookie.maxAge` set, every response that touches the
 * session re-issues the cookie with a refreshed expiry, so an active user is
 * never logged out mid-task — but an abandoned/stolen cookie expires
 * `IDLE_TIMEOUT_MS` after the last request that used it.
 *
 * What it does NOT support is a separate ABSOLUTE ceiling — "no matter how
 * active this session stays, force re-authentication after N hours total".
 * Without one, a continuously-active (or continuously-replayed, e.g. by an
 * attacker who stole the cookie and is keeping it warm) session would renew
 * itself forever. We bridge that gap ourselves:
 *
 *   1. On a session's first use, stamp `req.session.createdAt` (epoch ms).
 *   2. `enforceAbsoluteSessionMaxAge()` (exported below, mounted immediately
 *      after the session middleware) checks that stamp on every request and
 *      destroys + clears the session once `now - createdAt > ABSOLUTE_MAX_AGE_MS`,
 *      regardless of how recently the session was "active". The user is then
 *      treated as logged out and must re-authenticate.
 *
 * Chosen values (named constants below, both explicit per the task brief):
 *
 *   - `IDLE_TIMEOUT_MS` = 2 hours. This is an internal admin/staff tool (blog,
 *     events, registrations, CMS — architecture.md §6), not a public-facing
 *     consumer app where a 30-minute timeout would be reasonable. Staff write
 *     long-form content (blog posts, CMS copy) and may go quiet for stretches
 *     while drafting in another window — 2 hours balances "don't annoy staff
 *     with frequent re-logins" against "an unattended, unlocked workstation
 *     with an open admin tab doesn't stay live indefinitely".
 *   - `ABSOLUTE_MAX_AGE_MS` = 12 hours. Comfortably covers a single working day
 *     (including a lunch break that exceeds the idle timeout, requiring one
 *     re-login) without ever requiring an active staff member to re-auth
 *     mid-task, while still hard-capping a compromised/replayed cookie's
 *     useful lifetime to "at most half a day" — a meaningful reduction in blast
 *     radius versus an indefinitely-renewing session.
 *
 * `cookie.maxAge` is set to `IDLE_TIMEOUT_MS` (the rolling component); the
 * absolute cap is enforced purely server-side via the stamped `createdAt` and
 * is intentionally NOT reflected in the cookie's `Max-Age`/`Expires` attributes
 * (the browser doesn't need to know about it — the server is the actual
 * authority and re-checks on every request, per architecture.md §9's "the
 * server is the real security boundary" principle).
 *
 * ---------------------------------------------------------------------------
 * `resave: false`, `saveUninitialized: false`
 * ---------------------------------------------------------------------------
 * Both are the security-conscious, standard recommendation:
 *   - `resave: false` — don't write the session back to the store on every
 *     request when it wasn't modified (avoids race conditions where concurrent
 *     requests clobber each other's writes, and reduces write load on Postgres).
 *   - `saveUninitialized: false` — don't create/store a session (and don't set
 *     a cookie) for visitors who never actually log in or otherwise populate
 *     `req.session`. Prevents the store from filling up with empty sessions
 *     from anonymous traffic (e.g. every public blog/events page view) and
 *     avoids setting cookies for users who haven't consented to anything
 *     session-worthy yet.
 */
import connectPgSimple from 'connect-pg-simple';
import session, { type SessionOptions } from 'express-session';
import type { NextFunction, Request, Response } from 'express';

import { env } from '../../config/env';

/** Custom cookie name — see file-header "Cookie name" note. */
export const SESSION_COOKIE_NAME = 'rejuvenate.sid';

/**
 * Rolling idle timeout: a session not used for this long expires. Refreshed on
 * every request that touches the session (`rolling: true`). See file-header
 * "TTL" note for the reasoning behind the chosen value.
 */
export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Absolute hard cap: a session is force-expired this long after it was first
 * created, regardless of how recently it was used. Enforced by
 * `enforceAbsoluteSessionMaxAge()` below — express-session has no native
 * equivalent. See file-header "TTL" note for the reasoning behind the chosen
 * value.
 */
export const ABSOLUTE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// Module augmentation: track when a session was first established so
// `enforceAbsoluteSessionMaxAge` can compute its age. Declared here (the file
// that owns the absolute-max-age contract) rather than in a separate `.d.ts` so
// the field and its enforcement live side-by-side.
declare module 'express-session' {
  interface SessionData {
    /** Epoch-ms timestamp of when this session was first established. Stamped
     * once on first use and never refreshed — refreshing it would defeat the
     * entire purpose of an *absolute* ceiling (it would become just another
     * rolling timeout). */
    createdAt?: number;
  }
}

const PgSession = connectPgSimple(session);

/**
 * Builds the configured `express-session` middleware, backed by a
 * `connect-pg-simple` Postgres store.
 *
 * A factory (rather than a module-level singleton) so tests can construct
 * fresh instances against `createApp()` without import-order/shared-state
 * concerns — mirrors the `rateLimiter()`/`validate()` factory pattern already
 * established in this codebase (see `middleware/rateLimit.ts`, `middleware/validate.ts`).
 */
export function createSessionMiddleware(): ReturnType<typeof session> {
  const store = new PgSession({
    // Reuses the same connection string Prisma uses (`DATABASE_URL`) — no
    // separate pool/credentials to manage. connect-pg-simple opens its own
    // small internal `pg.Pool` from this string; it does not share Prisma's.
    conString: env.DATABASE_URL,
    // Per the schema.prisma decision-record comment: connect-pg-simple owns
    // this table outside Prisma's migration history, and the documented
    // "simplest path" for a single-operator deploy is to let the library
    // create it on first run if it doesn't already exist.
    createTableIfMissing: true,
    // Default table/schema names (`session`/`public`) — matches what the
    // decision-record comment describes; no need to override.
  });

  const options: SessionOptions = {
    store,
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      // See file-header "cookie.secure" note for why this is an explicit
      // NODE_ENV-derived boolean rather than `'auto'` or a hardcoded literal.
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: IDLE_TIMEOUT_MS,
    },
  };

  return session(options);
}

/**
 * Enforces the absolute session-lifetime ceiling that `express-session` has no
 * native concept of (see file-header "TTL" note). Mount this immediately AFTER
 * `createSessionMiddleware()` — it depends on `req.session` being populated.
 *
 * Behaviour:
 *   - No session yet (`saveUninitialized: false` means anonymous visitors never
 *     get one): no-op, nothing to enforce.
 *   - Session exists but has no `createdAt` stamp (i.e. this is the very first
 *     request to use it — most commonly, the request that just logged in):
 *     stamp it now and continue. This is the ONE place `createdAt` is ever
 *     written; it is deliberately never refreshed afterward.
 *   - Session exists and is older than `ABSOLUTE_MAX_AGE_MS`: destroy it
 *     (removes the store row), clear the cookie, and continue as if the
 *     request were unauthenticated — `requireAuth()` (Phase 3 RBAC middleware,
 *     built on top of this) will then correctly reject it with 401 rather than
 *     trusting a session that has outlived its hard cap.
 */
export function enforceAbsoluteSessionMaxAge() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session) {
      next();
      return;
    }

    const { createdAt } = req.session;

    if (createdAt === undefined) {
      req.session.createdAt = Date.now();
      next();
      return;
    }

    if (Date.now() - createdAt > ABSOLUTE_MAX_AGE_MS) {
      req.session.destroy((err) => {
        if (err) {
          // Destruction failure shouldn't block the request from proceeding as
          // "logged out" — log and continue; `requireAuth()` downstream still
          // won't find a usable authenticated session on `req.session` once
          // we've cleared the cookie below (best-effort: the store row may
          // briefly linger, but the client's cookie is gone either way).
          req.log?.error({ err }, 'Failed to destroy expired session');
        }
        res.clearCookie(SESSION_COOKIE_NAME);
        next();
      });
      return;
    }

    next();
  };
}
