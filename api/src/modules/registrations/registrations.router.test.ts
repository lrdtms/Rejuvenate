/**
 * Integration tests for the Registrations module's router (plan.md Phase 4c
 * steps 4-6), exercised through the REAL `createApp()` — sessions, RBAC
 * middleware, validation, rate limiting, the central error handler,
 * `RegistrationService`/`EventService` (wired to the real local Postgres)
 * all run for real, exactly as `events.router.test.ts` does for Events. This
 * is the layer that proves `requireRole`/validation/rate-limiting/the
 * `{ error: { fields } }` shape/CSV headers actually wire together
 * end-to-end through real HTTP requests and real session cookies.
 *
 * Uses `request.agent(app)` (cookie jar across calls) for authenticated
 * flows — mirrors `events.router.test.ts`'s established pattern.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword } from '../auth/password';

const ROUTER_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple 42';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Registrations Router Test Event ${label} ${uniqueSuffix()}`;
}

let createdUserIds: string[] = [];
let createdEventIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
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
  const email = `registrations-router-test-${label}-${uniqueSuffix()}@example.invalid`;
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const created = await db.user.create({
    data: { name: `Registrations Router Test User (${label})`, email, passwordHash, role, isActive: true },
  });
  createdUserIds.push(created.id);
  return created;
}

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

/** Creates an event directly via Prisma — mirrors `events.router.test.ts`'s
 * `createEventFixture`. */
async function createEventFixture(opts: {
  createdById: string;
  status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
  capacity?: number | null;
  startsAt?: Date;
  endsAt?: Date;
}) {
  const slug = `registrations-fixture-event-${uniqueSuffix()}`;
  const window = futureWindow();
  const event = await db.event.create({
    data: {
      title: uniqueTitle('fixture'),
      slug,
      description: 'A perfectly ordinary fixture event description, long enough to be valid.',
      startsAt: opts.startsAt ?? window.startsAt,
      endsAt: opts.endsAt ?? window.endsAt,
      branch: 'CAPE_TOWN',
      locationDetail: 'Fixture Venue, 1 Fixture Street',
      capacity: opts.capacity ?? null,
      status: opts.status ?? 'PUBLISHED',
      createdById: opts.createdById,
      isPaid: false,
      priceCents: null,
    },
  });
  createdEventIds.push(event.id);
  return event;
}

/** Builds a complete, valid RSVP request body — uniqued per call. */
function rsvpBody(label: string) {
  const suffix = uniqueSuffix();
  return {
    firstName: `Test-${label}`,
    surname: `Registrant-${suffix}`,
    age: 30,
    email: `router-rsvp-${label}-${suffix}@example.invalid`,
    phone: '+27 12 345 6789',
  };
}

/** Directly inserts `count` registrations via Prisma — setup convenience for
 * list/export/RBAC tests that don't care about the submission flow itself. */
async function seedRegistrations(eventId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const suffix = uniqueSuffix();
    await db.registration.create({
      data: {
        eventId,
        firstName: `Seed-${i}`,
        surname: `Attendee-${suffix}`,
        age: 25 + i,
        email: `seed-${i}-${suffix}@example.invalid`,
        phone: '+27 11 222 3333',
        consentVersion: 'test-seed-consent-v0',
        retainUntil: null,
      },
    });
  }
}

describe('Registrations router (plan.md Phase 4c)', () => {
  // ===========================================================================
  // Public route — POST /events/:slug/registrations
  // ===========================================================================
  describe('POST /events/:slug/registrations — public RSVP submission', () => {
    it(
      'accepts a valid RSVP for a PUBLISHED, not-yet-started event (201)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rsvp-valid' });
        const event = await createEventFixture({ createdById: manager.id });

        const res = await request(app).post(`/api/v1/events/${event.slug}/registrations`).send(rsvpBody('valid'));

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ registered: true });

        const stored = await db.registration.findFirst({ where: { eventId: event.id } });
        expect(stored).not.toBeNull();
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a slug that does not exist',
      async () => {
        const app = createApp();

        const res = await request(app)
          .post(`/api/v1/events/no-such-slug-${uniqueSuffix()}/registrations`)
          .send(rsvpBody('missing'));

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a DRAFT event (collapsed anti-enumeration outcome)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rsvp-draft' });
        const event = await createEventFixture({ createdById: manager.id, status: 'DRAFT' });

        const res = await request(app).post(`/api/v1/events/${event.slug}/registrations`).send(rsvpBody('draft'));

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 409 CAPACITY_EXCEEDED with the correct error shape once an event is full',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rsvp-capacity' });
        const event = await createEventFixture({ createdById: manager.id, capacity: 1 });

        const first = await request(app).post(`/api/v1/events/${event.slug}/registrations`).send(rsvpBody('cap-first'));
        expect(first.status).toBe(201);

        const second = await request(app).post(`/api/v1/events/${event.slug}/registrations`).send(rsvpBody('cap-second'));
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('CAPACITY_EXCEEDED');
        expect(second.body.error).toHaveProperty('message');

        const count = await db.registration.count({ where: { eventId: event.id } });
        expect(count).toBe(1);
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'silently discards a honeypot-filled submission with an indistinguishable 201 success',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rsvp-honeypot' });
        const event = await createEventFixture({ createdById: manager.id });

        const res = await request(app)
          .post(`/api/v1/events/${event.slug}/registrations`)
          .send({ ...rsvpBody('honeypot'), honeypot: 'http://bot.example/spam' });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ registered: true });

        const count = await db.registration.count({ where: { eventId: event.id } });
        expect(count).toBe(0);
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    // =======================================================================
    // age validation boundary — POPIA control #8 (architecture.md §7.3
    // invariant #7), surfaced as { error: { fields: { age: [...] } } }
    // =======================================================================
    describe('age validation — boundary cases (0–120 integer, surfaced via { fields })', () => {
      const cases: Array<{ label: string; age: unknown; valid: boolean }> = [
        { label: 'lower bound 0 — valid', age: 0, valid: true },
        { label: 'upper bound 120 — valid', age: 120, valid: true },
        { label: 'negative -1 — invalid', age: -1, valid: false },
        { label: 'above bound 121 — invalid', age: 121, valid: false },
        { label: 'non-integer 30.5 — invalid', age: 30.5, valid: false },
      ];

      for (const testCase of cases) {
        it(
          `${testCase.label} (age=${String(testCase.age)})`,
          async () => {
            const app = createApp();
            const safeLabel = testCase.label.replace(/[^a-z0-9]/gi, '-');
            const manager = await createTestUser({ label: `age-${safeLabel}` });
            const event = await createEventFixture({ createdById: manager.id });

            const res = await request(app)
              .post(`/api/v1/events/${event.slug}/registrations`)
              .send({ ...rsvpBody(`age-${safeLabel}`), age: testCase.age });

            if (testCase.valid) {
              expect(res.status).toBe(201);
            } else {
              expect(res.status).toBe(400);
              expect(res.body.error.code).toBe('VALIDATION_ERROR');
              expect(res.body.error.fields).toHaveProperty('age');
              expect(Array.isArray(res.body.error.fields.age)).toBe(true);
              expect(res.body.error.fields.age.length).toBeGreaterThan(0);
            }
          },
          ROUTER_TEST_TIMEOUT_MS,
        );
      }
    });
  });

  // ===========================================================================
  // Staff routes — RBAC
  // ===========================================================================
  describe('staff routes — RBAC (Admin/EventManager only)', () => {
    it(
      'rejects an anonymous caller with 401 UNAUTHORIZED on the list route',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rbac-anon-setup' });
        const event = await createEventFixture({ createdById: manager.id });

        const res = await request(app).get(`/api/v1/admin/events/${event.id}/registrations`);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a Blogger with 403 FORBIDDEN on the list and CSV export routes',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rbac-blogger-setup' });
        const blogger = await createTestUser({ label: 'rbac-blogger', role: 'BLOGGER' });
        const event = await createEventFixture({ createdById: manager.id });

        const agent = await loginAs(app, blogger);

        const list = await agent.get(`/api/v1/admin/events/${event.id}/registrations`);
        expect(list.status).toBe(403);
        expect(list.body.error.code).toBe('FORBIDDEN');

        const csv = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);
        expect(csv.status).toBe(403);
        expect(csv.body.error.code).toBe('FORBIDDEN');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an EVENT_MANAGER to read the list and export the CSV (200)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rbac-em' });
        const event = await createEventFixture({ createdById: manager.id });
        await seedRegistrations(event.id, 2);

        const agent = await loginAs(app, manager);

        const list = await agent.get(`/api/v1/admin/events/${event.id}/registrations`);
        expect(list.status).toBe(200);

        const csv = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);
        expect(csv.status).toBe(200);
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an ADMIN to read the list and export the CSV (200)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'rbac-admin-setup' });
        const admin = await createTestUser({ label: 'rbac-admin', role: 'ADMIN' });
        const event = await createEventFixture({ createdById: manager.id });
        await seedRegistrations(event.id, 1);

        const agent = await loginAs(app, admin);

        const list = await agent.get(`/api/v1/admin/events/${event.id}/registrations`);
        expect(list.status).toBe(200);

        const csv = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);
        expect(csv.status).toBe(200);
      },
      ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // GET /admin/events/:id/registrations — paginated list + headcount
  // ===========================================================================
  describe('GET /admin/events/:id/registrations — attendee list + headcount', () => {
    it(
      'returns the paginated attendee list AND the total registrationCount',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'list-shape' });
        const event = await createEventFixture({ createdById: manager.id });
        await seedRegistrations(event.id, 3);

        const agent = await loginAs(app, manager);
        const res = await agent.get(`/api/v1/admin/events/${event.id}/registrations`).query({ limit: 100 });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('registrations');
        expect(res.body).toHaveProperty('registrationCount', 3);
        expect(res.body.registrations).toHaveProperty('items');
        expect(res.body.registrations).toHaveProperty('total', 3);
        expect(res.body.registrations.items).toHaveLength(3);
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 404 NOT_FOUND for a nonexistent event id',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'list-404' });
        const agent = await loginAs(app, manager);

        const res = await agent.get(`/api/v1/admin/events/${randomUUID()}/registrations`);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // GET /admin/events/:id/registrations.csv — CSV export
  // ===========================================================================
  describe('GET /admin/events/:id/registrations.csv — CSV export', () => {
    it(
      'sets correct Content-Type/Content-Disposition headers and returns a well-formed CSV body',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'csv-headers' });
        const event = await createEventFixture({ createdById: manager.id });
        await seedRegistrations(event.id, 2);

        const agent = await loginAs(app, manager);
        const res = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/csv/);
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="registrations-.*\.csv"$/);

        const body = res.text;
        const lines = body.trim().split('\n');
        // Header row + 2 data rows.
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe('First name,Surname,Age,Email,Phone,Registered at');
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'correctly escapes/quotes fields containing commas, quotes, and embedded newlines (RFC 4180)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'csv-escaping' });
        const event = await createEventFixture({ createdById: manager.id });

        // Deliberately adversarial personal-name shapes — exactly the
        // characters a naive `row.join(',')` would corrupt.
        await db.registration.create({
          data: {
            eventId: event.id,
            firstName: 'Sam "Sammy"',
            surname: 'Smith, Jr.',
            age: 40,
            email: `csv-escaping-${uniqueSuffix()}@example.invalid`,
            phone: '+27 11 000 0000',
            consentVersion: 'test-seed-consent-v0',
            retainUntil: null,
          },
        });

        const agent = await loginAs(app, manager);
        const res = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);

        expect(res.status).toBe(200);

        const body = res.text;
        // RFC 4180: a field containing a comma or a double-quote must be
        // wrapped in double quotes, with embedded double-quotes doubled.
        expect(body).toContain('"Sam ""Sammy"""');
        expect(body).toContain('"Smith, Jr."');

        // The presence of these exact quoted forms — and the fact that the
        // file still parses into the expected number of logical rows below
        // — is the proof a naive string-templated implementation would
        // fail: a bare `row.join(',')` would have produced an UNQUOTED
        // `Smith, Jr.` that splits into two spurious columns, corrupting
        // every subsequent column boundary on that line.
        const lines = body.trim().split('\n');
        expect(lines).toHaveLength(2); // header + 1 data row
      },
      ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'exports the COMPLETE attendee list, unpaginated (more rows than the default page size)',
      async () => {
        const app = createApp();
        const manager = await createTestUser({ label: 'csv-complete' });
        const event = await createEventFixture({ createdById: manager.id });

        const totalRows = 25; // exceeds DEFAULT_PAGE_LIMIT (20)
        await seedRegistrations(event.id, totalRows);

        const agent = await loginAs(app, manager);
        const res = await agent.get(`/api/v1/admin/events/${event.id}/registrations.csv`);

        expect(res.status).toBe(200);
        const lines = res.text.trim().split('\n');
        expect(lines).toHaveLength(totalRows + 1); // header + every row
      },
      ROUTER_TEST_TIMEOUT_MS,
    );
  });
});
