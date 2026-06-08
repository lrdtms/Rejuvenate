/**
 * Integration tests for the auth module's routes (plan.md Phase 3 step 4),
 * exercised through the REAL `createApp()` — sessions, rate limiting,
 * validation, the central error handler, and `AuthService` (itself wired to
 * the real local Postgres + a `ConsoleMailService`) all run for real, exactly
 * as `session.test.ts`/`rateLimit.test.ts`/`validate.test.ts` do for their
 * respective concerns. This is deliberately the RIGHT layer to test "does
 * `POST /auth/login` actually mint a working session cookie and `GET /me`
 * recognize it" — that question cannot be answered by unit-testing
 * `AuthService` and `rbac.ts` in isolation (covered in their own suites);
 * it's the WIRING between them that matters here.
 *
 * Uses `supertest.agent(app)` (not bare `request(app)`) wherever a flow spans
 * more than one request and depends on the session cookie persisting between
 * them (login -> /me -> logout) — `agent` keeps a cookie jar across calls,
 * exactly like a browser tab would.
 *
 * Real argon2id hashing is in the loop (via `AuthService`/`password.ts`) for
 * every test that creates a user or logs in — generous per-test timeouts
 * mirror `password.test.ts`/`auth.service.test.ts`.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword } from './password';
import { PASSWORD_RESET_REQUEST_ACK_MESSAGE } from './auth.service';
import { SESSION_COOKIE_NAME } from './session';

const AUTH_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple 42';

function uniqueTestEmail(label: string): string {
  return `auth-router-test-${label}-${randomUUID()}@example.invalid`;
}

let createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive?: boolean;
  password?: string;
}) {
  const { label, role = 'BLOGGER', isActive = true, password = TEST_PASSWORD } = opts;
  const email = uniqueTestEmail(label);
  const passwordHash = await hashPassword(password);
  const created = await db.user.create({
    data: { name: `Router Test User (${label})`, email, passwordHash, role, isActive },
  });
  createdUserIds.push(created.id);
  return created;
}

/** Pulls the session cookie out of a supertest response (mirrors session.test.ts). */
function findSessionCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
}

describe('auth router (plan.md Phase 3 step 4)', () => {
  describe('POST /auth/login', () => {
    it(
      'succeeds with valid credentials: 200, returns the safe user shape, and issues a session cookie',
      async () => {
        const app = createApp();
        const user = await createTestUser({ label: 'login-ok' });

        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            isActive: true,
          },
        });
        expect(res.body.user).not.toHaveProperty('passwordHash');

        const cookie = findSessionCookie(res);
        expect(cookie).toBeDefined();
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects bad credentials with 401 UNAUTHORIZED in the standard error shape',
      async () => {
        const app = createApp();
        const user = await createTestUser({ label: 'login-bad-password' });

        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: 'totally-wrong-password' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a deactivated account with the same 401 shape as bad credentials',
      async () => {
        const app = createApp();
        const user = await createTestUser({ label: 'login-deactivated', isActive: false });

        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it('rejects a malformed body with 400 VALIDATION_ERROR carrying field-level detail', async () => {
      const app = createApp();

      const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toHaveProperty('email');
      expect(res.body.error.fields).toHaveProperty('password');
    });

    it(
      'establishes a session that GET /me recognizes as the logged-in user',
      async () => {
        const app = createApp();
        const agent = request.agent(app);
        const user = await createTestUser({ label: 'login-then-me', role: 'ADMIN' });

        const loginRes = await agent
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD });
        expect(loginRes.status).toBe(200);

        const meRes = await agent.get('/api/v1/me');
        expect(meRes.status).toBe(200);
        expect(meRes.body).toEqual({
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: 'ADMIN',
            isActive: true,
          },
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );
  });

  describe('GET /me', () => {
    it('returns { user: null } (200, not 401) for an anonymous caller', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/me');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user: null });
    });

    it(
      'returns { user: null } once the logged-in account is deactivated mid-session ' +
        '(the per-request isActive re-check — "deactivation takes effect immediately")',
      async () => {
        const app = createApp();
        const agent = request.agent(app);
        const user = await createTestUser({ label: 'me-deactivated-midsession' });

        const loginRes = await agent
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD });
        expect(loginRes.status).toBe(200);

        const meBefore = await agent.get('/api/v1/me');
        expect(meBefore.body.user?.id).toBe(user.id);

        await db.user.update({ where: { id: user.id }, data: { isActive: false } });

        const meAfter = await agent.get('/api/v1/me');
        expect(meAfter.status).toBe(200);
        expect(meAfter.body).toEqual({ user: null });
      },
      AUTH_TEST_TIMEOUT_MS,
    );
  });

  describe('POST /auth/logout', () => {
    it(
      'destroys the session: subsequent GET /me reports anonymous, and is itself idempotent',
      async () => {
        const app = createApp();
        const agent = request.agent(app);
        const user = await createTestUser({ label: 'logout-flow' });

        await agent.post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
        expect((await agent.get('/api/v1/me')).body.user?.id).toBe(user.id);

        const logoutRes = await agent.post('/api/v1/auth/logout');
        expect(logoutRes.status).toBe(204);

        expect((await agent.get('/api/v1/me')).body).toEqual({ user: null });

        // Idempotent — logging out again (already-logged-out) is still a
        // clean success, not an error (see auth.router.ts's "no-op" note).
        const secondLogout = await agent.post('/api/v1/auth/logout');
        expect(secondLogout.status).toBe(204);
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it('succeeds (204) for a caller with no session at all', async () => {
      const app = createApp();

      const res = await request(app).post('/api/v1/auth/logout');

      expect(res.status).toBe(204);
    });
  });

  describe('POST /auth/password-reset/request — enumeration safety', () => {
    it(
      'responds 200 with the identical generic acknowledgement for an existing account',
      async () => {
        const app = createApp();
        const user = await createTestUser({ label: 'reset-request-existing' });

        const res = await request(app)
          .post('/api/v1/auth/password-reset/request')
          .send({ email: user.email });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'responds 200 with the LITERALLY IDENTICAL status, body, and shape for a nonexistent account ' +
        '(account-enumeration safety — the property the brief requires a test for)',
      async () => {
        const app = createApp();
        const user = await createTestUser({ label: 'reset-request-compare-existing' });
        const nonexistentEmail = uniqueTestEmail('reset-request-compare-nonexistent');

        const [existingRes, nonexistentRes] = await Promise.all([
          request(app).post('/api/v1/auth/password-reset/request').send({ email: user.email }),
          request(app)
            .post('/api/v1/auth/password-reset/request')
            .send({ email: nonexistentEmail }),
        ]);

        expect(existingRes.status).toBe(nonexistentRes.status);
        expect(existingRes.status).toBe(200);
        expect(existingRes.body).toEqual(nonexistentRes.body);
        expect(existingRes.body).toEqual({ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it('rejects a malformed body with 400 VALIDATION_ERROR', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toHaveProperty('email');
    });
  });

  describe('POST /auth/password-reset/confirm', () => {
    it('rejects an unknown token with a generic 401 (not 404 — no enumeration of token validity)', async () => {
      const app = createApp();

      const res = await request(app).post('/api/v1/auth/password-reset/confirm').send({
        token: 'completely-made-up-token-value-1234567890',
        newPassword: 'a perfectly fine new password 123',
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'This password reset link is invalid or has expired.',
        },
      });
    });

    it('rejects a too-short new password with 400 VALIDATION_ERROR before ever consulting the token', async () => {
      const app = createApp();

      const res = await request(app).post('/api/v1/auth/password-reset/confirm').send({
        token: 'irrelevant-token-value',
        newPassword: 'short',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toHaveProperty('newPassword');
    });
  });

  describe('rate limiting (architecture.md §12 — login and password-reset are rate-limited)', () => {
    it('eventually responds 429 RATE_LIMITED for repeated login attempts from one IP+email combo', async () => {
      const app = createApp();
      const user = await createTestUser({ label: 'rate-limit-login' });

      let limited: request.Response | undefined;
      // LOGIN_RATE_LIMIT.max is 10 — issue one more than that to guarantee
      // we cross the threshold regardless of exact bucket bookkeeping.
      for (let i = 0; i < 11 && !limited; i += 1) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: user.email, password: 'wrong-on-purpose' });
        if (res.status === 429) {
          limited = res;
        }
      }

      expect(limited).toBeDefined();
      expect(limited?.body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many login attempts — please try again in a few minutes',
        },
      });
    }, 60_000);

    it('eventually responds 429 RATE_LIMITED for repeated password-reset requests from one IP+email combo', async () => {
      const app = createApp();
      const email = uniqueTestEmail('rate-limit-reset');

      let limited: request.Response | undefined;
      // PASSWORD_RESET_REQUEST_RATE_LIMIT.max is 5.
      for (let i = 0; i < 6 && !limited; i += 1) {
        const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email });
        if (res.status === 429) {
          limited = res;
        }
      }

      expect(limited).toBeDefined();
      expect(limited?.body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many password reset requests — please try again later',
        },
      });
    }, 60_000);
  });
});
