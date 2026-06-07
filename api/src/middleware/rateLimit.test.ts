/**
 * Integration-style checks for the `rateLimiter()` middleware factory (plan.md
 * Phase 2 step 7), exercised through the real `createApp()` + the `mountForTesting`
 * seam (see `app.test.ts` for the established pattern) — what we actually care about
 * is "does a request that exceeds the configured limit, through the real middleware
 * chain, end up with the agreed `{ error: { code: 'RATE_LIMITED', message } }` shape
 * and a `429` status", which depends on the central error handler in `app.ts`
 * correctly translating the `tooManyRequests()` `AppError` forwarded by the
 * limiter's custom `handler`.
 *
 * Deliberately NOT covered here: the in-memory store's reset-on-restart behaviour
 * (that's a deployment-topology fact documented in `rateLimit.ts`'s file header, not
 * something a unit/integration test can meaningfully assert against) and
 * `X-Forwarded-For`-driven IP derivation (covered by `app.test.ts`'s "trust proxy"
 * block — `rateLimiter()` relies on the same `app.set('trust proxy', 1)` rather than
 * configuring its own).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { rateLimiter } from './rateLimit';

function buildProbeApp(limiterOptions: Parameters<typeof rateLimiter>[0]) {
  return createApp({
    mountForTesting: (router) => {
      router.get('/__test/rate-limited', rateLimiter(limiterOptions), (_req, res) => {
        res.json({ ok: true });
      });
    },
  });
}

describe('rateLimiter() middleware factory', () => {
  it('allows requests within the configured limit through', async () => {
    const app = buildProbeApp({ windowMs: 60_000, max: 2 });

    const first = await request(app).get('/api/v1/__test/rate-limited');
    const second = await request(app).get('/api/v1/__test/rate-limited');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true });
  });

  it('responds 429 RATE_LIMITED in the project error shape once the limit is exceeded', async () => {
    const app = buildProbeApp({ windowMs: 60_000, max: 1 });

    const allowed = await request(app).get('/api/v1/__test/rate-limited');
    const limited = await request(app).get('/api/v1/__test/rate-limited');

    expect(allowed.status).toBe(200);

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests — please try again later',
      },
    });
  });

  it('surfaces a custom message in error.message when one is configured', async () => {
    const app = buildProbeApp({
      windowMs: 60_000,
      max: 1,
      message: 'Too many login attempts — try again in 15 minutes',
    });

    await request(app).get('/api/v1/__test/rate-limited');
    const limited = await request(app).get('/api/v1/__test/rate-limited');

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many login attempts — try again in 15 minutes',
      },
    });
  });

  it('keeps separate clients (by IP) on independent quotas', async () => {
    const app = buildProbeApp({ windowMs: 60_000, max: 1 });

    const clientA = await request(app)
      .get('/api/v1/__test/rate-limited')
      .set('X-Forwarded-For', '203.0.113.10');
    const clientB = await request(app)
      .get('/api/v1/__test/rate-limited')
      .set('X-Forwarded-For', '203.0.113.20');

    // Both are each client's *first* request — neither should be limited, proving
    // the key is derived per-client (via the real IP, behind `trust proxy`) rather
    // than shared across every request the process sees.
    expect(clientA.status).toBe(200);
    expect(clientB.status).toBe(200);
  });
});
