/**
 * Integration tests for `EventService` (plan.md Phase 4b steps 1-2, 4),
 * mirroring `blog.service.test.ts`'s "real Postgres, real repository, no
 * DB-mocking infrastructure" posture verbatim — see that file's header for
 * the full "why no mocks" rationale, which transfers unchanged.
 *
 * Coverage map (mirrors `events.service.ts`'s own doc-comment structure, so a
 * reader can cross-reference "is the documented decision X actually tested?"
 * directly):
 *   - DECISION 1 (slug policy)            -> "createEvent — slug policy"
 *   - DECISION 2 (status transition graph) -> "transitionStatus — the
 *     status-transition graph"
 *   - dormant `isPaid`/`priceCents`        -> "dormant paid fields"
 *   - DECISION 3 (no per-Event-Manager      -> "EVENT_MANAGER ownership — any
 *     ownership boundary)                     manager may act on any event"
 *   - "no scheduling gap" / public          -> "public visibility contract"
 *     visibility contract
 *   - upcoming/past semantics (`endsAt`)    -> "getPublished — upcoming/past
 *                                              semantics"
 *   - the registration-count-awareness hook -> woven through the transition-
 *                                              graph and update describe blocks
 *
 * Note: the GENUINE concurrency proof for `tryRegisterWithCapacityCheck`'s
 * underlying primitive lives in `events.repository.test.ts` (the
 * `Promise.all`-driven `tryRegisterAtomically` tests) — see that file's header
 * for why the concurrency assertion belongs at the repository layer (closest
 * to the actual database behaviour being proven) rather than re-derived here.
 * This file's capacity-check tests instead focus on the SERVICE's own added
 * value: the existence check, the fast advisory pre-check, and the
 * `capacityExceeded()` translation — sequential, single-attempt scenarios that
 * would be redundant (not complementary) if they tried to re-prove the race.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { AuthenticatedUser } from '../auth/auth.service';
import { createEventRepository } from './events.repository';
import { createEventService, type EventService } from './events.service';

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Test Event ${label} ${uniqueSuffix()}`;
}

const repository = createEventRepository({ db });
const service: EventService = createEventService({ repository });

let createdUserIds: string[] = [];
let createdEventIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
    // `Registration` rows must be cleared first — `onDelete: Restrict` (see
    // `prisma/schema.prisma`'s inline note) would otherwise block `Event`
    // cleanup exactly as it would in production; mirrors
    // `events.repository.test.ts`'s identical cleanup discipline.
    await db.registration.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

/** Bare-minimum throwaway `User` row — mirrors `blog.service.test.ts`'s
 * `createTestUser` "argon2id cost is irrelevant to these tests" posture. */
async function createTestUser(opts: {
  label: string;
  role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER';
}): Promise<AuthenticatedUser> {
  const { label, role = 'EVENT_MANAGER' } = opts;
  const created = await db.user.create({
    data: {
      name: `Events Service Test User (${label})`,
      email: `events-service-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role,
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return { id: created.id, name: created.name, email: created.email, role: created.role, isActive: true };
}

/** Future, valid `startsAt`/`endsAt` window — the "this event hasn't started
 * yet" baseline every fixture needs unless a test deliberately wants a
 * past/in-progress event. */
function futureWindow(opts?: { startInMs?: number; durationMs?: number }) {
  const startInMs = opts?.startInMs ?? 24 * 60 * 60 * 1000; // +1 day
  const durationMs = opts?.durationMs ?? 60 * 60 * 1000; // +1 hour
  return {
    startsAt: new Date(Date.now() + startInMs),
    endsAt: new Date(Date.now() + startInMs + durationMs),
  };
}

/** Creates a DRAFT event through the real service — the standard fixture for
 * tests that need a "just created" event. */
async function createDraftEvent(
  actor: AuthenticatedUser,
  opts?: { title?: string; capacity?: number | null; window?: { startsAt: Date; endsAt: Date } },
) {
  const window = opts?.window ?? futureWindow();
  const event = await service.createEvent(actor, {
    title: opts?.title ?? uniqueTitle('draft'),
    description: 'A perfectly ordinary test event description, long enough to be valid.',
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    branch: 'CAPE_TOWN',
    locationDetail: 'Test Venue, 1 Test Street',
    capacity: opts?.capacity ?? null,
  });
  createdEventIds.push(event.id);
  return event;
}

describe('EventService (plan.md Phase 4b steps 1-2, 4)', () => {
  // =========================================================================
  // DECISION 1 — slug policy: generated at creation, stable thereafter
  // =========================================================================
  describe('createEvent — slug policy (creation-time, identical to Blog)', () => {
    it('generates and persists a non-null, unique slug at creation time, as DRAFT', async () => {
      const manager = await createTestUser({ label: 'create-slug' });

      const event = await createDraftEvent(manager, { title: uniqueTitle('Hello World') });

      expect(event.slug).toBeTruthy();
      expect(event.slug.length).toBeGreaterThan(0);
      expect(event.status).toBe('DRAFT');
      expect(event.isPaid).toBe(false);
      expect(event.priceCents).toBeNull();

      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded?.slug).toBe(event.slug);
    });

    it('keeps the slug stable across publish/unpublish/title-update — never regenerates it', async () => {
      const manager = await createTestUser({ label: 'slug-stability' });
      const event = await createDraftEvent(manager);
      const originalSlug = event.slug;

      const published = await service.transitionStatus(manager, event.id, 'PUBLISHED');
      expect(published.event.slug).toBe(originalSlug);
      expect(published.event.status).toBe('PUBLISHED');

      const unpublished = await service.transitionStatus(manager, event.id, 'DRAFT');
      expect(unpublished.event.slug).toBe(originalSlug);
      expect(unpublished.event.status).toBe('DRAFT');

      const updated = await service.updateEvent(manager, event.id, { title: 'A Brand New Title Entirely' });
      expect(updated.event.slug).toBe(originalSlug);
      expect(updated.event.title).toBe('A Brand New Title Entirely');
    });

    it('appends -2, -3, ... for titles that slugify to the same base', async () => {
      const manager = await createTestUser({ label: 'slug-collision' });
      const sharedTitle = `Collision Title ${uniqueSuffix()}`;

      const first = await createDraftEvent(manager, { title: sharedTitle });
      const second = await createDraftEvent(manager, { title: sharedTitle });
      const third = await createDraftEvent(manager, { title: sharedTitle });

      expect(second.slug).toBe(`${first.slug}-2`);
      expect(third.slug).toBe(`${first.slug}-3`);

      const slugs = [first.slug, second.slug, third.slug];
      expect(new Set(slugs).size).toBe(3);
    });

    it('falls back to a stable placeholder base for a title that slugifies to an empty string', async () => {
      const manager = await createTestUser({ label: 'slug-empty-base' });

      const event = await createDraftEvent(manager, { title: '★★★ ☆☆☆ ???' });

      expect(event.slug).toBe('event');
    });
  });

  // =========================================================================
  // dormant `isPaid` / `priceCents` — ADR-0006: accepted by the schema (it
  // matches the Prisma model 1:1) but NEVER acted on / persisted as anything
  // other than the safe v1 defaults. The Zod-schema-level rejection of
  // non-default values is exercised in `events.router.test.ts` (the actual
  // validation boundary); these service-level tests instead prove the
  // STRUCTURAL guarantee — `EventService.createEvent`'s input type doesn't
  // even accept the fields, so there is no code path through which a
  // non-default value could reach the repository, regardless of what a
  // hypothetical caller upstream of validation might try to pass.
  // =========================================================================
  describe('dormant paid fields (ADR-0006) — structurally always persisted at v1-safe defaults', () => {
    it('always persists isPaid: false and priceCents: null on creation, regardless of capacity/branch/etc.', async () => {
      const manager = await createTestUser({ label: 'dormant-create' });

      const event = await createDraftEvent(manager, { capacity: 50 });

      expect(event.isPaid).toBe(false);
      expect(event.priceCents).toBeNull();

      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded?.isPaid).toBe(false);
      expect(reloaded?.priceCents).toBeNull();
    });

    it('updateEvent never alters isPaid/priceCents — they remain at their safe defaults after any update', async () => {
      const manager = await createTestUser({ label: 'dormant-update' });
      const event = await createDraftEvent(manager);

      const updated = await service.updateEvent(manager, event.id, {
        title: 'Renamed For Dormant-Field Check',
        capacity: 25,
      });

      expect(updated.event.isPaid).toBe(false);
      expect(updated.event.priceCents).toBeNull();
    });
  });

  // =========================================================================
  // DECISION 2 — STATUS TRANSITION GRAPH: the complete (from, to) table
  // =========================================================================
  describe('transitionStatus — the status-transition graph', () => {
    it('allows DRAFT -> PUBLISHED and DRAFT -> CANCELLED (both legal "launch" paths)', async () => {
      const manager = await createTestUser({ label: 'graph-draft-out' });

      const toPublished = await createDraftEvent(manager, { title: uniqueTitle('draft-to-published') });
      const published = await service.transitionStatus(manager, toPublished.id, 'PUBLISHED');
      expect(published.event.status).toBe('PUBLISHED');

      const toCancelled = await createDraftEvent(manager, { title: uniqueTitle('draft-to-cancelled') });
      const cancelled = await service.transitionStatus(manager, toCancelled.id, 'CANCELLED');
      expect(cancelled.event.status).toBe('CANCELLED');
    });

    it('allows PUBLISHED -> DRAFT ("unpublish") and PUBLISHED -> CANCELLED', async () => {
      const manager = await createTestUser({ label: 'graph-published-out' });

      const toDraft = await createDraftEvent(manager, { title: uniqueTitle('published-to-draft') });
      await service.transitionStatus(manager, toDraft.id, 'PUBLISHED');
      const backToDraft = await service.transitionStatus(manager, toDraft.id, 'DRAFT');
      expect(backToDraft.event.status).toBe('DRAFT');

      const toCancelled = await createDraftEvent(manager, { title: uniqueTitle('published-to-cancelled') });
      await service.transitionStatus(manager, toCancelled.id, 'PUBLISHED');
      const cancelled = await service.transitionStatus(manager, toCancelled.id, 'CANCELLED');
      expect(cancelled.event.status).toBe('CANCELLED');
    });

    it('allows CANCELLED -> DRAFT and CANCELLED -> PUBLISHED ("reopen")', async () => {
      const manager = await createTestUser({ label: 'graph-reopen' });

      const toDraft = await createDraftEvent(manager, { title: uniqueTitle('cancelled-to-draft') });
      await service.transitionStatus(manager, toDraft.id, 'CANCELLED');
      const reopenedDraft = await service.transitionStatus(manager, toDraft.id, 'DRAFT');
      expect(reopenedDraft.event.status).toBe('DRAFT');

      const toPublished = await createDraftEvent(manager, { title: uniqueTitle('cancelled-to-published') });
      await service.transitionStatus(manager, toPublished.id, 'CANCELLED');
      const reopenedPublished = await service.transitionStatus(manager, toPublished.id, 'PUBLISHED');
      expect(reopenedPublished.event.status).toBe('PUBLISHED');
    });

    it('rejects every same-state "transition" with 409 CONFLICT — never a silent no-op', async () => {
      const manager = await createTestUser({ label: 'graph-same-state' });

      const draftEvent = await createDraftEvent(manager, { title: uniqueTitle('same-state-draft') });
      await expect(service.transitionStatus(manager, draftEvent.id, 'DRAFT')).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const publishedEvent = await createDraftEvent(manager, { title: uniqueTitle('same-state-published') });
      await service.transitionStatus(manager, publishedEvent.id, 'PUBLISHED');
      await expect(service.transitionStatus(manager, publishedEvent.id, 'PUBLISHED')).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const cancelledEvent = await createDraftEvent(manager, { title: uniqueTitle('same-state-cancelled') });
      await service.transitionStatus(manager, cancelledEvent.id, 'CANCELLED');
      await expect(service.transitionStatus(manager, cancelledEvent.id, 'CANCELLED')).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      // Verify no transition silently mutated anything.
      const reloadedDraft = await db.event.findUnique({ where: { id: draftEvent.id } });
      expect(reloadedDraft?.status).toBe('DRAFT');
    });

    it('exhaustively covers every (from, to) cell in the documented transition table — nothing undocumented sneaks through', async () => {
      // This test asserts on the TABLE ITSELF (every from/to combination,
      // including same-state), not merely on a sample of `transitionStatus`
      // calls — guarding against a future edit to `ALLOWED_TRANSITIONS` that
      // silently drifts from the documented graph in `events.service.ts`'s
      // file header without anyone noticing (exactly the "impossible to
      // accidentally half-update" property that doc-comment names as the
      // reason for encoding the graph as a lookup table in the first place).
      const STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
      const EXPECTED_LEGAL: Record<string, boolean> = {
        'DRAFT->DRAFT': false,
        'DRAFT->PUBLISHED': true,
        'DRAFT->CANCELLED': true,
        'PUBLISHED->DRAFT': true,
        'PUBLISHED->PUBLISHED': false,
        'PUBLISHED->CANCELLED': true,
        'CANCELLED->DRAFT': true,
        'CANCELLED->PUBLISHED': true,
        'CANCELLED->CANCELLED': false,
      };

      const manager = await createTestUser({ label: 'graph-exhaustive' });

      for (const from of STATUSES) {
        for (const to of STATUSES) {
          const key = `${from}->${to}`;
          const shouldBeLegal = EXPECTED_LEGAL[key];
          expect(shouldBeLegal).toBeDefined();

          // Build a fresh event and walk it (DRAFT is the only creatable
          // starting status) to `from` before attempting `from -> to`.
          const event = await createDraftEvent(manager, { title: uniqueTitle(`exhaustive-${key}`) });
          if (from !== 'DRAFT') {
            await service.transitionStatus(manager, event.id, from);
          }

          if (shouldBeLegal) {
            const result = await service.transitionStatus(manager, event.id, to);
            expect(result.event.status).toBe(to);
          } else {
            await expect(service.transitionStatus(manager, event.id, to)).rejects.toMatchObject({
              statusCode: 409,
              code: 'CONFLICT',
            });
          }
        }
      }
    });

    it('always returns the registration-count-augmented shape, accurate to the persisted count', async () => {
      const manager = await createTestUser({ label: 'graph-registration-count' });
      const event = await createDraftEvent(manager, { capacity: 10 });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      // Register one attendee through the real capacity-check primitive —
      // the most realistic way to produce a nonzero count.
      await service.tryRegisterWithCapacityCheck(event.id, {
        firstName: 'Test',
        surname: 'Registrant',
        age: 30,
        email: `registrant-${uniqueSuffix()}@example.invalid`,
        phone: '+27000000000',
        consentVersion: 'v1-PLACEHOLDER',
        retainUntil: null,
      });

      const result = await service.transitionStatus(manager, event.id, 'CANCELLED');
      expect(result.registrationCount).toBe(1);
    });

    it('throws 404 NOT_FOUND for a nonexistent event id, regardless of actor role', async () => {
      const manager = await createTestUser({ label: 'graph-notfound-manager' });
      const admin = await createTestUser({ label: 'graph-notfound-admin', role: 'ADMIN' });
      const missingId = randomUUID();

      await expect(service.transitionStatus(manager, missingId, 'PUBLISHED')).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
      await expect(service.transitionStatus(admin, missingId, 'PUBLISHED')).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // DECISION 3 — EVENT-MANAGER OWNERSHIP: any manager may act on any event
  // =========================================================================
  describe('EVENT_MANAGER ownership — any manager may act on any event (no per-resource boundary)', () => {
    it('lets a DIFFERENT Event Manager update, transition, and view an event they did not create', async () => {
      const creator = await createTestUser({ label: 'ownership-creator' });
      const otherManager = await createTestUser({ label: 'ownership-other-manager' });
      const event = await createDraftEvent(creator, { title: uniqueTitle('ownership-cross-manager') });

      const updated = await service.updateEvent(otherManager, event.id, { title: 'Edited By A Different Manager' });
      expect(updated.event.title).toBe('Edited By A Different Manager');

      const transitioned = await service.transitionStatus(otherManager, event.id, 'PUBLISHED');
      expect(transitioned.event.status).toBe('PUBLISHED');

      const fetched = await service.getForAdmin(otherManager, event.id);
      expect(fetched.id).toBe(event.id);
    });

    it('lets an Admin act on any event the same way an Event Manager can', async () => {
      const creator = await createTestUser({ label: 'ownership-creator-for-admin' });
      const admin = await createTestUser({ label: 'ownership-admin', role: 'ADMIN' });
      const event = await createDraftEvent(creator, { title: uniqueTitle('ownership-admin-cross') });

      const updated = await service.updateEvent(admin, event.id, { title: 'Edited By Admin' });
      expect(updated.event.title).toBe('Edited By Admin');

      const transitioned = await service.transitionStatus(admin, event.id, 'PUBLISHED');
      expect(transitioned.event.status).toBe('PUBLISHED');
    });

    it('listForAdmin is NOT scoped by creator — every manager sees every event', async () => {
      const managerA = await createTestUser({ label: 'ownership-list-manager-a' });
      const managerB = await createTestUser({ label: 'ownership-list-manager-b' });

      const eventA = await createDraftEvent(managerA, { title: uniqueTitle('ownership-list-a') });
      const eventB = await createDraftEvent(managerB, { title: uniqueTitle('ownership-list-b') });

      const resultForA = await service.listForAdmin(managerA, { page: 1, limit: 100 }, {});
      const idsForA = resultForA.items.map((e) => e.id);
      expect(idsForA).toContain(eventA.id);
      expect(idsForA).toContain(eventB.id);

      const resultForB = await service.listForAdmin(managerB, { page: 1, limit: 100 }, {});
      const idsForB = resultForB.items.map((e) => e.id);
      expect(idsForB).toContain(eventA.id);
      expect(idsForB).toContain(eventB.id);
    });
  });

  // =========================================================================
  // setSlug — Admin-only manual slug edit (mirrors Blog exactly)
  // =========================================================================
  describe('setSlug — Admin-only manual slug edit', () => {
    it('allows an Admin to set a fresh, valid, non-colliding slug', async () => {
      const admin = await createTestUser({ label: 'setslug-admin', role: 'ADMIN' });
      const manager = await createTestUser({ label: 'setslug-manager' });
      const event = await createDraftEvent(manager);

      const newSlug = `manually-renamed-${uniqueSuffix()}`;
      const updated = await service.setSlug(admin, event.id, newSlug);

      expect(updated.slug).toBe(newSlug);
      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded?.slug).toBe(newSlug);
    });

    it("rejects setting a slug that collides with another event's slug — 409 CONFLICT", async () => {
      const admin = await createTestUser({ label: 'setslug-collision-admin', role: 'ADMIN' });
      const manager = await createTestUser({ label: 'setslug-collision-manager' });
      const eventA = await createDraftEvent(manager, { title: uniqueTitle('setslug-collision-a') });
      const eventB = await createDraftEvent(manager, { title: uniqueTitle('setslug-collision-b') });

      await expect(service.setSlug(admin, eventB.id, eventA.slug)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const reloaded = await db.event.findUnique({ where: { id: eventB.id } });
      expect(reloaded?.slug).toBe(eventB.slug);
    });

    it('throws 404 NOT_FOUND for a nonexistent event id', async () => {
      const admin = await createTestUser({ label: 'setslug-notfound-admin', role: 'ADMIN' });

      await expect(service.setSlug(admin, randomUUID(), `whatever-${uniqueSuffix()}`)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // updateEvent — cross-field endsAt > startsAt re-validation against the
  // MERGED (existing + incoming) result
  // =========================================================================
  describe('updateEvent — merged-result cross-field validation', () => {
    it('rejects a partial update that would put endsAt at/before the (unchanged) existing startsAt', async () => {
      const manager = await createTestUser({ label: 'update-merged-conflict' });
      const window = futureWindow({ startInMs: 48 * 60 * 60 * 1000, durationMs: 2 * 60 * 60 * 1000 });
      const event = await createDraftEvent(manager, { window });

      // Supplying ONLY `endsAt`, set to before the EXISTING `startsAt` —
      // a schema validating this body in isolation cannot know this is
      // wrong; only the merged-result check (against the loaded existing
      // row) catches it.
      const earlierThanStart = new Date(window.startsAt.getTime() - 60 * 60 * 1000);
      await expect(
        service.updateEvent(manager, event.id, { endsAt: earlierThanStart }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded?.endsAt.getTime()).toBe(window.endsAt.getTime());
    });

    it('accepts a partial update that keeps the merged result valid (only startsAt supplied, still before existing endsAt)', async () => {
      const manager = await createTestUser({ label: 'update-merged-ok' });
      const window = futureWindow({ startInMs: 48 * 60 * 60 * 1000, durationMs: 4 * 60 * 60 * 1000 });
      const event = await createDraftEvent(manager, { window });

      const stillEarlier = new Date(window.startsAt.getTime() + 60 * 60 * 1000); // moved later, still < endsAt
      const updated = await service.updateEvent(manager, event.id, { startsAt: stillEarlier });

      expect(updated.event.startsAt.getTime()).toBe(stillEarlier.getTime());
      expect(updated.event.endsAt.getTime()).toBe(window.endsAt.getTime());
    });

    it('always returns the registration-count-augmented shape, even for non-date field changes', async () => {
      const manager = await createTestUser({ label: 'update-count-shape' });
      const event = await createDraftEvent(manager);

      const updated = await service.updateEvent(manager, event.id, { title: 'Title-Only Change' });
      expect(updated).toHaveProperty('registrationCount');
      expect(updated.registrationCount).toBe(0);
    });
  });

  // =========================================================================
  // deleteEvent — Restrict-FK translation into a registration-count-aware conflict()
  // =========================================================================
  describe('deleteEvent — Restrict-FK translation', () => {
    it('deletes an event with zero registrations (204-equivalent: resolves cleanly)', async () => {
      const manager = await createTestUser({ label: 'delete-clean-manager' });
      const event = await createDraftEvent(manager);

      await service.deleteEvent(manager, event.id);
      createdEventIds = createdEventIds.filter((id) => id !== event.id);

      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded).toBeNull();
    });

    it('translates a Restrict-FK violation (existing registrations) into a registration-count-aware 409 CONFLICT, and does not delete the event', async () => {
      const manager = await createTestUser({ label: 'delete-blocked-manager' });
      const event = await createDraftEvent(manager, { capacity: 5 });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      await service.tryRegisterWithCapacityCheck(event.id, {
        firstName: 'Test',
        surname: 'Blocker',
        age: 25,
        email: `blocker-${uniqueSuffix()}@example.invalid`,
        phone: '+27000000001',
        consentVersion: 'v1-PLACEHOLDER',
        retainUntil: null,
      });

      const error = await service.deleteEvent(manager, event.id).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AppError);
      expect((error as { statusCode: number }).statusCode).toBe(409);
      expect((error as { code: string }).code).toBe('CONFLICT');
      expect((error as { message: string }).message).toContain('1');

      const reloaded = await db.event.findUnique({ where: { id: event.id } });
      expect(reloaded).not.toBeNull();
    });

    it('throws 404 NOT_FOUND for a nonexistent event id', async () => {
      const manager = await createTestUser({ label: 'delete-notfound-manager' });

      await expect(service.deleteEvent(manager, randomUUID())).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  // =========================================================================
  // Public visibility contract — `status = PUBLISHED` is the COMPLETE
  // predicate (no `publishedAt`-equivalent scheduling gap, unlike Blog)
  // =========================================================================
  describe('public visibility contract — getPublishedBySlug / getPublished', () => {
    it('getPublishedBySlug 404s identically for a genuinely nonexistent slug AND for a DRAFT event (anti-enumeration, collapsed outcome)', async () => {
      const manager = await createTestUser({ label: 'visibility-collapsed' });
      const draft = await createDraftEvent(manager, { title: uniqueTitle('visibility-draft') });

      const draftError = await service.getPublishedBySlug(draft.slug).catch((err: unknown) => err);
      const missingError = await service
        .getPublishedBySlug(`no-such-slug-${uniqueSuffix()}`)
        .catch((err: unknown) => err);

      expect(draftError).toBeInstanceOf(AppError);
      expect(missingError).toBeInstanceOf(AppError);
      expect((draftError as { statusCode: number }).statusCode).toBe(404);
      expect((missingError as { statusCode: number }).statusCode).toBe(404);
      expect((draftError as { code: string }).code).toBe('NOT_FOUND');
      expect((missingError as { code: string }).code).toBe('NOT_FOUND');
      // Identical message — no "exists but private" vs "doesn't exist" leak.
      expect((draftError as { message: string }).message).toBe((missingError as { message: string }).message);
    });

    it('getPublishedBySlug 404s for a CANCELLED event — only PUBLISHED is publicly visible', async () => {
      const manager = await createTestUser({ label: 'visibility-cancelled' });
      const event = await createDraftEvent(manager, { title: uniqueTitle('visibility-cancelled') });
      await service.transitionStatus(manager, event.id, 'CANCELLED');

      await expect(service.getPublishedBySlug(event.slug)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('getPublishedBySlug succeeds for a genuinely PUBLISHED event — status = PUBLISHED is sufficient on its own (no scheduling gap)', async () => {
      const manager = await createTestUser({ label: 'visibility-published' });
      // A PUBLISHED event whose `startsAt` is in the FUTURE must still be
      // immediately publicly visible — unlike Blog, there is no
      // `publishedAt`-style "scheduled but not yet live" limbo for `Event`
      // (see `events.service.ts`'s file-header "no scheduling gap"
      // confirmation). `status = PUBLISHED` is the COMPLETE predicate.
      const event = await createDraftEvent(manager, { title: uniqueTitle('visibility-published-future-start') });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      const found = await service.getPublishedBySlug(event.slug);
      expect(found.id).toBe(event.id);
      expect(found.status).toBe('PUBLISHED');
    });

    it('getPublished excludes drafts and cancelled events, includes published ones, regardless of how far in the future they start', async () => {
      const manager = await createTestUser({ label: 'visibility-list' });

      const draft = await createDraftEvent(manager, { title: uniqueTitle('visibility-list-draft') });

      const published = await createDraftEvent(manager, { title: uniqueTitle('visibility-list-published') });
      await service.transitionStatus(manager, published.id, 'PUBLISHED');

      const cancelled = await createDraftEvent(manager, { title: uniqueTitle('visibility-list-cancelled') });
      await service.transitionStatus(manager, cancelled.id, 'CANCELLED');

      const result = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'all' });
      const ids = result.items.map((e) => e.id);

      expect(ids).toContain(published.id);
      expect(ids).not.toContain(draft.id);
      expect(ids).not.toContain(cancelled.id);
    });
  });

  // =========================================================================
  // getPublished — branch filtering
  // =========================================================================
  describe('getPublished — branch filtering', () => {
    it('scopes results to a single branch when filters.branch is provided, and returns all branches when omitted', async () => {
      const manager = await createTestUser({ label: 'branch-filter' });

      const capeTown = await service.createEvent(manager, {
        title: uniqueTitle('branch-cape-town'),
        description: 'A perfectly ordinary test event description, long enough to be valid.',
        ...futureWindow(),
        branch: 'CAPE_TOWN',
        locationDetail: 'Cape Town Venue',
      });
      createdEventIds.push(capeTown.id);
      await service.transitionStatus(manager, capeTown.id, 'PUBLISHED');

      const durban = await service.createEvent(manager, {
        title: uniqueTitle('branch-durban'),
        description: 'A perfectly ordinary test event description, long enough to be valid.',
        ...futureWindow(),
        branch: 'DURBAN',
        locationDetail: 'Durban Venue',
      });
      createdEventIds.push(durban.id);
      await service.transitionStatus(manager, durban.id, 'PUBLISHED');

      const capeTownOnly = await service.getPublished(
        { page: 1, limit: 100 },
        { branch: 'CAPE_TOWN', temporal: 'all' },
      );
      const capeTownIds = capeTownOnly.items.map((e) => e.id);
      expect(capeTownIds).toContain(capeTown.id);
      expect(capeTownIds).not.toContain(durban.id);

      const everyBranch = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'all' });
      const everyBranchIds = everyBranch.items.map((e) => e.id);
      expect(everyBranchIds).toContain(capeTown.id);
      expect(everyBranchIds).toContain(durban.id);
    });
  });

  // =========================================================================
  // getPublished — upcoming/past semantics (endsAt-based, not startsAt-based)
  // =========================================================================
  describe('getPublished — upcoming/past semantics (endsAt-based, per the repository doc-comment)', () => {
    it('classifies a not-yet-concluded event (endsAt in the future) as "upcoming", even if it has already started', async () => {
      const manager = await createTestUser({ label: 'temporal-in-progress' });

      // Started 30 minutes ago, ends in 30 minutes — "in progress" right now.
      // The `endsAt`-based cutoff (NOT `startsAt`-based) must classify this
      // as "upcoming", not "past" — exactly the distinction
      // `events.repository.ts`'s `temporalWhere` doc-comment names as the
      // reason `endsAt` was chosen as the cutoff field.
      const inProgress = await service.createEvent(manager, {
        title: uniqueTitle('temporal-in-progress'),
        description: 'A perfectly ordinary test event description, long enough to be valid.',
        startsAt: new Date(Date.now() - 30 * 60 * 1000),
        endsAt: new Date(Date.now() + 30 * 60 * 1000),
        branch: 'CAPE_TOWN',
        locationDetail: 'Test Venue',
      });
      createdEventIds.push(inProgress.id);
      await service.transitionStatus(manager, inProgress.id, 'PUBLISHED');

      const upcoming = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'upcoming' });
      const past = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'past' });

      expect(upcoming.items.map((e) => e.id)).toContain(inProgress.id);
      expect(past.items.map((e) => e.id)).not.toContain(inProgress.id);
    });

    it('classifies a genuinely-concluded event (endsAt in the past) as "past", not "upcoming"', async () => {
      const manager = await createTestUser({ label: 'temporal-concluded' });

      const concluded = await service.createEvent(manager, {
        title: uniqueTitle('temporal-concluded'),
        description: 'A perfectly ordinary test event description, long enough to be valid.',
        startsAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        branch: 'CAPE_TOWN',
        locationDetail: 'Test Venue',
      });
      createdEventIds.push(concluded.id);
      await service.transitionStatus(manager, concluded.id, 'PUBLISHED');

      const upcoming = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'upcoming' });
      const past = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'past' });

      expect(past.items.map((e) => e.id)).toContain(concluded.id);
      expect(upcoming.items.map((e) => e.id)).not.toContain(concluded.id);
    });

    it('"all" includes both upcoming and past published events', async () => {
      const manager = await createTestUser({ label: 'temporal-all' });

      const future = await createDraftEvent(manager, { title: uniqueTitle('temporal-all-future') });
      await service.transitionStatus(manager, future.id, 'PUBLISHED');

      const past = await service.createEvent(manager, {
        title: uniqueTitle('temporal-all-past'),
        description: 'A perfectly ordinary test event description, long enough to be valid.',
        startsAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        branch: 'CAPE_TOWN',
        locationDetail: 'Test Venue',
      });
      createdEventIds.push(past.id);
      await service.transitionStatus(manager, past.id, 'PUBLISHED');

      const all = await service.getPublished({ page: 1, limit: 100 }, { temporal: 'all' });
      const ids = all.items.map((e) => e.id);

      expect(ids).toContain(future.id);
      expect(ids).toContain(past.id);
    });
  });

  // =========================================================================
  // tryRegisterWithCapacityCheck — the service-layer half of the capacity
  // invariant (the GENUINE concurrency proof lives in
  // events.repository.test.ts; see this describe block's intro note)
  // =========================================================================
  describe('tryRegisterWithCapacityCheck — capacity-check translation and existence guard', () => {
    it('succeeds and returns a real registrationId when there is room', async () => {
      const manager = await createTestUser({ label: 'capacity-room' });
      const event = await createDraftEvent(manager, { capacity: 3 });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      const result = await service.tryRegisterWithCapacityCheck(event.id, {
        firstName: 'Has',
        surname: 'Room',
        age: 28,
        email: `has-room-${uniqueSuffix()}@example.invalid`,
        phone: '+27000000002',
        consentVersion: 'v1-PLACEHOLDER',
        retainUntil: null,
      });

      expect(result.registrationId).toBeTruthy();
      const row = await db.registration.findUnique({ where: { id: result.registrationId } });
      expect(row?.eventId).toBe(event.id);
    });

    it('throws capacityExceeded() (409) once the fast pre-check observes the event is full — without attempting an insert', async () => {
      const manager = await createTestUser({ label: 'capacity-prefull' });
      const event = await createDraftEvent(manager, { capacity: 1 });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      await service.tryRegisterWithCapacityCheck(event.id, {
        firstName: 'First',
        surname: 'In',
        age: 30,
        email: `first-in-${uniqueSuffix()}@example.invalid`,
        phone: '+27000000003',
        consentVersion: 'v1-PLACEHOLDER',
        retainUntil: null,
      });

      const error = await service
        .tryRegisterWithCapacityCheck(event.id, {
          firstName: 'Second',
          surname: 'Out',
          age: 31,
          email: `second-out-${uniqueSuffix()}@example.invalid`,
          phone: '+27000000004',
          consentVersion: 'v1-PLACEHOLDER',
          retainUntil: null,
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(AppError);
      expect((error as { statusCode: number }).statusCode).toBe(409);
      expect((error as { code: string }).code).toBe('CAPACITY_EXCEEDED');

      const finalCount = await db.registration.count({ where: { eventId: event.id } });
      expect(finalCount).toBe(1);
    });

    it('places no limit at all on an uncapped event (capacity: null) — never throws capacityExceeded()', async () => {
      const manager = await createTestUser({ label: 'capacity-uncapped' });
      const event = await createDraftEvent(manager, { capacity: null });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      for (let i = 0; i < 3; i += 1) {
        const result = await service.tryRegisterWithCapacityCheck(event.id, {
          firstName: 'Uncapped',
          surname: `Attendee-${i}`,
          age: 30,
          email: `uncapped-${i}-${uniqueSuffix()}@example.invalid`,
          phone: '+27000000005',
          consentVersion: 'v1-PLACEHOLDER',
          retainUntil: null,
        });
        expect(result.registrationId).toBeTruthy();
      }

      const finalCount = await db.registration.count({ where: { eventId: event.id } });
      expect(finalCount).toBe(3);
    });

    it('throws 404 NOT_FOUND for a nonexistent event id — never a capacity-shaped error', async () => {
      await expect(
        service.tryRegisterWithCapacityCheck(randomUUID(), {
          firstName: 'No',
          surname: 'Event',
          age: 30,
          email: `no-event-${uniqueSuffix()}@example.invalid`,
          phone: '+27000000006',
          consentVersion: 'v1-PLACEHOLDER',
          retainUntil: null,
        }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    });
  });

  // =========================================================================
  // countRegistrations — existence-checked pass-through
  // =========================================================================
  describe('countRegistrations', () => {
    it('returns the accurate persisted count for an existing event', async () => {
      const manager = await createTestUser({ label: 'count-accurate' });
      const event = await createDraftEvent(manager, { capacity: 10 });
      await service.transitionStatus(manager, event.id, 'PUBLISHED');

      expect(await service.countRegistrations(event.id)).toBe(0);

      await service.tryRegisterWithCapacityCheck(event.id, {
        firstName: 'Count',
        surname: 'Me',
        age: 33,
        email: `count-me-${uniqueSuffix()}@example.invalid`,
        phone: '+27000000007',
        consentVersion: 'v1-PLACEHOLDER',
        retainUntil: null,
      });

      expect(await service.countRegistrations(event.id)).toBe(1);
    });

    it('throws 404 NOT_FOUND for a nonexistent event id (never a confusing "0")', async () => {
      await expect(service.countRegistrations(randomUUID())).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });

  describe('AppError shape sanity', () => {
    it('throws real AppError instances (not generic Errors) for the documented failure modes', async () => {
      const manager = await createTestUser({ label: 'apperror-shape' });

      try {
        await service.getPublishedBySlug(`definitely-not-a-slug-${uniqueSuffix()}`);
        expect.unreachable('expected getPublishedBySlug to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
      }

      try {
        await service.transitionStatus(manager, randomUUID(), 'PUBLISHED');
        expect.unreachable('expected transitionStatus to throw for a missing event');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
      }
    });
  });
});
