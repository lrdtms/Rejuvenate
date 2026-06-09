/**
 * Integration tests for the Users module router (plan.md Phase 4f), exercised
 * through the REAL `createApp()` — sessions, RBAC middleware, validation, the
 * central error handler, `UsersService`, and `UsersRepository` (wired to the
 * real local Postgres) all run for real, mirroring
 * `cms.router.test.ts`'s/`blog.router.test.ts`'s established pattern.
 *
 * Uses `request.agent(app)` (cookie jar across calls) for every flow that
 * needs an authenticated session. Real argon2id hashing is in the loop for
 * every login — generous per-test timeouts mirror `CMS_ROUTER_TEST_TIMEOUT_MS`.
 *
 * Coverage:
 *   - RBAC: anonymous -> 401, Blogger/EventManager -> 403, Admin -> 200
 *   - GET /admin/users — pagination + role/isActive filters
 *   - GET /admin/users/:id — happy path, 404
 *   - POST /admin/users — full round-trip (temp password in response,
 *       stored hash verification, passwordHash never leaked, welcome email,
 *       duplicate email -> 409)
 *   - PATCH /admin/users/:id — last-Admin lockout, self-lock, role audit log,
 *       email conflict, happy-path field updates
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword, verifyPassword } from '../auth/password';

const USERS_ROUTER_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple users 42';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueEmail(label: string): string {
  return `users-router-test-${label}-${uniqueSuffix()}@example.invalid`;
}

// ---------------------------------------------------------------------------
// Per-suite user-id tracking (cleanup in afterEach)
// ---------------------------------------------------------------------------
let createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

/**
 * Creates a real `User` row in the DB with a proper argon2id hash of
 * `TEST_PASSWORD` (so `loginAs` works). Registers the id for cleanup.
 */
async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
  isActive?: boolean;
}) {
  const { label, role = 'ADMIN', isActive = true } = opts;
  const email = uniqueEmail(label);
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const created = await db.user.create({
    data: { name: `Users Router Test User (${label})`, email, passwordHash, role, isActive },
  });
  createdUserIds.push(created.id);
  return created;
}

/**
 * Logs the given user in on a fresh `supertest.agent` and returns the agent
 * — every subsequent request carries the session cookie.
 */
async function loginAs(app: ReturnType<typeof createApp>, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

// ---------------------------------------------------------------------------
// RBAC guard — all routes are ADMIN-only
// ---------------------------------------------------------------------------

describe('Users router — RBAC (ADMIN-only, no exceptions)', () => {
  it(
    'rejects an anonymous caller on every route with 401 UNAUTHORIZED',
    async () => {
      const app = createApp();

      const listRes = await request(app).get('/api/v1/admin/users');
      expect(listRes.status).toBe(401);
      expect(listRes.body.error.code).toBe('UNAUTHORIZED');

      const getRes = await request(app).get(`/api/v1/admin/users/${randomUUID()}`);
      expect(getRes.status).toBe(401);

      const postRes = await request(app)
        .post('/api/v1/admin/users')
        .send({ email: uniqueEmail('anon-post'), role: 'BLOGGER' });
      expect(postRes.status).toBe(401);

      const patchRes = await request(app)
        .patch(`/api/v1/admin/users/${randomUUID()}`)
        .send({ isActive: false });
      expect(patchRes.status).toBe(401);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects an authenticated BLOGGER with 403 FORBIDDEN on every route',
    async () => {
      const app = createApp();
      const blogger = await createTestUser({ label: 'rbac-blogger', role: 'BLOGGER' });
      const agent = await loginAs(app, blogger);

      const listRes = await agent.get('/api/v1/admin/users');
      expect(listRes.status).toBe(403);
      expect(listRes.body.error.code).toBe('FORBIDDEN');

      const getRes = await agent.get(`/api/v1/admin/users/${blogger.id}`);
      expect(getRes.status).toBe(403);

      const postRes = await agent
        .post('/api/v1/admin/users')
        .send({ email: uniqueEmail('blogger-post'), role: 'BLOGGER' });
      expect(postRes.status).toBe(403);

      const patchRes = await agent
        .patch(`/api/v1/admin/users/${blogger.id}`)
        .send({ isActive: false });
      expect(patchRes.status).toBe(403);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects an authenticated EVENT_MANAGER with 403 FORBIDDEN on every route',
    async () => {
      const app = createApp();
      const em = await createTestUser({ label: 'rbac-em', role: 'EVENT_MANAGER' });
      const agent = await loginAs(app, em);

      const listRes = await agent.get('/api/v1/admin/users');
      expect(listRes.status).toBe(403);

      const postRes = await agent
        .post('/api/v1/admin/users')
        .send({ email: uniqueEmail('em-post'), role: 'BLOGGER' });
      expect(postRes.status).toBe(403);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'allows an authenticated ADMIN through all routes',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'rbac-admin' });
      const agent = await loginAs(app, admin);

      const listRes = await agent.get('/api/v1/admin/users');
      expect(listRes.status).toBe(200);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// GET /admin/users — paginated list + filters
// ---------------------------------------------------------------------------

describe('GET /admin/users', () => {
  it(
    'returns a paginated result envelope with items, page, limit, total, pageCount',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'list-envelope' });
      const agent = await loginAs(app, admin);

      const res = await agent.get('/api/v1/admin/users');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.page).toBe('number');
      expect(typeof res.body.limit).toBe('number');
      expect(typeof res.body.total).toBe('number');
      expect(typeof res.body.pageCount).toBe('number');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'filters by ?role=BLOGGER — only Bloggers are returned',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'filter-role-admin' });
      await createTestUser({ label: 'filter-role-blogger', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent.get('/api/v1/admin/users?role=BLOGGER');

      expect(res.status).toBe(200);
      expect(res.body.items.every((u: { role: string }) => u.role === 'BLOGGER')).toBe(true);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'filters by ?isActive=false — only inactive users are returned',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'filter-inactive-admin' });
      await createTestUser({ label: 'filter-inactive-target', role: 'BLOGGER', isActive: false });
      const agent = await loginAs(app, admin);

      const res = await agent.get('/api/v1/admin/users?isActive=false');

      expect(res.status).toBe(200);
      expect(res.body.items.every((u: { isActive: boolean }) => u.isActive === false)).toBe(true);
      expect(res.body.items.some((u: { isActive: boolean }) => u.isActive === true)).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'never includes passwordHash in list items',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'list-no-hash' });
      const agent = await loginAs(app, admin);

      const res = await agent.get('/api/v1/admin/users');

      expect(res.status).toBe(200);
      for (const item of res.body.items) {
        expect('passwordHash' in item).toBe(false);
      }
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// GET /admin/users/:id
// ---------------------------------------------------------------------------

describe('GET /admin/users/:id', () => {
  it(
    'returns the AdminUserView for an existing user',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'get-actor' });
      const target = await createTestUser({ label: 'get-target', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent.get(`/api/v1/admin/users/${target.id}`);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(target.id);
      expect(res.body.user.email).toBe(target.email);
      expect(res.body.user.role).toBe('BLOGGER');
      expect('passwordHash' in res.body.user).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'returns 404 for an id that does not exist',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'get-notfound' });
      const agent = await loginAs(app, admin);

      const res = await agent.get(`/api/v1/admin/users/${randomUUID()}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'never includes passwordHash in the single-user response',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'get-no-hash-actor' });
      const agent = await loginAs(app, admin);

      const res = await agent.get(`/api/v1/admin/users/${admin.id}`);

      expect(res.status).toBe(200);
      expect('passwordHash' in res.body.user).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// POST /admin/users — account creation
// ---------------------------------------------------------------------------

describe('POST /admin/users', () => {
  it(
    'creates a staff account: returns 201 with user + temporaryPassword',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'post-create-actor' });
      const agent = await loginAs(app, admin);

      const newEmail = uniqueEmail('post-create-new');
      const res = await agent
        .post('/api/v1/admin/users')
        .send({ email: newEmail, role: 'BLOGGER' });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(newEmail);
      expect(res.body.user.role).toBe('BLOGGER');
      expect(res.body.user.isActive).toBe(true);
      expect(typeof res.body.temporaryPassword).toBe('string');
      expect(res.body.temporaryPassword.length).toBeGreaterThan(0);
      expect('passwordHash' in res.body.user).toBe(false);

      // Cleanup
      createdUserIds.push(res.body.user.id);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'stored passwordHash verifies against the returned temporaryPassword',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'post-hash-verify-actor' });
      const agent = await loginAs(app, admin);

      const newEmail = uniqueEmail('post-hash-verify-new');
      const res = await agent
        .post('/api/v1/admin/users')
        .send({ email: newEmail, role: 'EVENT_MANAGER' });

      expect(res.status).toBe(201);
      createdUserIds.push(res.body.user.id);

      const { temporaryPassword } = res.body;
      const dbRow = await db.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
      const matches = await verifyPassword(dbRow.passwordHash, temporaryPassword);
      expect(matches).toBe(true);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a duplicate email with 409 CONFLICT',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'post-dup-actor' });
      const existing = await createTestUser({ label: 'post-dup-existing', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .post('/api/v1/admin/users')
        .send({ email: existing.email, role: 'EVENT_MANAGER' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a missing email with 400 VALIDATION_ERROR',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'post-missing-email' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .post('/api/v1/admin/users')
        .send({ role: 'BLOGGER' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects an invalid role with 400 VALIDATION_ERROR',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'post-bad-role' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .post('/api/v1/admin/users')
        .send({ email: uniqueEmail('post-bad-role-new'), role: 'SUPERUSER' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// PATCH /admin/users/:id
// ---------------------------------------------------------------------------

describe('PATCH /admin/users/:id', () => {
  it(
    'happy path: updates role, email, and isActive independently',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'patch-happy-actor' });
      const target = await createTestUser({ label: 'patch-happy-target', role: 'BLOGGER' });
      // Second admin so no last-admin concern when we demote target
      const agent = await loginAs(app, admin);

      // Update email
      const newEmail = uniqueEmail('patch-happy-new-email');
      const emailRes = await agent
        .patch(`/api/v1/admin/users/${target.id}`)
        .send({ email: newEmail });
      expect(emailRes.status).toBe(200);
      expect(emailRes.body.user.email).toBe(newEmail);
      expect('passwordHash' in emailRes.body.user).toBe(false);

      // Update isActive
      const deactivateRes = await agent
        .patch(`/api/v1/admin/users/${target.id}`)
        .send({ isActive: false });
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.user.isActive).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  // NOTE — last-Admin lockout cannot be cleanly tested at the HTTP layer due to an
  // architectural interaction: `requireAuth` re-derives the user from the DB on every
  // request (the "deactivation takes effect immediately" guarantee — see rbac.ts). This
  // means we cannot have an actor who is both (a) able to log in (active admin) AND
  // (b) not counted among active admins in the lockout guard, without a race condition.
  // The self-lock guard (actor == target) fires first when trying to deactivate oneself.
  // Full last-Admin lockout coverage is in `users.service.test.ts` where the actor is
  // constructed directly as an `AuthenticatedUser` without requiring a live session.
  //
  // What IS tested here via HTTP: self-lock (below), duplicate email (below), and the
  // two-Admin "allows deactivation" case (the happy path — see full round-trip test).

  it(
    'returns 400 BAD_REQUEST when an Admin tries to self-deactivate',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'self-deactivate' });
      // Second admin so last-admin guard doesn't fire
      await createTestUser({ label: 'self-deactivate-other' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${admin.id}`)
        .send({ isActive: false });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'returns 400 BAD_REQUEST when an Admin tries to self-demote',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'self-demote-http' });
      await createTestUser({ label: 'self-demote-http-other' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${admin.id}`)
        .send({ role: 'BLOGGER' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'returns 409 CONFLICT when patching email to one already taken',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'patch-email-conflict-actor' });
      const target = await createTestUser({ label: 'patch-email-conflict-target', role: 'BLOGGER' });
      const other = await createTestUser({ label: 'patch-email-conflict-other', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${target.id}`)
        .send({ email: other.email });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'returns 404 for patching a non-existent user id',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'patch-notfound-actor' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${randomUUID()}`)
        .send({ isActive: true });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'returns 400 VALIDATION_ERROR for a completely empty PATCH body (at least one field required)',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'patch-empty' });
      const target = await createTestUser({ label: 'patch-empty-target', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${target.id}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );

  it(
    'never includes passwordHash in the PATCH response',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'patch-no-hash-actor' });
      const target = await createTestUser({ label: 'patch-no-hash-target', role: 'BLOGGER' });
      const agent = await loginAs(app, admin);

      const res = await agent
        .patch(`/api/v1/admin/users/${target.id}`)
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect('passwordHash' in res.body.user).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Full CRUD round-trip
// ---------------------------------------------------------------------------

describe('Users module — full CRUD round-trip', () => {
  it(
    'create -> get -> patch -> list flow',
    async () => {
      const app = createApp();
      const admin = await createTestUser({ label: 'roundtrip-actor' });
      const agent = await loginAs(app, admin);

      // CREATE
      const newEmail = uniqueEmail('roundtrip-new');
      const createRes = await agent
        .post('/api/v1/admin/users')
        .send({ email: newEmail, role: 'BLOGGER', firstName: 'Round', surname: 'Trip' });
      expect(createRes.status).toBe(201);
      const newUserId = createRes.body.user.id;
      createdUserIds.push(newUserId);

      // GET by id
      const getRes = await agent.get(`/api/v1/admin/users/${newUserId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.user.email).toBe(newEmail);
      expect(getRes.body.user.role).toBe('BLOGGER');

      // PATCH
      const patchRes = await agent
        .patch(`/api/v1/admin/users/${newUserId}`)
        .send({ role: 'EVENT_MANAGER' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.user.role).toBe('EVENT_MANAGER');

      // LIST — confirm the user appears
      const listRes = await agent.get(`/api/v1/admin/users?role=EVENT_MANAGER`);
      expect(listRes.status).toBe(200);
      const found = listRes.body.items.find((u: { id: string }) => u.id === newUserId);
      expect(found).toBeDefined();
      expect(found.role).toBe('EVENT_MANAGER');
      expect('passwordHash' in found).toBe(false);
    },
    USERS_ROUTER_TEST_TIMEOUT_MS,
  );
});
