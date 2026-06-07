/**
 * Rate-limiting middleware factory (plan.md Phase 2 step 7).
 *
 * `rateLimiter({ windowMs, max, ... })` wraps `express-rate-limit@7.4.1` and returns an
 * Express middleware that can be mounted on whichever route needs it. This file does
 * NOT mount anything globally — it is deliberately a *factory*, not a single hardcoded
 * limiter, so that:
 *
 *   - Phase 3 can call `rateLimiter({ windowMs: 15 * 60_000, max: 10 })` on the login
 *     route (architecture.md §12 — "rate-limit the public RSVP and login endpoints"),
 *   - Phase 4 can call it again with different, RSVP-appropriate numbers on the public
 *     registration route,
 *
 * each tuned to its own endpoint's abuse profile, without copy-pasting the
 * response-shaping/store wiring below.
 *
 * ---------------------------------------------------------------------------
 * DECISION: in-memory store (the library's default) — explicitly, not Redis
 * ---------------------------------------------------------------------------
 *
 * `express-rate-limit`'s default `MemoryStore` keeps hit counts in the Node process's
 * own memory. We use it as-is and have NOT reached for `rate-limit-redis` or any other
 * shared/external store. This is a conscious YAGNI call (architecture.md §11 — single
 * Linode VPS, one Node process behind Nginx, no horizontal scaling planned), not an
 * oversight — but it carries a real, documented limitation future maintainers WILL hit:
 *
 *   1. **Counts reset on every restart.** `pm2 reload`/`pm2 restart`/a crash-and-respawn
 *      all wipe the in-memory counters. A client who was 1 request away from being
 *      limited gets a clean slate the moment a deploy lands (`git pull` → ... →
 *      `pm2 reload`, per architecture.md §11's deploy recipe). If you're ever debugging
 *      "why did rate limiting reset right after a deploy?" — THIS IS WHY, and it's
 *      expected, not a bug.
 *   2. **Counts are per-process, not shared.** If this API is ever run as more than one
 *      Node instance (e.g. PM2 cluster mode, or a second VPS behind a load balancer),
 *      each instance keeps its own counters — a client could get up to
 *      `max * <instance count>` requests through before every instance independently
 *      notices it's over budget. The single-instance deployment described in
 *      architecture.md §11 makes this a non-issue TODAY; it stops being a non-issue the
 *      moment that deployment topology changes.
 *
 * If either of those ever becomes a real problem (multi-instance deployment, or an
 * abuse pattern that specifically exploits restart-resets), swap `store` for a
 * Redis-backed one (`rate-limit-redis` + a Redis instance) — at which point the cost of
 * running Redis is justified by an actual, observed need rather than spent upfront on a
 * single-instance VPS that doesn't have the problem.
 *
 * ---------------------------------------------------------------------------
 * Trust proxy — IP-based limiting needs the REAL client IP
 * ---------------------------------------------------------------------------
 *
 * Rate-limiting by IP is meaningless if every request appears to originate from
 * Nginx's loopback connection (`127.0.0.1`) — every client would share one bucket.
 * `app.set('trust proxy', 1)` (already configured in `app.ts` — see the comment at its
 * registration site) tells Express to read the real client IP from the first hop of
 * `X-Forwarded-For`, which `express-rate-limit`'s default `keyGenerator` then uses.
 * This requires Nginx to actually be configured to forward that header — confirm the
 * deployed reverse-proxy config (architecture.md §11) includes
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (and
 * `X-Real-IP`/`Host` as is conventional) on the `/api/*` location block. Without that,
 * `trust proxy` has nothing useful to trust.
 *
 * ---------------------------------------------------------------------------
 * Response shape
 * ---------------------------------------------------------------------------
 *
 * On exceeding the limit, express-rate-limit's default behaviour is to send its own
 * plain-text/JSON body — which would break the API-wide `{ error: { code, message } }`
 * convention (architecture.md §8). The `handler` option lets us override that: we
 * forward a `tooManyRequests()` `AppError` to `next()`, so the request flows through
 * the SAME central error handler (`app.ts`) as every other `AppError`, producing
 * `{ error: { code: 'RATE_LIMITED', message } }` with a `429` status — one error
 * pipeline, no parallel response-shaping logic to keep in sync.
 */
import type { NextFunction, Request, Response } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';

import { tooManyRequests } from '../lib/errors';

/**
 * The subset of `express-rate-limit`'s `Options` that callers are expected to tune
 * per-route. `windowMs` and `max` are the two values that meaningfully differ between
 * e.g. login (tight — brute-force defense) and RSVP (looser — legitimate bursts around
 * event announcements, plus honeypot/bot defense per architecture.md §12). Anything
 * else is an intentionally narrow escape hatch for a future route with unusual needs
 * (e.g. a custom `keyGenerator`) without having to widen this type for everyone.
 */
export type RateLimiterOptions = Pick<
  Partial<Options>,
  'windowMs' | 'max' | 'keyGenerator' | 'skip'
> & {
  /** Window length in milliseconds during which requests are counted. Required — there
   * is no sane API-wide default; each route's abuse profile dictates its own window. */
  windowMs: number;
  /** Maximum number of requests a single client may make within `windowMs` before
   * being rate-limited. Required for the same reason as `windowMs`. */
  max: number;
  /** Optional human-readable detail surfaced in the `429` response's `error.message` —
   * defaults to a generic "try again later" if omitted. Override per-route to give
   * callers a more specific hint (e.g. "Too many login attempts — try again in 15
   * minutes"). */
  message?: string;
};

/**
 * Builds an Express rate-limiting middleware tuned to a single route's needs.
 *
 * Usage (Phase 3 / Phase 4 — NOT wired up yet, this factory only):
 *   router.post('/auth/login',
 *     rateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'Too many login attempts — try again later' }),
 *     validate({ body: loginSchema }),
 *     loginHandler,
 *   );
 *
 * Deliberately uses the library's default in-memory `MemoryStore` (see file-header
 * "DECISION" note) and the default IP-based `keyGenerator`, which relies on
 * `app.set('trust proxy', 1)` already being configured (see file-header "Trust proxy"
 * note) to see the real client IP behind Nginx.
 */
export function rateLimiter(options: RateLimiterOptions) {
  const { windowMs, max, message, keyGenerator, skip } = options;

  return rateLimit({
    windowMs,
    max,
    // Standard `RateLimit-*` headers (RFC draft) so well-behaved clients can see their
    // remaining quota and back off proactively; legacy `X-RateLimit-*` headers add
    // nothing on top and are off to keep response headers minimal.
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(skip ? { skip } : {}),
    // Forward an `AppError` so the central error handler in `app.ts` produces the
    // project-standard `{ error: { code: 'RATE_LIMITED', message } }` shape — see
    // file-header "Response shape" note. `next` deliberately ignores `_request`/
    // `_response`/`_optionsUsed`: everything needed to build the response lives on
    // the `AppError` itself.
    handler: (_request: Request, _response: Response, next: NextFunction) => {
      next(tooManyRequests(message));
    },
  });
}
