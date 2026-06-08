/**
 * Integration tests for `EventRepository` (plan.md Phase 4b step 1), with a
 * dedicated focus on `tryRegisterAtomically` — THE race-safe
 * capacity-check-and-insert primitive (architecture.md §7.3 invariant #6 /
 * plan.md Phase 4b step 2).
 *
 * Exercised against the REAL local Postgres via the REAL `EventRepository`
 * — mirroring `blog.repository.ts`'s/`blog.service.test.ts`'s established
 * "no DB-mocking infrastructure exists; standing one up purely for these
 * assertions would be more machinery than it's worth" posture. This is
 * doubly true here: the entire POINT of these tests is to prove something
 * about REAL Postgres's concurrency behaviour — a mock could only ever tell
 * us what we already assumed, which is exactly the failure mode plan.md
 * Phase 11 item 2 calls "the test most likely to be written wrong in a way
 * that still goes green."
 *
 * ===========================================================================
 * THE GENUINE CONCURRENCY TEST — `Promise.all`, not a sequential loop
 * ===========================================================================
 * The describe block "tryRegisterAtomically — race-safety under genuine
 * concurrent load" below fires N=10 concurrent `tryRegisterAtomically`
 * attempts at a `capacity: 1` event via `Promise.all([...])` — all ten
 * promises are CREATED (and their underlying `$queryRaw` calls DISPATCHED
 * to Postgres) before any of them resolves. This is the critical property a
 * sequential `for`/`await` loop CANNOT exercise: a sequential loop's Nth
 * attempt only ever begins after the (N-1)th has FULLY COMMITTED — there is
 * never a moment where two attempts are "in flight" at once, so a
 * fundamentally broken, TOCTOU-racy "count, then insert" implementation
 * would pass a sequential test with flying colours (each count would
 * correctly observe all prior commits) while still overselling under real
 * concurrent load. `Promise.all` is the only shape that actually creates the
 * race condition this primitive exists to survive.
 */
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { db } from '../../lib/db';
import { createEventRepository, type EventRepository } from './events.repository';

const repository: EventRepository = createEventRepository({ db });

function uniqueSuffix(): string {
  return randomUUID();
}

let createdUserIds: string[] = [];
let createdEventIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
    // `Registration` rows cascade-clean via direct `deleteMany` first — the
    // schema's `onDelete: Restrict` would otherwise block `Event` cleanup
    // exactly as it would in production (a deliberate POPIA-data-protection
    // choice — see `prisma/schema.prisma`'s comment on that relation — which
    // these tests must respect, not route around).
    await db.registration.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
    createdEventIds = [];
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

/** Bare-minimum throwaway `User` row to satisfy `Event.createdById`'s FK —
 * mirrors `blog.service.test.ts`'s `createTestUser` "argon2id cost is
 * irrelevant to these tests" posture (a fixed placeholder hash). */
async function createTestUser(label: string): Promise<string> {
  const created = await db.user.create({
    data: {
      name: `Events Repo Test User (${label})`,
      email: `events-repo-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role: 'EVENT_MANAGER',
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return created.id;
}

/** Creates a throwaway `Event` row directly via Prisma (bypassing the
 * service — setup convenience, mirrors `blog.router.test.ts`'s
 * `createPostFixture`), with a future `startsAt`/`endsAt` window and the
 * given `capacity`. */
async function createEventFixture(opts: { createdById: string; capacity: number | null }) {
  const suffix = uniqueSuffix();
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +1 day
  const endsAt = new Date(Date.now() + 25 * 60 * 60 * 1000); // +25 hours

  const event = await db.event.create({
    data: {
      title: `Repo Test Event ${suffix}`,
      slug: `repo-test-event-${suffix}`,
      description: 'A perfectly ordinary test event description, long enough to be valid.',
      startsAt,
      endsAt,
      branch: 'CAPE_TOWN',
      locationDetail: 'Test Venue, Test Street',
      capacity: opts.capacity,
      status: 'PUBLISHED',
      createdById: opts.createdById,
      isPaid: false,
      priceCents: null,
    },
  });
  createdEventIds.push(event.id);
  return event;
}

/** Builds a unique, valid registration payload — `email` is uniqued per call
 * so the (deliberately-soft, application-layer-only) duplicate-email
 * question never confounds these capacity-focused assertions. */
function registrationPayload(label: string) {
  return {
    firstName: 'Test',
    surname: `Registrant-${label}`,
    age: 30,
    email: `registrant-${label}-${uniqueSuffix()}@example.invalid`,
    phone: '+27000000000',
    consentVersion: 'v1-PLACEHOLDER',
    retainUntil: null as Date | null,
  };
}

describe('EventRepository.tryRegisterAtomically — the race-safe capacity primitive', () => {
  describe('single-attempt behaviour (sanity baseline before the concurrency test)', () => {
    it('inserts and returns { inserted: true, id } when the event is uncapped (capacity: null)', async () => {
      const userId = await createTestUser('uncapped');
      const event = await createEventFixture({ createdById: userId, capacity: null });

      const result = await repository.tryRegisterAtomically(event.id, registrationPayload('uncapped-1'));

      expect(result.inserted).toBe(true);
      expect(result.id).toBeTruthy();

      const row = await db.registration.findUnique({ where: { id: result.id! } });
      expect(row).not.toBeNull();
      expect(row?.eventId).toBe(event.id);
    });

    it('inserts when current count is below capacity, and reports { inserted: false } once at capacity', async () => {
      const userId = await createTestUser('below-then-at');
      const event = await createEventFixture({ createdById: userId, capacity: 2 });

      const first = await repository.tryRegisterAtomically(event.id, registrationPayload('below-1'));
      expect(first.inserted).toBe(true);

      const second = await repository.tryRegisterAtomically(event.id, registrationPayload('below-2'));
      expect(second.inserted).toBe(true);

      // Capacity is now exhausted (2/2) — the THIRD attempt must be rejected
      // by the atomic statement's WHERE clause, not merely "discouraged."
      const third = await repository.tryRegisterAtomically(event.id, registrationPayload('at-capacity'));
      expect(third.inserted).toBe(false);
      expect(third.id).toBeUndefined();

      const finalCount = await db.registration.count({ where: { eventId: event.id } });
      expect(finalCount).toBe(2);
    });

    it('rejects immediately when the event is already at capacity 0... (capacity: 1, pre-filled)', async () => {
      const userId = await createTestUser('prefilled');
      const event = await createEventFixture({ createdById: userId, capacity: 1 });

      const first = await repository.tryRegisterAtomically(event.id, registrationPayload('prefilled-1'));
      expect(first.inserted).toBe(true);

      const second = await repository.tryRegisterAtomically(event.id, registrationPayload('prefilled-2'));
      expect(second.inserted).toBe(false);

      const finalCount = await db.registration.count({ where: { eventId: event.id } });
      expect(finalCount).toBe(1);
    });
  });

  /**
   * =========================================================================
   * THE GENUINE CONCURRENCY TEST
   * =========================================================================
   * See this file's header for the full "why `Promise.all`, not a sequential
   * loop" reasoning — reproduced in miniature at the assertion site below.
   *
   * Setup: a freshly-created event with `capacity: 1` and ZERO existing
   * registrations. Then: fire `CONCURRENT_ATTEMPTS` (10) simultaneous
   * `tryRegisterAtomically` calls via `Promise.all` — every one of them
   * racing to claim the SAME single slot.
   *
   * THE INVARIANT UNDER TEST: regardless of how Postgres interleaves these
   * ten concurrent `INSERT ... SELECT ... WHERE count < capacity` statements
   * (and it WILL interleave them — that's the entire point of firing them
   * concurrently), AT MOST ONE may succeed, and the final persisted
   * `Registration` count for this event must be EXACTLY 1 — never 0 (every
   * attempt wrongly rejected would be its own bug, just a less dangerous
   * one) and never >1 (the overselling bug this entire primitive exists to
   * prevent — the one a TOCTOU-racy "count, then insert" would produce here
   * with high probability).
   */
  describe('tryRegisterAtomically — race-safety under genuine concurrent load', () => {
    const CONCURRENT_ATTEMPTS = 10;

    it(
      `allows exactly ONE of ${CONCURRENT_ATTEMPTS} concurrent attempts to succeed against a capacity-1 event (Promise.all, not a sequential loop)`,
      async () => {
        const userId = await createTestUser('concurrency');
        const event = await createEventFixture({ createdById: userId, capacity: 1 });

        // Build all ten attempts as plain promise-returning thunks FIRST,
        // then launch every single one in the SAME `Promise.all` — this is
        // the line that actually creates the race: all ten `$queryRaw`
        // calls are dispatched to the database back-to-back, before any of
        // them has resolved. A `for...of` + `await` here would serialize
        // them and prove nothing about concurrent behaviour (see file
        // header).
        const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          repository.tryRegisterAtomically(event.id, registrationPayload(`concurrent-${index}`)),
        );

        const results = await Promise.all(attempts);

        const successes = results.filter((result) => result.inserted === true);
        const failures = results.filter((result) => result.inserted === false);

        // Exactly one success — not "at least one," not "at most one":
        // EXACTLY one. (Zero successes would mean the primitive is too
        // conservative — a working event with available capacity that
        // nobody could ever register for; more than one is the overselling
        // bug.)
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(CONCURRENT_ATTEMPTS - 1);

        // Every reported success must carry a real, distinct `id` that
        // genuinely exists in the database — guards against a primitive
        // that "reports success" without actually persisting (or persists
        // without reporting).
        expect(successes[0]?.id).toBeTruthy();

        // THE GROUND TRUTH: ask the database directly — not the primitive's
        // self-reported results — how many `Registration` rows actually
        // exist for this event. This is the assertion that would catch a
        // primitive that LIES (e.g. one that returns `{ inserted: false }`
        // for nine attempts but, due to a race in its own bookkeeping,
        // still left two rows behind).
        const finalCount = await db.registration.count({ where: { eventId: event.id } });
        expect(finalCount).toBe(1);

        // The one persisted row's id matches the one success's reported id —
        // ties the self-reported outcome to the ground truth precisely.
        const persisted = await db.registration.findMany({ where: { eventId: event.id }, select: { id: true } });
        expect(persisted).toHaveLength(1);
        expect(persisted[0]?.id).toBe(successes[0]?.id);
      },
      // Ten concurrent real-Postgres round trips comfortably exceed
      // vitest's default 5s timeout on a freshly-warmed connection pool —
      // generous headroom mirrors `blog.router.test.ts`'s timeout posture
      // for its own multi-round-trip flows.
      20_000,
    );

    it(
      `allows exactly TWO of ${CONCURRENT_ATTEMPTS} concurrent attempts to succeed against a capacity-2 event`,
      async () => {
        // A second shape of the same test — capacity 2 — to guard against an
        // off-by-one implementation that happens to behave correctly only
        // for the capacity-1 boundary (e.g. a `<=` vs `<` slip in the
        // `WHERE` clause's comparison).
        const userId = await createTestUser('concurrency-cap2');
        const event = await createEventFixture({ createdById: userId, capacity: 2 });

        const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          repository.tryRegisterAtomically(event.id, registrationPayload(`concurrent-cap2-${index}`)),
        );

        const results = await Promise.all(attempts);
        const successes = results.filter((result) => result.inserted === true);

        expect(successes).toHaveLength(2);

        const finalCount = await db.registration.count({ where: { eventId: event.id } });
        expect(finalCount).toBe(2);
      },
      20_000,
    );
  });
});
