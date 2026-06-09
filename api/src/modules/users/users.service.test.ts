/**
 * Integration tests for `UsersService` (plan.md Phase 4f), exercised against
 * the REAL local Postgres via the REAL `UsersRepository` — mirroring
 * `cms.service.test.ts`'s / `registrations.service.test.ts`'s "real DB, no
 * mocking infrastructure" posture.
 *
 * Coverage:
 *   - `listUsers`          — pagination, role filter, isActive filter
 *   - `getUserById`        — happy path, notFound
 *   - `createUser`         — happy path (temp password, hash verification,
 *                            passwordHash never in view, welcome email),
 *                            duplicate email rejection
 *   - `patchUser`          — happy path, last-Admin lockout (single admin
 *                            rejected; second admin allows change), self-lock
 *                            prevention, role-change audit log, email conflict
 */
import { randomUUID } from 'node:crypto';

import { pino, type Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '../../lib/db';
import type { AuthenticatedUser } from '../auth/auth.service';
import { verifyPassword } from '../auth/password';
import type { MailMessage, MailService } from '../auth/mail.service';
import { createUsersRepository } from './users.repository';
import { createUsersService } from './users.service';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueEmail(label: string): string {
  return `users-service-test-${label}-${uniqueSuffix()}@example.invalid`;
}

/**
 * A recording `MailService` stub — captures every `send()` call so tests can
 * assert on subject/body/recipient without console noise. Mirrors the
 * "recording fake" posture `auth.service.test.ts` uses for the same interface.
 */
class RecordingMailService implements MailService {
  public readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * A failing `MailService` stub — throws on every `send()` call so tests can
 * verify the "email failure does NOT roll back account creation" guarantee.
 */
class FailingMailService implements MailService {
  async send(_message: MailMessage): Promise<void> {
    throw new Error('Simulated mail send failure');
  }
}

const silentLogger = pino({ level: 'silent' });
const usersRepository = createUsersRepository({ db });

/** Ids of user rows created during a test — cleaned up in `afterEach`. */
let createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    // Safe-delete: cascade-delete authored content FIRST if any was created,
    // but in this test suite we only create User rows (no BlogPosts/Events),
    // so a direct deleteMany is safe.
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

/** Creates a real `User` row in the DB and registers its id for cleanup. */
async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive?: boolean;
}): Promise<{ dbUser: Awaited<ReturnType<typeof db.user.create>>; asAuthUser: AuthenticatedUser }> {
  const { label, role = 'ADMIN', isActive = true } = opts;
  const dbUser = await db.user.create({
    data: {
      name: `Users Service Test User (${label})`,
      email: uniqueEmail(label),
      passwordHash: 'not-a-real-hash',
      role,
      isActive,
    },
  });
  createdUserIds.push(dbUser.id);
  return {
    dbUser,
    asAuthUser: {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      role: dbUser.role,
      isActive: dbUser.isActive,
    },
  };
}

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

describe('UsersService.listUsers', () => {
  it('returns a paginated result with the correct envelope shape', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    // Create two known users
    await createTestUser({ label: 'list-a', role: 'BLOGGER' });
    await createTestUser({ label: 'list-b', role: 'EVENT_MANAGER' });

    const result = await service.listUsers({}, { page: 1, limit: 20 });

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('page', 1);
    expect(result).toHaveProperty('limit', 20);
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('pageCount');
    expect(Array.isArray(result.items)).toBe(true);
    // At least the two we created are there
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('filters by role — only returns users with the requested role', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    await createTestUser({ label: 'filter-blogger', role: 'BLOGGER' });
    await createTestUser({ label: 'filter-em', role: 'EVENT_MANAGER' });

    const result = await service.listUsers({ role: 'BLOGGER' }, { page: 1, limit: 100 });

    expect(result.items.every((u) => u.role === 'BLOGGER')).toBe(true);
  });

  it('filters by isActive=false — only returns inactive users', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    await createTestUser({ label: 'inactive-filter', role: 'BLOGGER', isActive: false });

    const result = await service.listUsers({ isActive: false }, { page: 1, limit: 100 });

    expect(result.items.every((u) => u.isActive === false)).toBe(true);
    expect(result.items.some((u) => u.isActive === true)).toBe(false);
  });

  it('never includes passwordHash in the returned items', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    await createTestUser({ label: 'no-hash-list' });

    const result = await service.listUsers({}, { page: 1, limit: 100 });

    for (const item of result.items) {
      expect('passwordHash' in item).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// getUserById
// ---------------------------------------------------------------------------

describe('UsersService.getUserById', () => {
  it('returns the AdminUserView for an existing user', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { dbUser } = await createTestUser({ label: 'get-by-id' });

    const view = await service.getUserById(dbUser.id);

    expect(view.id).toBe(dbUser.id);
    expect(view.email).toBe(dbUser.email);
    expect(view.role).toBe(dbUser.role);
    expect(view.isActive).toBe(dbUser.isActive);
    expect('passwordHash' in view).toBe(false);
  });

  it('throws notFound (404) for an id that does not correspond to any user', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const nonExistentId = randomUUID();
    await expect(service.getUserById(nonExistentId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('never includes passwordHash in the returned view', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { dbUser } = await createTestUser({ label: 'no-hash-get' });

    const view = await service.getUserById(dbUser.id);

    expect('passwordHash' in view).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

describe('UsersService.createUser', () => {
  it('happy path: creates the account, returns AdminUserView + temporaryPassword, never exposes passwordHash', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const email = uniqueEmail('create-happy');
    const { user, temporaryPassword } = await service.createUser({
      email,
      role: 'BLOGGER',
    });

    // Register for cleanup
    createdUserIds.push(user.id);

    // Basic shape
    expect(user.email).toBe(email);
    expect(user.role).toBe('BLOGGER');
    expect(user.isActive).toBe(true);
    expect('passwordHash' in user).toBe(false);

    // Temp password is a non-empty string
    expect(typeof temporaryPassword).toBe('string');
    expect(temporaryPassword.length).toBeGreaterThan(0);
  });

  it('stored passwordHash verifies against the returned temporaryPassword', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const email = uniqueEmail('create-hash-verify');
    const { user, temporaryPassword } = await service.createUser({
      email,
      role: 'EVENT_MANAGER',
    });
    createdUserIds.push(user.id);

    // Read the raw DB row to get the hash
    const dbRow = await db.user.findUniqueOrThrow({ where: { id: user.id } });

    // The stored hash must verify against the returned plaintext
    const matches = await verifyPassword(dbRow.passwordHash, temporaryPassword);
    expect(matches).toBe(true);
  });

  it('sends a welcome email containing the temporaryPassword', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const email = uniqueEmail('create-email-sent');
    const { user, temporaryPassword } = await service.createUser({
      email,
      role: 'BLOGGER',
    });
    createdUserIds.push(user.id);

    expect(mailService.sent).toHaveLength(1);
    const sentMessage = mailService.sent[0]!;
    expect(sentMessage.to).toBe(email);
    expect(sentMessage.text).toContain(temporaryPassword);
  });

  it('uses firstName/surname in the welcome email greeting if provided (but does NOT store them)', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const email = uniqueEmail('create-greeting');
    const { user } = await service.createUser({
      email,
      role: 'BLOGGER',
      firstName: 'Thabo',
      surname: 'Nkosi',
    });
    createdUserIds.push(user.id);

    // Email greeting uses the name
    const sentMessage = mailService.sent[0]!;
    expect(sentMessage.text).toContain('Thabo');

    // But the DB name field is set from firstName + surname (not the raw email),
    // and does NOT have a separate firstName/surname column
    const dbRow = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(dbRow.name).toBe('Thabo Nkosi');

    // No phantom columns on the DB row — schema has no firstName/surname
    expect('firstName' in dbRow).toBe(false);
    expect('surname' in dbRow).toBe(false);
  });

  it('rejects a duplicate email with conflict (409)', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const email = uniqueEmail('create-duplicate');
    const { user } = await service.createUser({ email, role: 'BLOGGER' });
    createdUserIds.push(user.id);

    // Second creation with the same email
    await expect(
      service.createUser({ email, role: 'EVENT_MANAGER' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('creates the account even if the welcome email send fails (best-effort email)', async () => {
    const failingMailService = new FailingMailService();
    const service = createUsersService({
      repository: usersRepository,
      mailService: failingMailService,
      logger: silentLogger,
    });

    const email = uniqueEmail('create-mail-fail');
    // Should NOT throw even though mail fails
    const { user, temporaryPassword } = await service.createUser({ email, role: 'BLOGGER' });
    createdUserIds.push(user.id);

    // Account was created
    expect(user.id).toBeTruthy();
    expect(user.email).toBe(email);
    // Temp password was still returned
    expect(temporaryPassword).toBeTruthy();
    // Row exists in DB
    const dbRow = await db.user.findUnique({ where: { id: user.id } });
    expect(dbRow).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// patchUser
// ---------------------------------------------------------------------------

describe('UsersService.patchUser', () => {
  it('happy path: updates email', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { dbUser, asAuthUser: actor } = await createTestUser({ label: 'patch-email-actor', role: 'ADMIN' });
    // Ensure a second admin exists so the actor is not the last active admin
    await createTestUser({ label: 'patch-email-other', role: 'ADMIN' });

    const newEmail = uniqueEmail('patch-email-new');
    const updated = await service.patchUser(actor, dbUser.id, { email: newEmail });

    expect(updated.email).toBe(newEmail);
    expect('passwordHash' in updated).toBe(false);
  });

  it('happy path: promotes a Blogger to Admin', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'patch-promote-actor' });
    const { dbUser: target } = await createTestUser({ label: 'patch-promote-target', role: 'BLOGGER' });

    const updated = await service.patchUser(actor, target.id, { role: 'ADMIN' });

    expect(updated.role).toBe('ADMIN');
  });

  it('happy path: deactivates a Blogger (not the last Admin)', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'patch-deactivate-actor' });
    const { dbUser: target } = await createTestUser({ label: 'patch-deactivate-target', role: 'BLOGGER' });

    const updated = await service.patchUser(actor, target.id, { isActive: false });

    expect(updated.isActive).toBe(false);
    expect('passwordHash' in updated).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Self-lock prevention
  // -----------------------------------------------------------------------
  it('rejects self-deactivation with 400 BAD_REQUEST', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    // Create a second admin so last-admin guard doesn't fire first
    await createTestUser({ label: 'self-lock-other-admin' });
    const { dbUser: actor, asAuthUser } = await createTestUser({ label: 'self-lock-actor' });

    await expect(
      service.patchUser(asAuthUser, actor.id, { isActive: false }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('rejects self-demotion with 400 BAD_REQUEST', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    await createTestUser({ label: 'self-demote-other-admin' });
    const { dbUser: actor, asAuthUser } = await createTestUser({ label: 'self-demote-actor' });

    await expect(
      service.patchUser(asAuthUser, actor.id, { role: 'BLOGGER' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  // -----------------------------------------------------------------------
  // Last-Admin lockout prevention
  // -----------------------------------------------------------------------
  it('rejects deactivation of the ONLY active Admin with 400 BAD_REQUEST', async () => {
    const mailService = new RecordingMailService();

    // We need `countActiveAdmins()` to return exactly 1 to trigger the guard.
    // Using the real shared DB is unreliable in parallel test runs (other test
    // files create their own Admin users, so the global count is always > 1).
    // Instead, compose a mock repository where `countActiveAdmins` returns 1
    // — this is the correct seam: the guard's logic is "count <= 1 -> reject",
    // and the real DB already covers the "> 1 -> allow" case in the
    // "allows deactivation when second admin exists" test above.
    const { dbUser: adminA } = await createTestUser({ label: 'last-admin-mock-actor', role: 'ADMIN' });
    const { dbUser: adminB } = await createTestUser({ label: 'last-admin-mock-target', role: 'ADMIN' });

    const mockRepository = {
      ...usersRepository,
      // Override findById to return the real target row
      findById: async (id: string) => {
        if (id === adminB.id) return adminB;
        return usersRepository.findById(id);
      },
      // Simulate "exactly 1 active Admin remaining" so the guard fires
      countActiveAdmins: async () => 1,
    };

    const service = createUsersService({ repository: mockRepository, mailService, logger: silentLogger });

    const actorA: AuthenticatedUser = {
      id: adminA.id,
      name: adminA.name,
      email: adminA.email,
      role: 'ADMIN',
      isActive: true,
    };

    // Attempting to deactivate B (simulated as the only active Admin) must be rejected
    await expect(
      service.patchUser(actorA, adminB.id, { isActive: false }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('allows deactivation of an Admin when a second active Admin exists', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'two-admins-actor' });
    const { dbUser: target } = await createTestUser({ label: 'two-admins-target' });

    // Both are active admins — deactivating target should succeed
    const updated = await service.patchUser(actor, target.id, { isActive: false });

    expect(updated.isActive).toBe(false);
  });

  it('allows demotion of an Admin when a second active Admin exists', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'two-admins-demote-actor' });
    const { dbUser: target } = await createTestUser({ label: 'two-admins-demote-target' });

    const updated = await service.patchUser(actor, target.id, { role: 'BLOGGER' });

    expect(updated.role).toBe('BLOGGER');
  });

  // -----------------------------------------------------------------------
  // Role-change audit log
  // -----------------------------------------------------------------------
  it('logs a role_change event when role changes, with correct actorId/targetUserId/fromRole/toRole', async () => {
    const mailService = new RecordingMailService();

    // Spy on the logger's `info` method to capture structured log entries
    const spyLogger = {
      ...silentLogger,
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;

    const service = createUsersService({ repository: usersRepository, mailService, logger: spyLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'audit-actor' });
    const { dbUser: target } = await createTestUser({ label: 'audit-target', role: 'BLOGGER' });

    await service.patchUser(actor, target.id, { role: 'EVENT_MANAGER' });

    // Find the role_change log call
    const infoCalls = (spyLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const roleChangeCall = infoCalls.find(
      (call: unknown[]) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'role_change',
    );

    expect(roleChangeCall).toBeDefined();
    const logData = roleChangeCall![0] as Record<string, unknown>;
    expect(logData['actorId']).toBe(actor.id);
    expect(logData['actorEmail']).toBe(actor.email);
    expect(logData['targetUserId']).toBe(target.id);
    expect(logData['fromRole']).toBe('BLOGGER');
    expect(logData['toRole']).toBe('EVENT_MANAGER');
    expect(typeof logData['timestamp']).toBe('string');
  });

  it('does NOT log a role_change event when only email/isActive is patched', async () => {
    const mailService = new RecordingMailService();
    const spyLogger = {
      ...silentLogger,
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;

    const service = createUsersService({ repository: usersRepository, mailService, logger: spyLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'no-audit-actor' });
    const { dbUser: target } = await createTestUser({ label: 'no-audit-target', role: 'BLOGGER' });

    await service.patchUser(actor, target.id, { isActive: false });

    const infoCalls = (spyLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const roleChangeCall = infoCalls.find(
      (call: unknown[]) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)['event'] === 'role_change',
    );
    expect(roleChangeCall).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Email conflict on patch
  // -----------------------------------------------------------------------
  it('rejects a PATCH that sets email to one already taken by another user with 409 CONFLICT', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'email-conflict-actor' });
    const { dbUser: target } = await createTestUser({ label: 'email-conflict-target', role: 'BLOGGER' });
    const { dbUser: existing } = await createTestUser({ label: 'email-conflict-existing', role: 'BLOGGER' });

    await expect(
      service.patchUser(actor, target.id, { email: existing.email }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('allows patching an email to the SAME value it already has (no false conflict)', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { dbUser: target, asAuthUser: actor } = await createTestUser({ label: 'email-same-actor' });
    await createTestUser({ label: 'email-same-other' }); // second admin so no last-admin issue

    // Patching email to the exact same value should succeed
    const updated = await service.patchUser(actor, target.id, { email: target.email });
    expect(updated.email).toBe(target.email);
  });

  it('throws notFound for a target id that does not exist', async () => {
    const mailService = new RecordingMailService();
    const service = createUsersService({ repository: usersRepository, mailService, logger: silentLogger });

    const { asAuthUser: actor } = await createTestUser({ label: 'patch-notfound-actor' });
    const nonExistentId = randomUUID();

    await expect(
      service.patchUser(actor, nonExistentId, { role: 'BLOGGER' }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});
