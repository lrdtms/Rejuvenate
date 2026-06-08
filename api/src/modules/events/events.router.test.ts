/**
 * Integration tests for the Events module's router (plan.md Phase 4b steps
 * 3-4), exercised through the REAL `createApp()` — sessions, RBAC middleware,
 * validation, the central error handler, `EventService`, and `EventRepository`
 * (wired to the real local Postgres) all run for real, exactly as
 * `blog.router.test.ts` does for Blog. This is the layer that proves
 * `requireRole`/validation/the dormant-fields rejection/visibility actually
 * wire together end-to-end through real HTTP requests and real session
 * cookies — none of which `events.service.test.ts`'s direct-service-call
 * tests can observe (they bypass the router, the RBAC gate, Zod, and the
 * HTTP/session machinery entirely).
 *
 * Uses `request.agent(app)` (cookie jar across calls) for authenticated
 * flows — mirrors `blog.router.test.ts`/`auth.router.test.ts`'s established
 * pattern, including the generous per-test timeout for real argon2id hashing
 * during login.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword } from '../auth/password';

const EVENTS_ROUTER_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple 42';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Router Test Event ${label} ${uniqueSuffix()}`;
}

let createdUserIds: string[] = [];
let createdEventIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
    // `Registration` rows must be cleared first — `onDelete: Restrict` would
    // otherwise block `Event` cleanup, mirroring
    // `events.repository.test.ts`'s/`events.service.test.ts`'s identical
    // discipline.
    await db.registration.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

async function createTestUser(opts: { label: string; role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER' }) {
  const { label, role = 'EVENT_MANAGER' } = opts;
  const email = `events-router-test-${label}-${uniqueSuffix()}@example.invalid`;
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const created = await db.user.create({
    data: { name: `Events Router Test User (${label})`, email, passwordHash, role, isActive: true },
  });
  createdUserIds.push(created.id);
  return created;
}

/** Logs the given user in on a fresh `supertest.agent` — mirrors
 * `blog.router.test.ts`'s `loginAs` verbatim. */
async function loginAs(app: ReturnType<typeof createApp>, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

function futureWindow(opts?: { startInMs?: number; durationMs?: number }) {
  const startInMs = opts?.startInMs ?? 24 * 60 * 60 * 1000;
  const durationMs = opts?.durationMs ?? 60 * 60 * 1000;
  return {
    startsAt: new Date(Date.now() + startInMs),
    endsAt: new Date(Date.now() + startInMs + durationMs),
  };
}

/** Creates an event directly via Prisma (bypassing the service/router) for
 * setup convenience — mirrors `blog.router.test.ts`'s `createPostFixture`. */
async function createEventFixture(opts: {
  createdById: string;
  title?: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  branch?: 'CAPE_TOWN' | 'DURBAN' | 'OTHER';
  capacity?: number | null;
  startsAt?: Date;
  endsAt?: Date;
}) {
  const title = opts.title ?? uniqueTitle('fixture');
  const slug = `fixture-event-${uniqueSuffix()}`;
  const window = futureWindow();
  const event = await db.event.create({
    data: {
      title,
      slug,
      description: 'A perfectly ordinary fixture event description, long enough to be valid.',
      startsAt: opts.startsAt ?? window.startsAt,
      endsAt: opts.endsAt ?? window.endsAt,
      branch: opts.branch ?? 'CAPE_TOWN',
      locationDetail: 'Fixture Venue, 1 Fixture Street',
      capacity: opts.capacity ?? null,
      status: opts.status ?? 'DRAFT',
      createdById: opts.createdById,
      isPaid: false,
      priceCents: null,
    },
  });
  createdEventIds.push(event.id);
  return event;
}

describe('Events router (plan.md Phase 4b steps 3-4)', () => {
  // ===========================================================================
  // Public routes
  // ===========================================================================
  describe('GET /events — public, paginated, published-only', () => {
    it('returns only published events, excluding drafts and cancelled (200, paginated envelope)', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-list-manager' });

      const draft = await createEventFixture({ createdById: manager.id, status: 'DRAFT' });
      const published = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED' });
      const cancelled = await createEventFixture({ createdById: manager.id, status: 'CANCELLED' });

      const res = await request(app).get('/api/v1/events').query({ limit: 100 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageCount');

      const ids: string[] = res.body.items.map((e: { id: string }) => e.id);
      expect(ids).toContain(published.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(cancelled.id);
    });

    it('filters by branch when provided', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-list-branch-manager' });

      const capeTown = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED', branch: 'CAPE_TOWN' });
      const durban = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED', branch: 'DURBAN' });

      const res = await request(app).get('/api/v1/events').query({ limit: 100, branch: 'CAPE_TOWN' });

      expect(res.status).toBe(200);
      const ids: string[] = res.body.items.map((e: { id: string }) => e.id);
      expect(ids).toContain(capeTown.id);
      expect(ids).not.toContain(durban.id);
    });

    it('filters by upcoming/past using endsAt-based semantics', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-list-temporal-manager' });

      const upcomingEvent = await createEventFixture({
        createdById: manager.id,
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
      });
      const pastEvent = await createEventFixture({
        createdById: manager.id,
        status: 'PUBLISHED',
        startsAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      const upcomingRes = await request(app).get('/api/v1/events').query({ limit: 100, upcoming: 'true' });
      const pastRes = await request(app).get('/api/v1/events').query({ limit: 100, past: 'true' });

      expect(upcomingRes.status).toBe(200);
      expect(pastRes.status).toBe(200);

      const upcomingIds: string[] = upcomingRes.body.items.map((e: { id: string }) => e.id);
      const pastIds: string[] = pastRes.body.items.map((e: { id: string }) => e.id);

      expect(upcomingIds).toContain(upcomingEvent.id);
      expect(upcomingIds).not.toContain(pastEvent.id);
      expect(pastIds).toContain(pastEvent.id);
      expect(pastIds).not.toContain(upcomingEvent.id);
    });

    it('rejects upcoming=true and past=true together with 400 VALIDATION_ERROR (mutually exclusive)', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/events').query({ upcoming: 'true', past: 'true' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an out-of-bounds limit with 400 VALIDATION_ERROR (DoS guard)', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/events').query({ limit: 100000 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.fields).toHaveProperty('limit');
    });
  });

  describe('GET /events/:slug — public, single published event', () => {
    it('returns 200 with the event for a genuinely PUBLISHED event', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-detail-manager' });
      const published = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED' });

      const res = await request(app).get(`/api/v1/events/${published.slug}`);

      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({ id: published.id, slug: published.slug, status: 'PUBLISHED' });
    });

    it('returns 404 NOT_FOUND identically for a DRAFT event and a genuinely nonexistent slug (anti-enumeration)', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-detail-draft-manager' });
      const draft = await createEventFixture({ createdById: manager.id, status: 'DRAFT' });

      const draftRes = await request(app).get(`/api/v1/events/${draft.slug}`);
      const missingRes = await request(app).get(`/api/v1/events/no-such-slug-${uniqueSuffix()}`);

      expect(draftRes.status).toBe(404);
      expect(missingRes.status).toBe(404);
      expect(draftRes.body).toEqual(missingRes.body);
      expect(draftRes.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 NOT_FOUND for a CANCELLED event — only PUBLISHED is publicly visible', async () => {
      const app = createApp();
      const manager = await createTestUser({ label: 'public-detail-cancelled-manager' });
      const cancelled = await createEventFixture({ createdById: manager.id, status: 'CANCELLED' });

      const res = await request(app).get(`/api/v1/events/${cancelled.slug}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it(
      'returns 200 for a PUBLISHED event even when startsAt is in the future — no scheduling-gap limbo (unlike Blog)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'public-detail-future-start-manager' });
        const event = await createEventFixture({
          createdById: manager.id,
          status: 'PUBLISHED',
          startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
        });

        const res = await request(app).get(`/api/v1/events/${event.slug}`);

        expect(res.status).toBe(200);
        expect(res.body.event.id).toBe(event.id);
      },
    );
  });

  // ===========================================================================
  // Admin routes — auth/role gating
  // ===========================================================================
  describe('admin routes — authentication/role gating', () => {
    it('rejects an anonymous caller on GET /admin/events with 401 UNAUTHORIZED', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/admin/events');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it(
      'rejects an authenticated BLOGGER (wrong role) on GET /admin/events with 403 FORBIDDEN — Bloggers have no event access',
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'wrong-role-blogger', role: 'BLOGGER' });
        const agent = await loginAs(app, blogger);

        const res = await agent.get('/api/v1/admin/events');

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an authenticated EVENT_MANAGER on GET /admin/events (200)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'right-role-manager' });
        const agent = await loginAs(app, manager);

        const res = await agent.get('/api/v1/admin/events');

        expect(res.status).toBe(200);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an authenticated ADMIN on GET /admin/events (200)',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'right-role-admin', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        const res = await agent.get('/api/v1/admin/events');

        expect(res.status).toBe(200);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // POST /admin/events — create
  // ===========================================================================
  describe('POST /admin/events', () => {
    it(
      'creates a DRAFT event with a generated slug for an authenticated Event Manager (201)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'create-manager' });
        const agent = await loginAs(app, manager);
        const window = futureWindow();

        const res = await agent.post('/api/v1/admin/events').send({
          title: uniqueTitle('Create Flow'),
          description: 'A perfectly ordinary description, long enough to be valid for creation.',
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue, Some Street',
          capacity: 50,
        });

        expect(res.status).toBe(201);
        expect(res.body.event).toMatchObject({ status: 'DRAFT', createdById: manager.id, capacity: 50 });
        expect(res.body.event.slug).toBeTruthy();
        expect(res.body.event.isPaid).toBe(false);
        expect(res.body.event.priceCents).toBeNull();

        createdEventIds.push(res.body.event.id);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a too-short title with 400 VALIDATION_ERROR carrying field-level detail',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'create-validation-manager' });
        const agent = await loginAs(app, manager);
        const window = futureWindow();

        const res = await agent.post('/api/v1/admin/events').send({
          title: 'ab',
          description: 'A perfectly ordinary description, long enough to be valid.',
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue',
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('title');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects endsAt <= startsAt with 400 VALIDATION_ERROR before reaching the service',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'create-dates-manager' });
        const agent = await loginAs(app, manager);
        const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const endsAt = new Date(startsAt.getTime() - 60 * 1000); // before startsAt

        const res = await agent.post('/api/v1/admin/events').send({
          title: uniqueTitle('Bad Dates'),
          description: 'A perfectly ordinary description, long enough to be valid.',
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue',
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('endsAt');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    // =========================================================================
    // The dormant `isPaid`/`priceCents` rejection — the actual VALIDATION
    // BOUNDARY (Zod), not merely the service-layer structural guarantee
    // `events.service.test.ts` covers. ADR-0006: v1 must REJECT, not silently
    // coerce, a live paid-ticketing configuration.
    // =========================================================================
    it(
      'rejects isPaid: true with 400 VALIDATION_ERROR naming the field — dormant in v1 (ADR-0006)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'dormant-ispaid-manager' });
        const agent = await loginAs(app, manager);
        const window = futureWindow();

        const res = await agent.post('/api/v1/admin/events').send({
          title: uniqueTitle('Dormant isPaid'),
          description: 'A perfectly ordinary description, long enough to be valid.',
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue',
          isPaid: true,
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('isPaid');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a non-null priceCents with 400 VALIDATION_ERROR naming the field — dormant in v1 (ADR-0006)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'dormant-pricecents-manager' });
        const agent = await loginAs(app, manager);
        const window = futureWindow();

        const res = await agent.post('/api/v1/admin/events').send({
          title: uniqueTitle('Dormant priceCents'),
          description: 'A perfectly ordinary description, long enough to be valid.',
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue',
          priceCents: 5000,
        });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('priceCents');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'accepts isPaid: false and priceCents: null explicitly (the only legal non-default-shaped values) and persists the safe defaults',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'dormant-explicit-safe-manager' });
        const agent = await loginAs(app, manager);
        const window = futureWindow();

        const res = await agent.post('/api/v1/admin/events').send({
          title: uniqueTitle('Explicit Safe Defaults'),
          description: 'A perfectly ordinary description, long enough to be valid.',
          startsAt: window.startsAt.toISOString(),
          endsAt: window.endsAt.toISOString(),
          branch: 'CAPE_TOWN',
          locationDetail: 'Some Venue',
          isPaid: false,
          priceCents: null,
        });

        expect(res.status).toBe(201);
        expect(res.body.event.isPaid).toBe(false);
        expect(res.body.event.priceCents).toBeNull();

        createdEventIds.push(res.body.event.id);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // PATCH /admin/events/:id — update (registration-count-augmented response)
  // ===========================================================================
  describe('PATCH /admin/events/:id', () => {
    it(
      "an Event Manager who didn't create the event MAY still update it (no per-resource ownership boundary — by design)",
      async () => {
        const app = createApp();
        const creator = await createTestUser({ label: 'patch-creator' });
        const otherManager = await createTestUser({ label: 'patch-other-manager' });
        const event = await createEventFixture({ createdById: creator.id });

        const agent = await loginAs(app, otherManager);
        const res = await agent.patch(`/api/v1/admin/events/${event.id}`).send({ title: 'Edited By Another Manager' });

        expect(res.status).toBe(200);
        expect(res.body.event.title).toBe('Edited By Another Manager');
        expect(res.body).toHaveProperty('registrationCount');
        expect(res.body.registrationCount).toBe(0);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a nonexistent event id',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'patch-notfound-manager' });
        const agent = await loginAs(app, manager);

        const res = await agent.patch(`/api/v1/admin/events/${randomUUID()}`).send({ title: 'Whatever' });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an empty body with 400 VALIDATION_ERROR ("at least one field" guard)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'patch-empty-manager' });
        const event = await createEventFixture({ createdById: manager.id });
        const agent = await loginAs(app, manager);

        const res = await agent.patch(`/api/v1/admin/events/${event.id}`).send({});

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // POST /admin/events/:id/status — explicit, graph-enforced status transition
  // ===========================================================================
  describe('POST /admin/events/:id/status — status-transition graph enforcement', () => {
    it(
      'transitions DRAFT -> PUBLISHED (200) and returns the registration-count-augmented shape',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'status-happy-manager' });
        const event = await createEventFixture({ createdById: manager.id, status: 'DRAFT' });
        const agent = await loginAs(app, manager);

        const res = await agent.post(`/api/v1/admin/events/${event.id}/status`).send({ to: 'PUBLISHED' });

        expect(res.status).toBe(200);
        expect(res.body.event).toMatchObject({ id: event.id, status: 'PUBLISHED' });
        expect(res.body).toHaveProperty('registrationCount');
        expect(res.body.registrationCount).toBe(0);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows the documented CANCELLED -> PUBLISHED "reopen" transition (200)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'status-reopen-manager' });
        const event = await createEventFixture({ createdById: manager.id, status: 'CANCELLED' });
        const agent = await loginAs(app, manager);

        const res = await agent.post(`/api/v1/admin/events/${event.id}/status`).send({ to: 'PUBLISHED' });

        expect(res.status).toBe(200);
        expect(res.body.event.status).toBe('PUBLISHED');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an illegal same-state transition with 409 CONFLICT, leaving the event unchanged',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'status-samestate-manager' });
        const event = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED' });
        const agent = await loginAs(app, manager);

        const res = await agent.post(`/api/v1/admin/events/${event.id}/status`).send({ to: 'PUBLISHED' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');

        const reloaded = await db.event.findUnique({ where: { id: event.id } });
        expect(reloaded?.status).toBe('PUBLISHED');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an unknown status value with 400 VALIDATION_ERROR before reaching the service',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'status-invalid-manager' });
        const event = await createEventFixture({ createdById: manager.id, status: 'DRAFT' });
        const agent = await loginAs(app, manager);

        const res = await agent.post(`/api/v1/admin/events/${event.id}/status`).send({ to: 'NOT_A_REAL_STATUS' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('to');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a nonexistent event id',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'status-notfound-manager' });
        const agent = await loginAs(app, manager);

        const res = await agent.post(`/api/v1/admin/events/${randomUUID()}/status`).send({ to: 'PUBLISHED' });

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // PATCH /admin/events/:id/slug — Admin-only manual slug edit
  // ===========================================================================
  describe('PATCH /admin/events/:id/slug — Admin-only manual slug edit', () => {
    it(
      'rejects an Event Manager (even one who may otherwise manage this event) with 403 FORBIDDEN — this route is Admin-only',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'slug-route-manager-blocked' });
        const event = await createEventFixture({ createdById: manager.id });
        const agent = await loginAs(app, manager);

        const res = await agent
          .patch(`/api/v1/admin/events/${event.id}/slug`)
          .send({ slug: `manager-attempted-rename-${uniqueSuffix()}` });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');

        const reloaded = await db.event.findUnique({ where: { id: event.id } });
        expect(reloaded?.slug).toBe(event.slug);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an Admin to set a fresh, valid slug on ANY event (200)',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'slug-route-admin', role: 'ADMIN' });
        const manager = await createTestUser({ label: 'slug-route-manager' });
        const event = await createEventFixture({ createdById: manager.id });
        const agent = await loginAs(app, admin);

        const newSlug = `admin-renamed-${uniqueSuffix()}`;
        const res = await agent.patch(`/api/v1/admin/events/${event.id}/slug`).send({ slug: newSlug });

        expect(res.status).toBe(200);
        expect(res.body.event.slug).toBe(newSlug);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a malformed slug (uppercase/spaces) with 400 VALIDATION_ERROR before reaching the service',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'slug-route-malformed-admin', role: 'ADMIN' });
        const manager = await createTestUser({ label: 'slug-route-malformed-manager' });
        const event = await createEventFixture({ createdById: manager.id });
        const agent = await loginAs(app, admin);

        const res = await agent.patch(`/api/v1/admin/events/${event.id}/slug`).send({ slug: 'Not A Valid Slug!' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('slug');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // DELETE /admin/events/:id
  // ===========================================================================
  describe('DELETE /admin/events/:id', () => {
    it(
      'deletes an event with zero registrations (204) and it is genuinely gone afterward',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'delete-happy-manager' });
        const event = await createEventFixture({ createdById: manager.id });
        const agent = await loginAs(app, manager);

        const res = await agent.delete(`/api/v1/admin/events/${event.id}`);
        expect(res.status).toBe(204);

        createdEventIds = createdEventIds.filter((id) => id !== event.id);

        const reloaded = await db.event.findUnique({ where: { id: event.id } });
        expect(reloaded).toBeNull();
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 409 CONFLICT (not a raw FK-violation error) for an event with existing registrations, and does not delete it',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'delete-blocked-manager' });
        const event = await createEventFixture({ createdById: manager.id, status: 'PUBLISHED', capacity: 5 });
        const agent = await loginAs(app, manager);

        await db.registration.create({
          data: {
            eventId: event.id,
            firstName: 'Blocking',
            surname: 'Registrant',
            age: 29,
            email: `blocking-${uniqueSuffix()}@example.invalid`,
            phone: '+27000000008',
            consentVersion: 'v1-PLACEHOLDER',
            retainUntil: null,
          },
        });

        const res = await agent.delete(`/api/v1/admin/events/${event.id}`);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
        expect(res.body.error.message).toContain('1');

        const reloaded = await db.event.findUnique({ where: { id: event.id } });
        expect(reloaded).not.toBeNull();
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a nonexistent event id',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'delete-notfound-manager' });
        const agent = await loginAs(app, manager);

        const res = await agent.delete(`/api/v1/admin/events/${randomUUID()}`);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // GET /admin/events/:id and GET /admin/events — admin reads, no ownership scoping
  // ===========================================================================
  describe('GET /admin/events and GET /admin/events/:id — no per-resource ownership scoping', () => {
    it(
      'GET /admin/events lists every event regardless of which manager created it',
      async () => {
        const app = createApp();
        const managerA = await createTestUser({ label: 'admin-list-manager-a' });
        const managerB = await createTestUser({ label: 'admin-list-manager-b' });

        const eventA = await createEventFixture({ createdById: managerA.id });
        const eventB = await createEventFixture({ createdById: managerB.id });

        const agent = await loginAs(app, managerA);
        const res = await agent.get('/api/v1/admin/events').query({ limit: 100 });

        expect(res.status).toBe(200);
        const ids: string[] = res.body.items.map((e: { id: string }) => e.id);
        expect(ids).toContain(eventA.id);
        expect(ids).toContain(eventB.id);
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'GET /admin/events/:id lets any Event Manager view any event, including drafts',
      async () => {
        const app = createApp();
        const creator = await createTestUser({ label: 'admin-detail-creator' });
        const otherManager = await createTestUser({ label: 'admin-detail-other-manager' });
        const draft = await createEventFixture({ createdById: creator.id, status: 'DRAFT' });

        const agent = await loginAs(app, otherManager);
        const res = await agent.get(`/api/v1/admin/events/${draft.id}`);

        expect(res.status).toBe(200);
        expect(res.body.event).toMatchObject({ id: draft.id, status: 'DRAFT' });
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'GET /admin/events/:id returns 404 NOT_FOUND for a nonexistent event id',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'admin-detail-notfound-manager' });
        const agent = await loginAs(app, manager);

        const res = await agent.get(`/api/v1/admin/events/${randomUUID()}`);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      EVENTS_ROUTER_TEST_TIMEOUT_MS,
    );
  });
});
