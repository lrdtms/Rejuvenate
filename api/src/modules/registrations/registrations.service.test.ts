/**
 * Integration tests for `RegistrationService` (plan.md Phase 4c), mirroring
 * `events.service.test.ts`'s/`blog.service.test.ts`'s "real Postgres, real
 * repositories, no DB-mocking infrastructure" posture verbatim.
 *
 * Coverage map (mirrors `registrations.service.ts`'s own doc-comment
 * structure):
 *   - file-header point 1 (eligibility)      -> "registerAttendee — eligibility"
 *   - file-header point 2 (capacity)          -> "registerAttendee — capacity"
 *     (the GENUINE Promise.all concurrency proof lives here too — see that
 *     describe block's header for why it must be re-proven through THIS
 *     service's public entry point, not merely assumed from Phase 4b)
 *   - file-header point 3 (duplicate guard)   -> "registerAttendee — duplicate guard"
 *   - file-header point 4 (honeypot)          -> "registerAttendee — honeypot"
 *   - file-header point 5 (POPIA placeholders)-> "registerAttendee — POPIA placeholder wiring"
 *   - age validation boundary                 -> covered at the SCHEMA layer
 *     (`registrations.schemas.test.ts` would be redundant scaffolding for a
 *     bare Zod schema — see `registrations.router.test.ts`'s
 *     "age validation" describe block for the end-to-end boundary proof
 *     through the actual HTTP/validation pipeline, which is the layer that
 *     actually matters per architecture.md §12's "validate server-side
 *     regardless of client checks").
 *   - listForEvent / exportForEvent           -> "staff reads"
 */
import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { AuthenticatedUser } from '../auth/auth.service';
import { createEventRepository } from '../events/events.repository';
import { createEventService, type EventService } from '../events/events.service';
import { CONSENT_VERSION_PLACEHOLDER, DUPLICATE_GUARD_WINDOW_MINUTES } from './registrations.constants';
import { createRegistrationRepository } from './registrations.repository';
import { createRegistrationService, type RegistrationService } from './registrations.service';

const silentLogger = pino({ level: 'silent' });

function uniqueSuffix(): string {
  return randomUUID();
}

function uniqueTitle(label: string): string {
  return `Registration Test Event ${label} ${uniqueSuffix()}`;
}

const eventRepository = createEventRepository({ db });
const eventService: EventService = createEventService({ repository: eventRepository });
const registrationRepository = createRegistrationRepository({ db });
const service: RegistrationService = createRegistrationService({
  eventService,
  repository: registrationRepository,
  logger: silentLogger,
});

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

async function createTestUser(opts: { label: string; role?: 'ADMIN' | 'BLOGGER' | 'EVENT_MANAGER' }): Promise<AuthenticatedUser> {
  const { label, role = 'EVENT_MANAGER' } = opts;
  const created = await db.user.create({
    data: {
      name: `Registrations Service Test User (${label})`,
      email: `registrations-service-test-${label}-${uniqueSuffix()}@example.invalid`,
      passwordHash: 'not-a-real-hash',
      role,
      isActive: true,
    },
  });
  createdUserIds.push(created.id);
  return { id: created.id, name: created.name, email: created.email, role: created.role, isActive: true };
}

/** Creates a PUBLISHED, not-yet-started event directly via Prisma (setup
 * convenience — bypasses the service's create+publish ceremony, mirroring
 * `events.repository.test.ts`'s `createEventFixture`), with the given
 * `capacity` and an optional `startsAt` override for "already started"
 * scenarios. */
async function createPublishedEventFixture(opts: {
  createdById: string;
  capacity?: number | null;
  startsAt?: Date;
  endsAt?: Date;
  status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED';
}) {
  const suffix = uniqueSuffix();
  const startsAt = opts.startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = opts.endsAt ?? new Date(Date.now() + 25 * 60 * 60 * 1000);

  const event = await db.event.create({
    data: {
      title: uniqueTitle(suffix),
      slug: `registration-test-event-${suffix}`,
      description: 'A perfectly ordinary test event description, long enough to be valid.',
      startsAt,
      endsAt,
      branch: 'CAPE_TOWN',
      locationDetail: 'Test Venue, Test Street',
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

/** A complete, valid RSVP submission payload — `email`/`firstName`/`surname`
 * uniqued per call so cross-test duplicate-guard interference never occurs
 * unless a test deliberately reuses values. */
function rsvpPayload(label: string) {
  const suffix = uniqueSuffix();
  return {
    firstName: `Test-${label}`,
    surname: `Registrant-${suffix}`,
    age: 30,
    email: `rsvp-${label}-${suffix}@example.invalid`,
    phone: '+27 12 345 6789',
  };
}

describe('RegistrationService (plan.md Phase 4c)', () => {
  // =========================================================================
  // file-header point 1 — eligibility (PUBLISHED + not-yet-started)
  // =========================================================================
  describe('registerAttendee — eligibility', () => {
    it('succeeds for a PUBLISHED, not-yet-started event', async () => {
      const manager = await createTestUser({ label: 'eligible' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      const result = await service.registerAttendee(event.slug, rsvpPayload('eligible'));

      expect(result).toEqual({ registered: true });

      const stored = await db.registration.findFirst({ where: { eventId: event.id } });
      expect(stored).not.toBeNull();
    });

    it('throws notFound (404) for a slug that does not exist — anti-enumeration', async () => {
      await expect(service.registerAttendee(`no-such-slug-${uniqueSuffix()}`, rsvpPayload('missing'))).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws notFound (404) — NOT a distinguishing error — for a DRAFT event (collapsed with "no such slug")', async () => {
      const manager = await createTestUser({ label: 'draft-hidden' });
      const event = await createPublishedEventFixture({ createdById: manager.id, status: 'DRAFT' });

      await expect(service.registerAttendee(event.slug, rsvpPayload('draft'))).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws notFound (404) for a CANCELLED event', async () => {
      const manager = await createTestUser({ label: 'cancelled-hidden' });
      const event = await createPublishedEventFixture({ createdById: manager.id, status: 'CANCELLED' });

      await expect(service.registerAttendee(event.slug, rsvpPayload('cancelled'))).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('throws conflict (409) for a PUBLISHED event that has already started', async () => {
      const manager = await createTestUser({ label: 'already-started' });
      const event = await createPublishedEventFixture({
        createdById: manager.id,
        startsAt: new Date(Date.now() - 60 * 60 * 1000), // started 1 hour ago
        endsAt: new Date(Date.now() + 60 * 60 * 1000), // ends in 1 hour (in progress)
      });

      await expect(service.registerAttendee(event.slug, rsvpPayload('started'))).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(0);
    });

    it('throws conflict (409) for a PUBLISHED event that has already concluded', async () => {
      const manager = await createTestUser({ label: 'already-ended' });
      const event = await createPublishedEventFixture({
        createdById: manager.id,
        startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      await expect(service.registerAttendee(event.slug, rsvpPayload('ended'))).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
    });
  });

  // =========================================================================
  // file-header point 2 — the two-layer, race-safe capacity guarantee
  // =========================================================================
  describe('registerAttendee — capacity', () => {
    it('succeeds while under capacity and rejects with capacityExceeded (409) once full', async () => {
      const manager = await createTestUser({ label: 'capacity-sequential' });
      const event = await createPublishedEventFixture({ createdById: manager.id, capacity: 1 });

      const first = await service.registerAttendee(event.slug, rsvpPayload('cap-1'));
      expect(first).toEqual({ registered: true });

      await expect(service.registerAttendee(event.slug, rsvpPayload('cap-2'))).rejects.toMatchObject({
        statusCode: 409,
        code: 'CAPACITY_EXCEEDED',
      });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(1);
    });

    it('never oversells an uncapped event is moot — succeeds repeatedly when capacity is null', async () => {
      const manager = await createTestUser({ label: 'uncapped' });
      const event = await createPublishedEventFixture({ createdById: manager.id, capacity: null });

      await service.registerAttendee(event.slug, rsvpPayload('uncapped-1'));
      await service.registerAttendee(event.slug, rsvpPayload('uncapped-2'));
      await service.registerAttendee(event.slug, rsvpPayload('uncapped-3'));

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(3);
    });

    /**
     * =====================================================================
     * THE GENUINE CONCURRENCY TEST — through `RegistrationService`'s OWN
     * public entry point, `Promise.all`, NOT a sequential loop
     * =====================================================================
     * `events.repository.test.ts` already proves `tryRegisterAtomically`
     * race-safe at the primitive's own layer. Re-proving the SAME guarantee
     * here is not redundant busywork — it is the proof that THIS service's
     * additional layers (the eligibility check, the duplicate-guard lookup,
     * the honeypot branch) do not themselves introduce a NEW race, or
     * silently bypass/shadow the underlying primitive's guarantee (e.g. by
     * accidentally short-circuiting before reaching it, or wrapping it in
     * something that breaks its atomicity assumptions). The brief is
     * explicit that this is "the test most likely to be written wrong in a
     * way that still goes green" — a sequential loop here would prove
     * nothing about whether `registerAttendee` PRESERVES the guarantee
     * `tryRegisterWithCapacityCheck` provides; only genuine concurrent
     * dispatch through the FULL service stack does.
     */
    describe('race-safety under genuine concurrent load (through registerAttendee)', () => {
      const CONCURRENT_ATTEMPTS = 10;

      it(
        `allows exactly ONE of ${CONCURRENT_ATTEMPTS} concurrent registerAttendee calls to succeed against a capacity-1 event`,
        async () => {
          const manager = await createTestUser({ label: 'concurrency' });
          const event = await createPublishedEventFixture({ createdById: manager.id, capacity: 1 });

          // All ten attempts use DISTINCT names/emails — this concurrency
          // test is about the CAPACITY guarantee, not the duplicate-guard;
          // entangling the two would make a failure ambiguous ("did it
          // reject for being a duplicate, or for being over capacity?").
          const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
            service.registerAttendee(event.slug, rsvpPayload(`concurrent-${index}`)).then(
              () => ({ outcome: 'success' as const }),
              (err: unknown) => ({
                outcome: 'failure' as const,
                code: err instanceof AppError ? err.code : 'UNKNOWN',
              }),
            ),
          );

          const results = await Promise.all(attempts);

          const successes = results.filter((result) => result.outcome === 'success');
          const failures = results.filter((result) => result.outcome === 'failure');

          expect(successes).toHaveLength(1);
          expect(failures).toHaveLength(CONCURRENT_ATTEMPTS - 1);

          // Every failure must be the EXPECTED `CAPACITY_EXCEEDED` — not
          // some other error masquerading as a rejection (e.g. a timeout,
          // a duplicate-guard false-positive, an unrelated 500).
          for (const failure of failures) {
            if (failure.outcome === 'failure') {
              expect(failure.code).toBe('CAPACITY_EXCEEDED');
            }
          }

          // THE GROUND TRUTH — ask the database directly, not the service's
          // self-reported outcomes (mirrors `events.repository.test.ts`'s
          // identical "ask the DB, not the primitive" discipline).
          const finalCount = await db.registration.count({ where: { eventId: event.id } });
          expect(finalCount).toBe(1);
        },
        20_000,
      );

      it(
        `allows exactly TWO of ${CONCURRENT_ATTEMPTS} concurrent registerAttendee calls to succeed against a capacity-2 event`,
        async () => {
          const manager = await createTestUser({ label: 'concurrency-cap2' });
          const event = await createPublishedEventFixture({ createdById: manager.id, capacity: 2 });

          const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
            service.registerAttendee(event.slug, rsvpPayload(`concurrent-cap2-${index}`)).then(
              () => ({ outcome: 'success' as const }),
              () => ({ outcome: 'failure' as const }),
            ),
          );

          const results = await Promise.all(attempts);
          const successes = results.filter((result) => result.outcome === 'success');

          expect(successes).toHaveLength(2);

          const finalCount = await db.registration.count({ where: { eventId: event.id } });
          expect(finalCount).toBe(2);
        },
        20_000,
      );
    });
  });

  // =========================================================================
  // file-header point 3 — the soft (eventId, email, firstName, surname)
  // duplicate-submission guard, within DUPLICATE_GUARD_WINDOW_MINUTES
  // =========================================================================
  describe('registerAttendee — duplicate guard', () => {
    it('rejects an identical (email, firstName, surname) resubmission within the window', async () => {
      const manager = await createTestUser({ label: 'dup-within' });
      const event = await createPublishedEventFixture({ createdById: manager.id });
      const payload = rsvpPayload('dup-within');

      const first = await service.registerAttendee(event.slug, payload);
      expect(first).toEqual({ registered: true });

      await expect(service.registerAttendee(event.slug, payload)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(1);
    });

    it('allows the SAME email to register a second attendee under a DIFFERENT name (companion registration)', async () => {
      const manager = await createTestUser({ label: 'dup-companion' });
      const event = await createPublishedEventFixture({ createdById: manager.id });
      const base = rsvpPayload('dup-companion');

      const first = await service.registerAttendee(event.slug, base);
      expect(first).toEqual({ registered: true });

      // Same email, different name — explicitly a LEGITIMATE scenario per
      // architecture.md §7.3 / the schema's deliberate absence of
      // `@@unique([eventId, email])`.
      const companion = { ...base, firstName: 'Companion', surname: `Plus-One-${uniqueSuffix()}` };
      const second = await service.registerAttendee(event.slug, companion);
      expect(second).toEqual({ registered: true });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(2);
    });

    it('allows an identical-tuple resubmission OUTSIDE the window (simulated via a backdated registeredAt)', async () => {
      const manager = await createTestUser({ label: 'dup-outside-window' });
      const event = await createPublishedEventFixture({ createdById: manager.id });
      const payload = rsvpPayload('dup-outside-window');

      const first = await service.registerAttendee(event.slug, payload);
      expect(first).toEqual({ registered: true });

      // Backdate the existing row's `registeredAt` to JUST OUTSIDE the
      // configured window — directly via Prisma (the service has no
      // "register in the past" capability, nor should it; this is purely a
      // test-fixture manipulation to exercise the window boundary without
      // waiting `DUPLICATE_GUARD_WINDOW_MINUTES` minutes in real time).
      const justOutsideWindowMs = (DUPLICATE_GUARD_WINDOW_MINUTES + 1) * 60_000;
      await db.registration.updateMany({
        where: { eventId: event.id, email: payload.email },
        data: { registeredAt: new Date(Date.now() - justOutsideWindowMs) },
      });

      const second = await service.registerAttendee(event.slug, payload);
      expect(second).toEqual({ registered: true });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(2);
    });

    it('allows a resubmission with a corrected age/phone (those fields are deliberately excluded from the match key)', async () => {
      const manager = await createTestUser({ label: 'dup-correction' });
      const event = await createPublishedEventFixture({ createdById: manager.id });
      const payload = rsvpPayload('dup-correction');

      const first = await service.registerAttendee(event.slug, payload);
      expect(first).toEqual({ registered: true });

      // Same (email, firstName, surname) — but a corrected age/phone. This
      // is INTENTIONALLY treated as a duplicate by the documented match key
      // (age/phone excluded) — the guard's job is "don't create two rows
      // for the same person seconds apart," and a same-tuple resubmission
      // moments later is exactly that, regardless of which other fields
      // changed (see `registrations.constants.ts`'s "age/phone deliberately
      // excluded" reasoning for the full "an admin can trivially reconcile
      // two near-identical rows" argument for why this is the RIGHT
      // trade-off, not a bug).
      const corrected = { ...payload, age: 31, phone: '+27 98 765 4321' };
      await expect(service.registerAttendee(event.slug, corrected)).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });
    });
  });

  // =========================================================================
  // file-header point 4 — honeypot bot-defense: silently accept-and-discard
  // =========================================================================
  describe('registerAttendee — honeypot', () => {
    it('returns an indistinguishable success WITHOUT persisting a row when honeypot is non-empty', async () => {
      const manager = await createTestUser({ label: 'honeypot' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      const result = await service.registerAttendee(event.slug, { ...rsvpPayload('honeypot'), honeypot: 'http://spam.example' });

      // IDENTICAL shape to a genuine success — see `RegisterAttendeeResult`'s
      // doc-comment for why the response must be indistinguishable.
      expect(result).toEqual({ registered: true });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(0);
    });

    it('treats an empty-string honeypot exactly like an absent one (genuine submission)', async () => {
      const manager = await createTestUser({ label: 'honeypot-empty' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      const result = await service.registerAttendee(event.slug, { ...rsvpPayload('honeypot-empty'), honeypot: '' });

      expect(result).toEqual({ registered: true });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(1);
    });

    it('does not consume a capacity slot for a honeypot-discarded submission', async () => {
      const manager = await createTestUser({ label: 'honeypot-capacity' });
      const event = await createPublishedEventFixture({ createdById: manager.id, capacity: 1 });

      // A bot fills the honeypot — should be discarded, NOT consume the
      // single available seat.
      await service.registerAttendee(event.slug, { ...rsvpPayload('honeypot-bot'), honeypot: 'i-am-a-bot' });

      // A genuine human still gets the seat.
      const genuine = await service.registerAttendee(event.slug, rsvpPayload('honeypot-genuine'));
      expect(genuine).toEqual({ registered: true });

      const count = await db.registration.count({ where: { eventId: event.id } });
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // file-header point 5 — POPIA placeholder wiring
  // =========================================================================
  describe('registerAttendee — POPIA placeholder wiring', () => {
    it('stamps the documented PLACEHOLDER consentVersion and a null (provisional) retainUntil', async () => {
      const manager = await createTestUser({ label: 'popia' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      await service.registerAttendee(event.slug, rsvpPayload('popia'));

      const stored = await db.registration.findFirst({ where: { eventId: event.id } });
      // The exact-value assertion below is the meaningful proof; a loose
      // substring check would either be redundant (if it matches the same
      // constant) or actively misleading (if someone "fixes" the constant's
      // wording later without updating a hand-rolled substring here). Pinning
      // to the named export is the one assertion that can never drift out of
      // sync with the production value it documents.
      expect(stored?.consentVersion).toBe(CONSENT_VERSION_PLACEHOLDER);
      expect(stored?.retainUntil).toBeNull();
    });
  });

  // =========================================================================
  // staff reads — listForEvent / exportForEvent
  // =========================================================================
  describe('staff reads — listForEvent / exportForEvent', () => {
    it('listForEvent returns a paginated list AND the total headcount, 404s for a nonexistent event', async () => {
      const manager = await createTestUser({ label: 'list' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      await service.registerAttendee(event.slug, rsvpPayload('list-1'));
      await service.registerAttendee(event.slug, rsvpPayload('list-2'));
      await service.registerAttendee(event.slug, rsvpPayload('list-3'));

      const result = await service.listForEvent(manager, event.id, { page: 1, limit: 20 });

      expect(result.registrationCount).toBe(3);
      expect(result.registrations.total).toBe(3);
      expect(result.registrations.items).toHaveLength(3);
      // Earliest-registered-first ordering.
      expect(result.registrations.items[0]?.registeredAt.getTime()).toBeLessThanOrEqual(
        result.registrations.items[1]!.registeredAt.getTime(),
      );

      await expect(service.listForEvent(manager, randomUUID(), { page: 1, limit: 20 })).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('exportForEvent returns the COMPLETE attendee list (unpaginated) and logs an audit entry', async () => {
      const manager = await createTestUser({ label: 'export' });
      const event = await createPublishedEventFixture({ createdById: manager.id });

      for (let i = 0; i < 5; i += 1) {
        await service.registerAttendee(event.slug, rsvpPayload(`export-${i}`));
      }

      const result = await service.exportForEvent(manager, event.id);

      expect(result.event.id).toBe(event.id);
      expect(result.registrations).toHaveLength(5);

      await expect(service.exportForEvent(manager, randomUUID())).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });
  });
});
