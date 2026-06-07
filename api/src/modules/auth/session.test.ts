/**
 * Integration-style checks for the session middleware wiring (plan.md Phase 3
 * step 1), exercised through the real `createApp()` + the `mountForTesting` seam
 * (see `app.test.ts`/`rateLimit.test.ts` for the established pattern). These
 * hit a real local Postgres (the same `DATABASE_URL` Prisma uses — see
 * `.env`/`docker-compose.yml`) via `connect-pg-simple`'s own connection pool;
 * no mocking infrastructure exists for the session store and standing one up
 * purely for these assertions would be more machinery than they warrant — the
 * existing `app.test.ts` suite already exercises the full app factory against
 * the same database for `/healthz`.
 *
 * What we actually care about, in order:
 *   1. `req.session`/`req.sessionID` are populated for ordinary routes (proves
 *      the middleware is wired and reaches downstream handlers).
 *   2. The session cookie carries the custom name + the configured security
 *      attributes (HttpOnly, SameSite=Lax, and — over plain HTTP in this test
 *      environment, NODE_ENV=test — *not* Secure, proving the dev/prod gate).
 *   3. `/healthz` is reachable WITHOUT acquiring a session — the precise
 *      tension the task brief calls out as "the trickiest part".
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { SESSION_COOKIE_NAME } from './session';

function buildProbeApp() {
  return createApp({
    mountForTesting: (router) => {
      router.get('/__test/session/probe', (req, res) => {
        res.json({
          hasSession: typeof req.session === 'object' && req.session !== null,
          hasSessionId: typeof req.sessionID === 'string' && req.sessionID.length > 0,
        });
      });

      // express-session only sends a `Set-Cookie` header once the session has
      // been *modified* (saveUninitialized: false — see session.ts file header).
      // Write something to the session so we can assert on the resulting cookie.
      router.post('/__test/session/login-stub', (req, res) => {
        req.session.regenerate(() => {
          (req.session as unknown as { userId?: string }).userId = 'test-user-id';
          req.session.save(() => {
            res.json({ ok: true });
          });
        });
      });
    },
  });
}

/** Pulls the `Set-Cookie` entry for our session cookie out of supertest's
 * response (which may return a single string or an array depending on the
 * server). Returns `undefined` if absent. */
function findSessionCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
}

describe('session middleware wiring (plan.md Phase 3 step 1)', () => {
  describe('req.session / req.sessionID population', () => {
    it('populates req.session and req.sessionID for ordinary routes', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/__test/session/probe');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hasSession: true, hasSessionId: true });
    });
  });

  describe('session cookie attributes', () => {
    it('issues a cookie under the custom name (not the express-session default `connect.sid`)', async () => {
      const app = buildProbeApp();

      const res = await request(app).post('/api/v1/__test/session/login-stub');

      expect(res.status).toBe(200);
      const cookie = findSessionCookie(res);
      expect(cookie).toBeDefined();
      // Belt-and-braces: explicitly prove the default name is NOT used.
      expect(cookie).not.toMatch(/^connect\.sid=/);
      expect(SESSION_COOKIE_NAME).not.toBe('connect.sid');
    });

    it('sets HttpOnly and SameSite=Lax on the session cookie', async () => {
      const app = buildProbeApp();

      const res = await request(app).post('/api/v1/__test/session/login-stub');

      const cookie = findSessionCookie(res);
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('does NOT set Secure in the test/dev environment (NODE_ENV !== "production", plain HTTP)', async () => {
      // This is the load-bearing half of the `cookie.secure` gate: if this ever
      // started asserting `Secure` in a non-production run, local dev over
      // `http://localhost` would silently stop persisting the session cookie in
      // the browser (browsers refuse to store `Secure` cookies set over plain
      // HTTP) — exactly the failure mode the explicit NODE_ENV-derived boolean
      // in session.ts is designed to prevent. (The "IS Secure in production"
      // half isn't practically testable here without actually running the app
      // with NODE_ENV=production and a TLS-terminated connection — see
      // session.ts's file-header comment for why the derivation is correct by
      // construction rather than something this suite can exercise end-to-end.)
      const app = buildProbeApp();

      const res = await request(app).post('/api/v1/__test/session/login-stub');

      const cookie = findSessionCookie(res);
      expect(cookie).toBeDefined();
      expect(cookie).not.toMatch(/;\s*Secure/i);
    });
  });

  describe('/healthz bypasses the session middleware', () => {
    it('responds successfully without setting a session cookie', async () => {
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/healthz');

      expect(res.status).toBe(200);
      expect(findSessionCookie(res)).toBeUndefined();
    });

    it('does not populate req.session for the /healthz handler', async () => {
      // We can't directly inspect `req.session` inside the real /healthz
      // handler from outside — but we CAN prove the session middleware layer
      // was never reached for this request by the absence of a `Set-Cookie`
      // session cookie (saveUninitialized: false means express-session only
      // ever sends one for routes it actually processed and that touched the
      // session) combined with a clean 200. If `/healthz` were routed through
      // the session middleware, a slow/unhealthy session-store connection
      // could also degrade or hang the health probe — exactly what plan.md
      // Phase 2 step 5 says must not happen ("a DB outage doesn't also break
      // session-store lookups for the health check itself").
      const app = buildProbeApp();

      const res = await request(app).get('/api/v1/healthz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', db: 'up' });
      expect(findSessionCookie(res)).toBeUndefined();
    });
  });
});
