/**
 * Unit/integration tests for `AuthService` (plan.md Phase 3 step 3).
 *
 * Exercised against the REAL local Postgres (the same `DATABASE_URL` Prisma
 * uses — see `session.test.ts` for the established "no mocking infrastructure
 * exists for the database; standing one up purely for these assertions would
 * be more machinery than they warrant" rationale, which applies identically
 * here). Each test creates its own throwaway user(s) with a unique,
 * randomly-suffixed email (avoiding collisions across parallel test files /
 * runs against a shared dev database) and cleans them up in `afterEach` —
 * mirroring the "tests own their fixtures, tests clean up after themselves"
 * discipline a shared dev DB demands.
 *
 * `MailService` IS mocked — a tiny in-memory recording fake (`RecordingMailService`)
 * substituted via `createAuthService`'s dependency-injection seam (see that
 * file's "why an interface + factory" note in `mail.service.ts`). This lets
 * the password-reset tests assert on exactly what WOULD have been sent
 * (recipient, subject, and — critically — that the email body contains the
 * raw token) without spinning up a real mail provider or scraping log output.
 *
 * Argon2id hashing (`hashPassword`/`verifyPassword`, used internally by
 * `login`/`confirmPasswordReset`) is the REAL pinned implementation — same
 * "don't fake the thing you're trying to prove is secure" posture as
 * `password.test.ts`, with the same generous per-test timeout to absorb its
 * deliberately-slow, memory-hard cost.
 */
import { createHash, randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';

import { db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { hashPassword } from './password';
import type { MailMessage, MailService } from './mail.service';
import {
  createAuthService,
  generateRawResetToken,
  PASSWORD_RESET_REQUEST_ACK_MESSAGE,
  type AuthService,
} from './auth.service';

// argon2id hashing at the pinned parameters takes real wall-clock time
// (memory-hard by design — see password.ts) — every test that creates a user
// or completes a reset performs at least one hash/verify round trip. Generous
// bound mirrors password.test.ts's HASH_TEST_TIMEOUT_MS.
const AUTH_TEST_TIMEOUT_MS = 20_000;

const TEST_PASSWORD = 'correct horse battery staple 42';

/** Tiny in-memory `MailService` fake — records every message it would have
 * sent, in order, so tests can assert on exactly what was (or, for the
 * enumeration-safety test, was NOT) dispatched. See file-header note. */
class RecordingMailService implements MailService {
  public readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Builds a unique, collision-free test-user email so parallel runs / repeat
 * runs against a shared dev database never collide on the `@unique` column. */
function uniqueTestEmail(label: string): string {
  return `auth-service-test-${label}-${randomUUID()}@example.invalid`;
}

const silentLogger = pino({ level: 'silent' });

interface TestUserOptions {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive?: boolean;
  password?: string;
}

async function createTestUser(options: TestUserOptions) {
  const { label, role = 'BLOGGER', isActive = true, password = TEST_PASSWORD } = options;
  const email = uniqueTestEmail(label);
  const passwordHash = await hashPassword(password);

  return db.user.create({
    data: {
      name: `Test User (${label})`,
      email,
      passwordHash,
      role,
      isActive,
    },
  });
}

describe('AuthService (plan.md Phase 3 step 3)', () => {
  let mailService: RecordingMailService;
  let authService: AuthService;
  // Every user id created by a test, for blanket cleanup in `afterEach` —
  // simpler and more robust than each test remembering its own teardown
  // (and correctly handles tests that create more than one user).
  let createdUserIds: string[];

  beforeEach(() => {
    mailService = new RecordingMailService();
    authService = createAuthService({ db, mailService, logger: silentLogger });
    createdUserIds = [];
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) {
      return;
    }
    // `password_reset_tokens` cascades on user delete (see schema.prisma's
    // decision record — onDelete: Cascade) so deleting the user is sufficient
    // to clean up everything this suite creates.
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  async function user(options: TestUserOptions) {
    const created = await createTestUser(options);
    createdUserIds.push(created.id);
    return created;
  }

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------
  describe('login', () => {
    it(
      'succeeds for correct credentials on an active account, returning a safe user shape',
      async () => {
        const created = await user({ label: 'login-success', role: 'ADMIN' });

        const result = await authService.login(created.email, TEST_PASSWORD);

        expect(result).toEqual({
          id: created.id,
          name: created.name,
          email: created.email,
          role: 'ADMIN',
          isActive: true,
        });
        // Never leaks the password hash through the service boundary.
        expect(result).not.toHaveProperty('passwordHash');
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a wrong password with the generic INVALID_CREDENTIALS message',
      async () => {
        const created = await user({ label: 'login-wrong-password' });

        await expect(
          authService.login(created.email, 'definitely-the-wrong-password'),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a nonexistent email with the SAME generic message as a wrong password (account-enumeration safety)',
      async () => {
        await expect(
          authService.login(uniqueTestEmail('login-nonexistent'), 'whatever-password'),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a deactivated account with the SAME generic message, even given the correct password ' +
        '(isActive enforcement at login — half 1 of 2, see auth.service.ts file header)',
      async () => {
        const created = await user({ label: 'login-deactivated', isActive: false });

        await expect(authService.login(created.email, TEST_PASSWORD)).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Invalid email or password',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'every failure mode throws the literal same AppError shape (status, code, AND message) — ' +
        'proving none is distinguishable from another',
      async () => {
        const deactivated = await user({ label: 'login-matrix-deactivated', isActive: false });
        const active = await user({ label: 'login-matrix-active' });

        const outcomes = await Promise.allSettled([
          authService.login(uniqueTestEmail('login-matrix-nonexistent'), 'x'),
          authService.login(active.email, 'wrong-password-entirely'),
          authService.login(deactivated.email, TEST_PASSWORD),
        ]);

        for (const outcome of outcomes) {
          expect(outcome.status).toBe('rejected');
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toBeInstanceOf(AppError);
            expect(outcome.reason).toMatchObject({
              statusCode: 401,
              code: 'UNAUTHORIZED',
              message: 'Invalid email or password',
            });
          }
        }
      },
      AUTH_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------
  describe('logout', () => {
    it('deletes the named session row from the connect-pg-simple session table', async () => {
      const sid = `auth-service-test-logout-${randomUUID()}`;

      // Seed a fake session row directly — connect-pg-simple's expected shape
      // (sid/sess/expire). We don't need a real express-session round trip to
      // prove `AuthService.logout` issues the right DELETE.
      await db.$executeRaw`INSERT INTO "session" ("sid", "sess", "expire")
        VALUES (${sid}, '{}'::json, NOW() + INTERVAL '1 hour')`;

      const before = await db.$queryRaw<
        { sid: string }[]
      >`SELECT "sid" FROM "session" WHERE "sid" = ${sid}`;
      expect(before).toHaveLength(1);

      await authService.logout(sid);

      const after = await db.$queryRaw<
        { sid: string }[]
      >`SELECT "sid" FROM "session" WHERE "sid" = ${sid}`;
      expect(after).toHaveLength(0);
    });

    it('is a no-op (resolves successfully) for a session id that does not exist — idempotent logout', async () => {
      await expect(authService.logout(`nonexistent-${randomUUID()}`)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentUser
  // -------------------------------------------------------------------------
  describe('getCurrentUser', () => {
    it('returns the safe user shape for an active user id', async () => {
      const created = await user({ label: 'get-current-active', role: 'EVENT_MANAGER' });

      const result = await authService.getCurrentUser(created.id);

      expect(result).toEqual({
        id: created.id,
        name: created.name,
        email: created.email,
        role: 'EVENT_MANAGER',
        isActive: true,
      });
    });

    it('returns null for a nonexistent user id', async () => {
      await expect(authService.getCurrentUser(randomUUID())).resolves.toBeNull();
    });

    it(
      'returns null for a deactivated user — the per-request half of "deactivation takes effect ' +
        'immediately" (isActive enforcement, half 2 of 2)',
      async () => {
        const created = await user({ label: 'get-current-deactivated', isActive: false });

        await expect(authService.getCurrentUser(created.id)).resolves.toBeNull();
      },
    );

    it(
      're-reads the user fresh on every call — a user deactivated AFTER an initial successful ' +
        'lookup is rejected on the very next call (proves no stale/cached snapshot)',
      async () => {
        const created = await user({ label: 'get-current-live-reread' });

        const before = await authService.getCurrentUser(created.id);
        expect(before).not.toBeNull();
        expect(before?.isActive).toBe(true);

        await db.user.update({ where: { id: created.id }, data: { isActive: false } });

        const after = await authService.getCurrentUser(created.id);
        expect(after).toBeNull();
      },
    );
  });

  // -------------------------------------------------------------------------
  // requestPasswordReset — the enumeration-safety contract
  // -------------------------------------------------------------------------
  describe('requestPasswordReset', () => {
    it(
      'for an existing active account: persists a token, sends a reset email containing a raw token, ' +
        'and returns the generic acknowledgement',
      async () => {
        const created = await user({ label: 'reset-request-existing' });

        const result = await authService.requestPasswordReset(created.email);

        expect(result).toEqual({ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE });

        expect(mailService.sent).toHaveLength(1);
        expect(mailService.sent[0]?.to).toBe(created.email);
        expect(mailService.sent[0]?.subject).toMatch(/reset/i);
        // The raw token must travel ONLY in the email body — never persisted
        // (see schema.prisma's PasswordResetToken decision record on
        // `tokenHash`). We can't know the exact token value from here, but we
        // can prove SOME non-trivial token-shaped string is present.
        expect(mailService.sent[0]?.text).toMatch(/[A-Za-z0-9_-]{32,}/);

        const tokens = await db.passwordResetToken.findMany({ where: { userId: created.id } });
        expect(tokens).toHaveLength(1);
        expect(tokens[0]?.usedAt).toBeNull();
        expect(tokens[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
        // The persisted value is a hash, not the raw token that went out in
        // the email — structurally distinct (64-hex-char SHA-256 digest).
        expect(tokens[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(tokens[0]?.tokenHash).not.toBe(mailService.sent[0]?.text);
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'for a nonexistent account: sends NO email, persists NO token, and returns the ' +
        'IDENTICAL generic acknowledgement (status/message enumeration-safety, dimension 1 of 2)',
      async () => {
        const email = uniqueTestEmail('reset-request-nonexistent');

        const result = await authService.requestPasswordReset(email);

        expect(result).toEqual({ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE });
        expect(mailService.sent).toHaveLength(0);

        const tokens = await db.passwordResetToken.findMany({
          where: { user: { email } },
        });
        expect(tokens).toHaveLength(0);
      },
    );

    it(
      'for a deactivated account: behaves identically to "nonexistent" (no email, no token, same ack) — ' +
        'closing the "deactivated accounts respond differently" enumeration variant',
      async () => {
        const created = await user({ label: 'reset-request-deactivated', isActive: false });

        const result = await authService.requestPasswordReset(created.email);

        expect(result).toEqual({ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE });
        expect(mailService.sent).toHaveLength(0);

        const tokens = await db.passwordResetToken.findMany({ where: { userId: created.id } });
        expect(tokens).toHaveLength(0);
      },
    );

    it(
      'returns the literal same { message } shape for an existing vs. a nonexistent account ' +
        '(dimension 2 of 2: the response is structurally indistinguishable)',
      async () => {
        const created = await user({ label: 'reset-request-shape-existing' });
        const nonexistentEmail = uniqueTestEmail('reset-request-shape-nonexistent');

        const [existingResult, nonexistentResult] = await Promise.all([
          authService.requestPasswordReset(created.email),
          authService.requestPasswordReset(nonexistentEmail),
        ]);

        expect(existingResult).toEqual(nonexistentResult);
        expect(Object.keys(existingResult)).toEqual(Object.keys(nonexistentResult));
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'issuing a second reset request supersedes (marks used) the first outstanding token for that account',
      async () => {
        const created = await user({ label: 'reset-request-supersede' });

        await authService.requestPasswordReset(created.email);
        const afterFirst = await db.passwordResetToken.findMany({ where: { userId: created.id } });
        expect(afterFirst).toHaveLength(1);
        const firstTokenId = afterFirst[0]?.id;

        await authService.requestPasswordReset(created.email);
        const afterSecond = await db.passwordResetToken.findMany({
          where: { userId: created.id },
          orderBy: { createdAt: 'asc' },
        });
        expect(afterSecond).toHaveLength(2);

        const first = afterSecond.find((t) => t.id === firstTokenId);
        const second = afterSecond.find((t) => t.id !== firstTokenId);
        expect(first?.usedAt).not.toBeNull(); // superseded
        expect(second?.usedAt).toBeNull(); // the live one
      },
      AUTH_TEST_TIMEOUT_MS,
    );
  });

  // -------------------------------------------------------------------------
  // confirmPasswordReset
  // -------------------------------------------------------------------------
  describe('confirmPasswordReset', () => {
    const NEW_PASSWORD = 'a brand new strong password 99';

    it(
      'with a valid, unused, unexpired token: changes the password, marks the token used, ' +
        'and the user can subsequently log in with the new password (and not the old one)',
      async () => {
        const created = await user({ label: 'confirm-success' });

        await authService.requestPasswordReset(created.email);
        const sentText = mailService.sent[0]?.text ?? '';
        const rawToken = sentText.match(/([A-Za-z0-9_-]{32,})/)?.[1];
        expect(rawToken).toBeDefined();

        await authService.confirmPasswordReset(rawToken as string, NEW_PASSWORD);

        // Token is now marked used.
        const tokens = await db.passwordResetToken.findMany({ where: { userId: created.id } });
        expect(tokens).toHaveLength(1);
        expect(tokens[0]?.usedAt).not.toBeNull();

        // Old password no longer works; new one does.
        await expect(authService.login(created.email, TEST_PASSWORD)).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
        const loggedIn = await authService.login(created.email, NEW_PASSWORD);
        expect(loggedIn.id).toBe(created.id);
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an unknown/garbage token with a generic invalid-or-expired error',
      async () => {
        await expect(
          authService.confirmPasswordReset(generateRawResetToken(), NEW_PASSWORD),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'This password reset link is invalid or has expired.',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a token that has already been redeemed (single-use) with the SAME generic error',
      async () => {
        const created = await user({ label: 'confirm-replay' });

        await authService.requestPasswordReset(created.email);
        const rawToken = mailService.sent[0]?.text.match(/([A-Za-z0-9_-]{32,})/)?.[1] as string;

        await authService.confirmPasswordReset(rawToken, NEW_PASSWORD);

        await expect(
          authService.confirmPasswordReset(rawToken, 'yet-another-new-password-123'),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'This password reset link is invalid or has expired.',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an expired token with the SAME generic error',
      async () => {
        const created = await user({ label: 'confirm-expired' });
        const rawToken = generateRawResetToken();
        const tokenHash = createSha256Hex(rawToken);

        await db.passwordResetToken.create({
          data: {
            userId: created.id,
            tokenHash,
            // Already in the past — simulates a token whose 30-minute window
            // has elapsed without needing to wait 30 real minutes.
            expiresAt: new Date(Date.now() - 60_000),
          },
        });

        await expect(
          authService.confirmPasswordReset(rawToken, NEW_PASSWORD),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'This password reset link is invalid or has expired.',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a structurally-valid, unexpired, unused token belonging to a now-deactivated account',
      async () => {
        const created = await user({ label: 'confirm-deactivated-after-issue' });

        await authService.requestPasswordReset(created.email);
        const rawToken = mailService.sent[0]?.text.match(/([A-Za-z0-9_-]{32,})/)?.[1] as string;

        await db.user.update({ where: { id: created.id }, data: { isActive: false } });

        await expect(
          authService.confirmPasswordReset(rawToken, 'irrelevant-new-password-123'),
        ).rejects.toMatchObject({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'This password reset link is invalid or has expired.',
        });
      },
      AUTH_TEST_TIMEOUT_MS,
    );
  });
});

/** Local re-implementation of `hashResetToken` (not exported from
 * `auth.service.ts` — it's an internal helper) for the one test that needs to
 * fabricate an already-expired token row directly. Identical algorithm
 * (SHA-256 hex digest) — see that file's `hashResetToken` for the canonical
 * version and its rationale. */
function createSha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
