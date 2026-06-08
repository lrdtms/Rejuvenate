/**
 * Integration tests for the CMS module's router (plan.md Phase 4d steps 3-4),
 * exercised through the REAL `createApp()` — sessions, RBAC middleware,
 * validation, the central error handler, `CmsService`, and `CmsRepository`
 * (itself wired to the real local Postgres) all run for real, exactly as
 * `blog.router.test.ts`/`registrations.router.test.ts` do for their
 * concerns. This is the right layer to verify "does
 * `requireRole(authService, 'ADMIN')` actually gate these routes end-to-end,
 * and does the batch endpoint actually produce the documented map shape over
 * real HTTP" — questions `cms.service.test.ts`'s direct-service-call tests
 * cannot answer (they bypass the router, the RBAC gate, and the HTTP/session
 * machinery entirely).
 *
 * Uses `request.agent(app)` (cookie jar across calls) for every flow that
 * needs an authenticated session — login once, then issue the real request
 * under test — mirroring `blog.router.test.ts`'s established pattern.
 *
 * Real argon2id hashing is in the loop for every login — generous per-test
 * timeouts mirror `blog.router.test.ts`'s `BLOG_ROUTER_TEST_TIMEOUT_MS`.
 *
 * See `cms.service.test.ts`'s file header for why this suite, like that one,
 * works against the SEEDED `CMSContent` rows (capture/delete/restore for the
 * "registered-but-unpopulated" scenario, restore-in-`finally` for write
 * round-trips) rather than per-test-created throwaway rows — `CMSContent`
 * has a fixed, six-row registry; there is no "create a new slot" operation.
 */
import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CMSContent } from '@prisma/client';

import { createApp } from '../../app';
import { db } from '../../lib/db';
import { hashPassword } from '../auth/password';
import { CMS_SLOTS } from './cms.slots';

const CMS_ROUTER_TEST_TIMEOUT_MS = 20_000;
const TEST_PASSWORD = 'correct horse battery staple cms 42';

// -----------------------------------------------------------------------------
// Slot-key choices are DELIBERATELY DISJOINT from `cms.service.test.ts`'s
// mutating fixtures — both suites run as SEPARATE TEST FILES, which Vitest by
// default executes in PARALLEL (separate processes) against the SAME shared
// local Postgres database. `cms.service.test.ts` mutates (writes/removes/
// restores) the row at `about.card.who-are-we` via its `PLAIN_TEXT_SLOT_KEY`
// and `restoreSlotValue`/`withSlotRowRemoved`; if this suite's mutating tests
// (`PUT /admin/cms/:slotKey`, `withSlotRowRemoved`) targeted that SAME row
// concurrently, the two suites' delete/upsert/restore sequences could
// interleave — e.g. one suite's `restoreRow` racing the other's
// `withSlotRowRemoved` delete — producing exactly the kind of intermittent
// "row not found" / "value mismatch" flake that is incredibly painful to
// reproduce locally (it appeared in CI-style `vitest run` but not when this
// file was run in isolation). The fix is the simplest one available: give
// each suite its OWN slice of the six-slot registry to mutate.
//
//   - `cms.service.test.ts` owns `about.card.who-are-we` (mutating) and reads
//     `about.card.what-we-do` (read-only — map-membership assertions only,
//     never written/removed there).
//   - THIS suite owns `contact.capeTown.card` / `contact.durban.card`
//     (mutating — PUT + `withSlotRowRemoved` + `restoreRow`) and reads
//     `about.card.what-we-do` (read-only — same safe slot the other suite
//     also only reads, so two read-only consumers cannot race each other).
//
// Both partitions are exercised against the real, full six-slot registry
// (`CMS_SLOTS`), so no coverage is lost — each suite simply mutates a
// different (real, registered) member of it.
// -----------------------------------------------------------------------------
const PLAIN_TEXT_SLOT_KEY = 'contact.capeTown.card';
const SECOND_SLOT_KEY = 'about.card.what-we-do';
const THIRD_SLOT_KEY = 'contact.durban.card';

function uniqueSuffix(): string {
  return randomUUID();
}

/** See `cms.service.test.ts`'s identical `beforeAll` for the full "why this
 * suite must be self-sufficient rather than depending on `npm run
 * prisma:seed` having been run" rationale — `upsert`ed (idempotent, never
 * clobbers real content) so every registered slot has a row before any
 * "populated slot" assertion runs, in any environment. */
beforeAll(async () => {
  for (const slot of CMS_SLOTS) {
    await db.cMSContent.upsert({
      where: { slotKey: slot.slotKey },
      create: { slotKey: slot.slotKey, format: slot.format, value: '' },
      update: {},
    });
  }
});

let createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

async function createTestUser(opts: { label: string; role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER' }) {
  const { label, role = 'ADMIN' } = opts;
  const email = `cms-router-test-${label}-${uniqueSuffix()}@example.invalid`;
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const created = await db.user.create({
    data: { name: `CMS Router Test User (${label})`, email, passwordHash, role, isActive: true },
  });
  createdUserIds.push(created.id);
  return created;
}

/** Logs the given user in on a fresh `supertest.agent` and returns the agent
 * — every subsequent request through it carries the session cookie, exactly
 * like a real authenticated browser tab (mirrors `blog.router.test.ts`). */
async function loginAs(app: ReturnType<typeof createApp>, user: { email: string }) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

/** Restores `slotKey`'s row to a previously-captured state — the standard
 * "leave the shared seeded fixture as found" cleanup this module's tests use
 * (see `cms.service.test.ts`'s file-header note for the full rationale). */
async function restoreRow(prior: CMSContent): Promise<void> {
  await db.cMSContent.upsert({
    where: { slotKey: prior.slotKey },
    create: {
      slotKey: prior.slotKey,
      format: prior.format,
      value: prior.value,
      lastEditedById: prior.lastEditedById,
    },
    update: { format: prior.format, value: prior.value, lastEditedById: prior.lastEditedById },
  });
}

/** Captures, deletes, runs `fn`, restores — the router-suite counterpart of
 * `cms.service.test.ts`'s `withSlotRowRemoved`, used here to exercise the
 * "registered-but-unpopulated" contract through the real HTTP surface. */
async function withSlotRowRemoved<T>(slotKey: string, fn: () => Promise<T>): Promise<T> {
  const original = await db.cMSContent.findUnique({ where: { slotKey } });
  if (original) {
    await db.cMSContent.delete({ where: { slotKey } });
  }
  try {
    return await fn();
  } finally {
    if (original) {
      await restoreRow(original);
    }
  }
}

describe('CMS router (plan.md Phase 4d steps 3-4)', () => {
  // ===========================================================================
  // GET /cms — public, batched slot-value fetch
  // ===========================================================================
  describe('GET /cms?keys=a,b,c — public batch fetch', () => {
    it('returns 200 with a { slots: { ... } } MAP keyed by slotKey, not an array, for an anonymous caller', async () => {
      const app = createApp();

      const res = await request(app).get(
        `/api/v1/cms?keys=${encodeURIComponent(`${PLAIN_TEXT_SLOT_KEY},${SECOND_SLOT_KEY}`)}`,
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.slots)).toBe(false);
      expect(typeof res.body.slots).toBe('object');

      const keys = Object.keys(res.body.slots).sort();
      expect(keys).toEqual([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY].sort());

      for (const key of keys) {
        expect(res.body.slots[key]).toMatchObject({
          slotKey: key,
          format: expect.any(String),
          value: expect.any(String),
        });
        // `updatedAt` must be present (either an ISO string for a populated
        // slot, or `null` for a registered-but-unpopulated one — see the
        // dedicated test below) — never simply absent from the entry.
        expect('updatedAt' in res.body.slots[key]).toBe(true);
      }
    });

    it('includes EVERY requested key, including a registered-but-unpopulated one with a safe empty value — never omits it', async () => {
      const app = createApp();

      await withSlotRowRemoved(PLAIN_TEXT_SLOT_KEY, async () => {
        const res = await request(app).get(
          `/api/v1/cms?keys=${encodeURIComponent(`${PLAIN_TEXT_SLOT_KEY},${SECOND_SLOT_KEY}`)}`,
        );

        expect(res.status).toBe(200);
        const keys = Object.keys(res.body.slots).sort();
        expect(keys).toEqual([PLAIN_TEXT_SLOT_KEY, SECOND_SLOT_KEY].sort());

        expect(res.body.slots[PLAIN_TEXT_SLOT_KEY]).toEqual({
          slotKey: PLAIN_TEXT_SLOT_KEY,
          format: 'PLAIN_TEXT',
          value: '',
          updatedAt: null,
        });
      });
    });

    it('omits an out-of-registry requested key from the response map (does not 400, does not include a placeholder entry)', async () => {
      const app = createApp();
      const unknownKey = `not.a.real.slot.${uniqueSuffix()}`;

      const res = await request(app).get(
        `/api/v1/cms?keys=${encodeURIComponent(`${PLAIN_TEXT_SLOT_KEY},${unknownKey}`)}`,
      );

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.slots)).toEqual([PLAIN_TEXT_SLOT_KEY]);
      expect(res.body.slots[unknownKey]).toBeUndefined();
    });

    it('rejects a request with no usable keys (400 VALIDATION_ERROR)', async () => {
      const app = createApp();

      const resEmpty = await request(app).get('/api/v1/cms?keys=');
      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body.error.code).toBe('VALIDATION_ERROR');

      const resWhitespace = await request(app).get('/api/v1/cms?keys=' + encodeURIComponent(' , , '));
      expect(resWhitespace.status).toBe(400);
      expect(resWhitespace.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a request missing the keys param entirely (400 VALIDATION_ERROR)', async () => {
      const app = createApp();

      const res = await request(app).get('/api/v1/cms');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ===========================================================================
  // Admin routes — authentication/role gating (ADMIN-only, per plan.md step 4)
  // ===========================================================================
  describe('admin routes — authentication/role gating (ADMIN ONLY — not BLOGGER/EVENT_MANAGER)', () => {
    it('rejects an anonymous caller on GET /admin/cms/:slotKey with 401 UNAUTHORIZED', async () => {
      const app = createApp();

      const res = await request(app).get(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects an anonymous caller on PUT /admin/cms/:slotKey with 401 UNAUTHORIZED', async () => {
      const app = createApp();

      const res = await request(app).put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: 'x' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it(
      'rejects an authenticated BLOGGER (wrong role — CMS is ADMIN-only, unlike Blog/Events) with 403 FORBIDDEN',
      async () => {
        const app = createApp();
        const blogger = await createTestUser({ label: 'wrong-role-blogger', role: 'BLOGGER' });
        const agent = await loginAs(app, blogger);

        const getRes = await agent.get(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`);
        expect(getRes.status).toBe(403);
        expect(getRes.body.error.code).toBe('FORBIDDEN');

        const putRes = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: 'x' });
        expect(putRes.status).toBe(403);
        expect(putRes.body.error.code).toBe('FORBIDDEN');
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects an authenticated EVENT_MANAGER (wrong role — CMS is ADMIN-only, unlike Events) with 403 FORBIDDEN',
      async () => {
        const app = createApp();
        const eventManager = await createTestUser({ label: 'wrong-role-event-manager', role: 'EVENT_MANAGER' });
        const agent = await loginAs(app, eventManager);

        const getRes = await agent.get(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`);
        expect(getRes.status).toBe(403);
        expect(getRes.body.error.code).toBe('FORBIDDEN');

        const putRes = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: 'x' });
        expect(putRes.status).toBe(403);
        expect(putRes.body.error.code).toBe('FORBIDDEN');
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'allows an authenticated ADMIN through both GET and PUT /admin/cms/:slotKey',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'correct-role-admin', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        const prior = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: THIRD_SLOT_KEY } });
        try {
          const getRes = await agent.get(`/api/v1/admin/cms/${THIRD_SLOT_KEY}`);
          expect(getRes.status).toBe(200);
          expect(getRes.body.slot.slotKey).toBe(THIRD_SLOT_KEY);

          const putRes = await agent
            .put(`/api/v1/admin/cms/${THIRD_SLOT_KEY}`)
            .send({ value: `Admin-written value ${uniqueSuffix()}` });
          expect(putRes.status).toBe(200);
          expect(putRes.body.slot.slotKey).toBe(THIRD_SLOT_KEY);
        } finally {
          await restoreRow(prior);
        }
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // GET /admin/cms/:slotKey — single-slot read
  // ===========================================================================
  describe('GET /admin/cms/:slotKey', () => {
    it(
      'returns the registered-but-unpopulated safe-empty default (200, not 404) when no row exists yet',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'get-unpopulated', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        await withSlotRowRemoved(PLAIN_TEXT_SLOT_KEY, async () => {
          const res = await agent.get(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`);

          expect(res.status).toBe(200);
          expect(res.body.slot).toEqual({
            slotKey: PLAIN_TEXT_SLOT_KEY,
            format: 'PLAIN_TEXT',
            value: '',
            updatedAt: null,
          });
        });
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'returns 400 UNKNOWN_SLOT for an out-of-registry slotKey (precise, named — not a generic 404)',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'get-unknown', role: 'ADMIN' });
        const agent = await loginAs(app, admin);
        const unknownKey = `not.a.real.slot.${uniqueSuffix()}`;

        const res = await agent.get(`/api/v1/admin/cms/${unknownKey}`);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('UNKNOWN_SLOT');
        expect(res.body.error.message).toContain(unknownKey);
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );
  });

  // ===========================================================================
  // PUT /admin/cms/:slotKey — single-slot write
  // ===========================================================================
  describe('PUT /admin/cms/:slotKey', () => {
    it(
      'writes a value, stamps lastEditedById, and the SAME value round-trips through GET /admin/cms/:slotKey AND the public batch endpoint',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'round-trip-admin', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        const prior = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
        const newValue = `Round-trip via HTTP ${uniqueSuffix()} — "quoted" & <unescaped>`;

        try {
          const putRes = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: newValue });
          expect(putRes.status).toBe(200);
          expect(putRes.body.slot).toMatchObject({ slotKey: PLAIN_TEXT_SLOT_KEY, value: newValue });

          // Stamped attribution — visible via the admin GET (and verifiable
          // directly against the DB row).
          const persisted = await db.cMSContent.findUniqueOrThrow({ where: { slotKey: PLAIN_TEXT_SLOT_KEY } });
          expect(persisted.lastEditedById).toBe(admin.id);
          expect(persisted.value).toBe(newValue);

          // Round-trip #1 — admin single-slot GET.
          const adminGetRes = await agent.get(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`);
          expect(adminGetRes.status).toBe(200);
          expect(adminGetRes.body.slot.value).toBe(newValue);
          expect(adminGetRes.body.slot.updatedAt).toBe(putRes.body.slot.updatedAt);

          // Round-trip #2 — public batch endpoint, same exact value.
          const publicRes = await request(app).get(`/api/v1/cms?keys=${encodeURIComponent(PLAIN_TEXT_SLOT_KEY)}`);
          expect(publicRes.status).toBe(200);
          expect(publicRes.body.slots[PLAIN_TEXT_SLOT_KEY].value).toBe(newValue);
          expect(publicRes.body.slots[PLAIN_TEXT_SLOT_KEY].updatedAt).toBe(putRes.body.slot.updatedAt);
        } finally {
          await restoreRow(prior);
        }
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a write to an out-of-registry slotKey with 400 UNKNOWN_SLOT and persists nothing',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'put-unknown', role: 'ADMIN' });
        const agent = await loginAs(app, admin);
        const unknownKey = `not.a.real.slot.${uniqueSuffix()}`;

        const res = await agent.put(`/api/v1/admin/cms/${unknownKey}`).send({ value: 'should not persist' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('UNKNOWN_SLOT');

        const phantom = await db.cMSContent.findUnique({ where: { slotKey: unknownKey } });
        expect(phantom).toBeNull();
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a write whose value exceeds the configured length ceiling with 400 VALIDATION_ERROR naming the value field',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'put-too-long', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        const { MAX_SLOT_VALUE_LENGTH } = await import('./cms.constants');
        const tooLong = 'x'.repeat(MAX_SLOT_VALUE_LENGTH + 1);

        const res = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: tooLong });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.fields).toHaveProperty('value');
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );

    it(
      'rejects a write with a missing/non-string value with 400 VALIDATION_ERROR',
      async () => {
        const app = createApp();
        const admin = await createTestUser({ label: 'put-bad-shape', role: 'ADMIN' });
        const agent = await loginAs(app, admin);

        const missing = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({});
        expect(missing.status).toBe(400);
        expect(missing.body.error.code).toBe('VALIDATION_ERROR');

        const wrongType = await agent.put(`/api/v1/admin/cms/${PLAIN_TEXT_SLOT_KEY}`).send({ value: 12345 });
        expect(wrongType.status).toBe(400);
        expect(wrongType.body.error.code).toBe('VALIDATION_ERROR');
      },
      CMS_ROUTER_TEST_TIMEOUT_MS,
    );
  });
});
