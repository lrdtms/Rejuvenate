/**
 * Integration-style checks for the global middleware wired up in `createApp()`
 * (Phase 2 — plan.md "Backend Application Skeleton"). Cheap supertest assertions
 * against the real app factory rather than unit-testing each middleware in
 * isolation: the thing we actually care about is "does a request to this app get
 * cookie parsing / CORS headers / trust-proxy behaviour", which is an integration
 * concern by nature.
 *
 * Deliberately NOT covered here (out of scope for this task / better tested
 * elsewhere): helmet header *contents* (library's own test suite covers that).
 * The error handler *is* covered below — see "request logging" — because its
 * interaction with `pino-http`'s registration order/redaction is the crux of a
 * real defect this suite now guards against (a malformed body bypassing both
 * the access log and the redaction pipeline).
 *
 * The `/healthz` DB-timeout behaviour (plan.md Phase 2 step 5/7) is covered in
 * its own `describe` block below via `vi.spyOn(db, '$queryRaw')` — see that
 * block's comment for why spying on the shared Prisma singleton is the right
 * seam here (no dedicated mocking infrastructure exists yet, and standing one
 * up purely for one test would be more machinery than the assertion warrants).
 */
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app';
import { env } from './config/env';
import { db } from './lib/db';

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

    it('still attaches req.log and reaches the central error handler when the body fails to parse', async () => {
      // Regression test for a real defect: `pinoHttp` was originally registered
      // *after* `cors`/`cookieParser`/`express.json()`, so a request that errors
      // during body-parsing (e.g. malformed JSON on a POST) skipped it entirely —
      // zero structured access-log line for exactly the kind of request (a broken
      // RSVP/login submission) most worth auditing. Worse, such requests fell
      // through to the central error handler's `console.error('Unhandled error:',
      // err)`, and body-parser's `SyntaxError` carries the *raw, unredacted request
      // body* as `err.body` — so the raw POST body was being dumped straight to
      // stdout, completely bypassing the redaction this commit was meant to
      // establish.
      //
      // `pino-http` is silenced in tests (`level: 'silent'`) so we can't assert on
      // the emitted log line's contents directly here without a logger-injection
      // seam that would meaningfully complicate this harness (see CreateAppOptions).
      // Instead we assert the two things that actually matter and that *would*
      // regress if the registration order slipped again:
      //   1. `req.log` is populated for the request that hit the parse error (proven
      //      indirectly: `req.log.error(...)` in the error handler must not throw —
      //      if pino-http hadn't run, `req.log` would be `undefined` and the handler
      //      itself would crash, surfacing as a hung/500-less response here).
      //   2. The raw request body never reaches `console.error` (or any other
      //      console sink) — i.e. the leak is closed regardless of *how* it's logged.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/__nonexistent_route_for_malformed_body_test')
          .set('Content-Type', 'application/json')
          .send('{not valid json');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
        });

        // The raw malformed body must never be handed to console.error (or printed
        // at all) — assert across every call and every argument, not just the
        // "Unhandled error" call site, so this stays a true regression guard even if
        // the handler's call site/message changes later.
        for (const call of consoleErrorSpy.mock.calls) {
          for (const arg of call) {
            const serialized = typeof arg === 'string' ? arg : JSON.stringify(arg);
            expect(serialized).not.toContain('{not valid json');
          }
        }
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('/healthz', () => {
    // `db` is the shared Prisma singleton imported by `app.ts` (see `lib/db.ts`) — no
    // real Postgres is required for these assertions, and standing up a test database
    // purely to prove "a slow query times out" would be solving the wrong problem.
    // `vi.spyOn` against the singleton's `$queryRaw` method is the narrowest possible
    // seam: it leaves the rest of `createApp()`'s wiring untouched and is restored
    // after every test so other suites that exercise `/healthz` (e.g. the CORS checks
    // above, which hit it as an arbitrary GET target) keep seeing real behaviour.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('responds 200 {status: "ok", db: "up"} when the DB query succeeds', async () => {
      vi.spyOn(db, '$queryRaw').mockResolvedValue([{ '?column?': 1 }]);

      const app = createApp();
      const res = await request(app).get('/api/v1/healthz');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', db: 'up' });
    });

    it('responds 503 {status: "degraded", db: "down"} when the DB query rejects', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db, '$queryRaw').mockRejectedValue(new Error('connection refused'));

      const app = createApp();
      const res = await request(app).get('/api/v1/healthz');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded', db: 'down' });

      consoleErrorSpy.mockRestore();
    });

    it('responds 503 {status: "degraded", db: "down"} within a bounded time when the DB query hangs', async () => {
      // Regression guard for the exact defect plan.md step 5 calls out: "a /healthz
      // that always returns 200 regardless of DB state is worse than no health
      // check" — and symmetrically, a /healthz that *hangs* forever waiting on a
      // wedged connection is just as useless to deploy tooling/uptime monitors as
      // one that lies. Stub `$queryRaw` with a promise that never resolves (a
      // faithful stand-in for a hung connection: the call returns, but its result
      // never arrives) and assert the route still answers — and answers quickly,
      // i.e. driven by `HEALTHZ_DB_TIMEOUT_MS`'s race rather than by the stub ever
      // settling.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db, '$queryRaw').mockReturnValue(
        new Promise(() => {}) as unknown as ReturnType<typeof db.$queryRaw>,
      );

      const app = createApp();

      const startedAt = Date.now();
      const res = await request(app).get('/api/v1/healthz');
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'degraded', db: 'down' });
      // Bounded comfortably above HEALTHZ_DB_TIMEOUT_MS (2_500ms) to absorb test-runner
      // scheduling jitter, while still proving this resolved via the timeout race
      // rather than hanging for the test's full default timeout (5s) or longer.
      expect(elapsedMs).toBeLessThan(4_500);

      consoleErrorSpy.mockRestore();
    });
  });
});
