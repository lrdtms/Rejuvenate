/**
 * Integration-style checks for the global middleware wired up in `createApp()`
 * (Phase 2 — plan.md "Backend Application Skeleton"). Cheap supertest assertions
 * against the real app factory rather than unit-testing each middleware in
 * isolation: the thing we actually care about is "does a request to this app get
 * cookie parsing / CORS headers / trust-proxy behaviour", which is an integration
 * concern by nature.
 *
 * Deliberately NOT covered here (out of scope for this task / better tested
 * elsewhere): helmet header *contents* (library's own test suite covers that),
 * the /healthz DB check (covered when the auth/db modules land), and the error
 * handler (pre-existing, untouched by this change).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app';
import { env } from './config/env';

describe('createApp() — global middleware (Phase 2)', () => {
  describe('CORS', () => {
    it('reflects the allow-listed origin and allows credentials on a simple request', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/healthz').set('Origin', env.CORS_ALLOWED_ORIGIN);

      expect(res.headers['access-control-allow-origin']).toBe(env.CORS_ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      // Never the wildcard — credentialed CORS requires an explicit origin.
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('responds to a credentialed preflight request for the allow-listed origin', async () => {
      const app = createApp();

      const res = await request(app)
        .options('/api/v1/healthz')
        .set('Origin', env.CORS_ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['access-control-allow-origin']).toBe(env.CORS_ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not echo back an arbitrary, non-allow-listed origin', async () => {
      const app = createApp();

      const res = await request(app)
        .get('/api/v1/healthz')
        .set('Origin', 'https://evil.example.org');

      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.org');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });
  });

  describe('cookie parsing', () => {
    it('parses incoming cookies onto req.cookies for downstream handlers', async () => {
      // Mount a throwaway probe route (via the test-only seam — see CreateAppOptions)
      // that proves `req.cookies` is populated. The auth module (Phase 3) is what
      // actually consumes this, but cookie-parser is wired globally now per plan.md
      // step 2, so we assert the cross-cutting behaviour here rather than waiting
      // for a real cookie-reading route to exist.
      const app = createApp({
        mountForTesting: (router) => {
          router.get('/__test/cookies', (req, res) => {
            res.json({ cookies: req.cookies });
          });
        },
      });

      const res = await request(app)
        .get('/api/v1/__test/cookies')
        .set('Cookie', 'foo=bar; baz=qux');

      expect(res.body.cookies).toEqual({ foo: 'bar', baz: 'qux' });
    });
  });

  describe('trust proxy', () => {
    it('is configured so Express derives the client IP from X-Forwarded-For', () => {
      const app = createApp();

      // `app.get('trust proxy fn')` returns the predicate Express derived from the
      // setting. With `app.set('trust proxy', 1)`, exactly one proxy hop is trusted —
      // assert the setting took effect rather than re-deriving Express's own logic.
      expect(app.get('trust proxy')).toBe(1);
    });
  });

  describe('request logging', () => {
    it('attaches a per-request logger (req.log) without crashing on a request with a body', async () => {
      // The real assertion that bodies are never logged is structural (we configure
      // pino-http with its default serializers, which never include `req.body`/
      // `res.body` — see the comment in app.ts). Here we simply exercise a JSON POST
      // through the full middleware chain (cors -> cookies -> json -> pino-http) to
      // prove nothing in that chain throws or hangs when a body is present, and that
      // each request gets its own logger instance attached by pino-http.
      const app = createApp({
        mountForTesting: (router) => {
          router.post('/__test/echo-log', (req, res) => {
            res.json({ hasLogger: typeof req.log?.info === 'function' });
          });
        },
      });

      const res = await request(app)
        .post('/api/v1/__test/echo-log')
        .set('Origin', env.CORS_ALLOWED_ORIGIN)
        .send({ email: 'someone@example.org', password: 'super-secret-value' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hasLogger: true });
    });
  });
});
