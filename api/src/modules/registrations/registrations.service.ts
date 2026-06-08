/**
 * `RegistrationService` (plan.md Phase 4c) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly: the public-RSVP eligibility check
 * (PUBLISHED + not-yet-started), the two-layer capacity guarantee (by
 * delegating to `EventService`'s already-built-and-tested primitive), the
 * soft duplicate-submission guard, the honeypot bot-defense translation, and
 * the POPIA-placeholder consent/retention wiring.
 *
 * Constructed via a factory (`createRegistrationService({ eventService,
 * repository, logger })`) — same dependency-injection convention as
 * `createEventService`/`createBlogService`.
 *
 * ===========================================================================
 * THE CALL CHAIN — confirming, not re-deriving, Phase 4b's groundwork
 * ===========================================================================
 * `registerAttendee` -> `EventService.tryRegisterWithCapacityCheck` ->
 * `EventRepository.tryRegisterAtomically` (the genuinely-concurrency-tested,
 * race-safe `SELECT ... FOR UPDATE` primitive — see that method's extensive
 * doc-comment in `events.repository.ts`, including the preserved record of
 * the FIRST, subtly-broken implementation a genuine `Promise.all` test
 * caught). This service receives an already-constructed `EventService` via
 * DI (mirroring how `app.ts` already wires `eventService` for the Events
 * router) and calls its PUBLIC, documented, exported primitive — it does
 * NOT reach past that service into `EventRepository` directly, and it does
 * NOT re-derive any fragment of the lock-then-count-then-insert algorithm.
 * One primitive, one home, one set of tests (plus this module's OWN tests,
 * which re-prove the SAME concurrency guarantee end-to-end through THIS
 * service's public entry point — see `registrations.service.test.ts`).
 *
 * ===========================================================================
 * WHAT THIS SERVICE ADDS ON TOP OF THE CAPACITY PRIMITIVE
 * (exactly the three things `EventService.tryRegisterWithCapacityCheck`'s
 * own doc-comment names as explicitly NOT its job — see that method's "what
 * this does NOT do" list in `events.service.ts`)
 * ===========================================================================
 *   1. THE ELIGIBILITY CHECK — "is this event open for registration at all?"
 *      (architecture.md §7.3 invariant #6: "only against a PUBLISHED,
 *      not-yet-started event"). This is a TEMPORAL/VISIBILITY rule,
 *      orthogonal to "is there room" — checked FIRST, before the capacity
 *      primitive is ever reached, so a clear, named error ("this event
 *      isn't open for registration") is never confused with "this event is
 *      full."
 *
 *      IMPLEMENTATION CHOICE — reusing `EventService.getPublishedBySlug`
 *      rather than `EventService.getForAdmin`/a bespoke lookup: the public
 *      RSVP route receives a `slug` (per plan.md Phase 4c step 4's `POST
 *      /events/:slug/registrations`), and `getPublishedBySlug` is ALREADY
 *      the exact "does a PUBLICLY VISIBLE event exist at this slug?"
 *      primitive Phase 4b built — collapsing "no such slug" and "exists but
 *      not published" into one `notFound()` outcome (the identical
 *      anti-enumeration posture `BlogService.getPublishedBySlug` documents,
 *      confirmed to transfer to `Event` in `events.service.ts`'s "no
 *      scheduling gap" note). Reusing it here means:
 *        - The PUBLISHED check is performed by the SAME code path the
 *          public detail-page route uses — there is structurally no way for
 *          this service to register against an event the public can't even
 *          see, because both routes resolve "is this event public?" through
 *          one shared, already-tested predicate
 *          (`EventRepository`'s `publicVisibilityWhere`).
 *        - "Not published" and "doesn't exist" collapse into the SAME
 *          `notFound()` response here too — exactly the right anti-
 *          enumeration posture for a public submission endpoint (an
 *          adversary probing slugs to discover unpublished/draft events
 *          gets no signal either way).
 *      The ADDITIONAL "not yet started" half of the invariant
 *      (`event.startsAt > now()`) is then checked explicitly against the
 *      resolved event — `getPublishedBySlug` has no opinion on timing
 *      beyond "is it currently public," and a registration against an event
 *      that has already begun (or concluded) is meaningless ("RSVP for an
 *      event that's already happening/over" — nobody can usefully act on
 *      that confirmation). This surfaces as a `conflict()` naming exactly
 *      what's wrong ("this event has already started — registration is
 *      closed"), not a generic 404/400.
 *
 *   2. THE TWO-LAYER CAPACITY-CHECK ORDERING (plan.md Phase 4c step 4's
 *      "capacity-check ordering matters under load" — already fully
 *      implemented and documented inside `EventService.
 *      tryRegisterWithCapacityCheck` itself; see that method's doc-comment
 *      "two-layer 'fail fast, then guarantee' shape" section). This service
 *      does not re-derive that ordering — it delegates wholesale, which IS
 *      the correct application of "ordering matters": getting it right ONCE,
 *      in the one place that owns the capacity invariant, and trusting that
 *      placement rather than re-checking (and potentially re-breaking) it
 *      here.
 *
 *   3. THE SOFT `(eventId, email, firstName, surname)` DUPLICATE-SUBMISSION
 *      GUARD (plan.md Phase 4c step 3/6 — see `registrations.constants.ts`'s
 *      `DUPLICATE_GUARD_WINDOW_MINUTES` doc-comment for the FULL match-key-
 *      and-window reasoning). Performed via `repository.findRecentDuplicate`
 *      — a plain, non-atomic, advisory `findFirst` — AFTER the eligibility
 *      check (no point guarding against duplicates for an event nobody can
 *      register for) but BEFORE the capacity-check-and-insert (no point
 *      attempting — and potentially consuming a scarce capacity slot for —
 *      a submission this guard would reject anyway).
 *
 *      WHY A TOCTOU RACE HERE IS ACCEPTABLE — unlike the capacity check:
 *      this is explicitly a SOFT, advisory rule (architecture.md §7.3 / the
 *      schema's deliberate absence of `@@unique([eventId, email, ...])`).
 *      Two genuinely-concurrent identical-tuple submissions landing
 *      side-by-side and BOTH slipping through is, at worst, the SAME
 *      "two near-identical rows seconds apart, trivially reconcilable by an
 *      admin" outcome this guard already accepts as a known, documented edge
 *      case for the "corrected resubmission" scenario (see the constants
 *      file's "age/phone deliberately excluded from the match key" note) —
 *      it is NOT an overselling/data-corruption/security failure the way a
 *      racy capacity check would be. Building a `SELECT ... FOR UPDATE`-
 *      grade guarantee for an ADVISORY check would be a textbook category
 *      error: spending atomic-transaction-grade engineering effort (and its
 *      real performance cost — see `events.repository.ts`'s
 *      `REGISTRATION_TRANSACTION_OPTIONS` doc-comment on serialization
 *      latency under contention) on a rule whose entire purpose is "catch
 *      the OBVIOUS double-click case," not "provide a guarantee."
 *
 *   4. THE HONEYPOT BOT-DEFENSE TRANSLATION (plan.md Phase 4c step 4 / this
 *      module's `createRegistrationSchema`'s `honeypot` field doc-comment —
 *      see that doc-comment for the FULL "why silently accept-but-discard,
 *      not reject" reasoning). When `honeypot` carries a non-empty value,
 *      this service fabricates an honest-looking SUCCESS outcome WITHOUT
 *      ever touching the database — no row is inserted, no capacity slot is
 *      consumed, no duplicate-guard lookup runs (there is nothing to guard
 *      against; nothing was submitted, as far as the system of record is
 *      concerned). The caller (router) cannot distinguish this from a real
 *      success by inspecting the response — which is the entire point.
 *
 *   5. THE POPIA PLACEHOLDER WIRING (plan.md Phase 4c step 1) —
 *      `consentVersion` is stamped with `CONSENT_VERSION_PLACEHOLDER` and
 *      `retainUntil` with `retainUntilPlaceholder()` (currently `null`) —
 *      see `registrations.constants.ts` for the full "why a placeholder now,
 *      what changes when the real policy lands" reasoning for each. This
 *      service does not compute, guess, or otherwise invent values for
 *      either — it stamps the ONE named, documented placeholder, so the
 *      day the real values land is a one-constant-file change, not a
 *      re-architecture (exactly the plan's own stated goal).
 */
import type { Logger } from 'pino';
import type { Registration } from '@prisma/client';

import { conflict } from '../../lib/errors';
import { toPaginatedResult, type PaginatedResult, type PaginationQuery } from '../../lib/pagination';
import type { AuthenticatedUser } from '../auth/auth.service';
import type { EventService } from '../events/events.service';
import {
  CONSENT_VERSION_PLACEHOLDER,
  DUPLICATE_GUARD_WINDOW_MINUTES,
  retainUntilPlaceholder,
} from './registrations.constants';
import type { RegistrationRepository } from './registrations.repository';

export interface RegistrationServiceOptions {
  eventService: EventService;
  repository: RegistrationRepository;
  /** Used SOLELY for the export-audit log entry (see `exportForEvent`'s
   * doc-comment for the full "structured pino logging vs. a real `AuditLog`
   * table" decision record) — a child logger scoped the same way
   * `AuthService`'s/`MailService`'s are (mirrors `createAuthService`'s
   * `{ db, mailService, logger }` DI shape). */
  logger: Logger;
}

/** The minimal, already-validated, personal-data field set a public RSVP
 * submission carries — the shape `registerAttendee` accepts, post-`Zod`,
 * pre-honeypot-branch. Mirrors `createRegistrationSchema`'s inferred type
 * minus `honeypot` (handled separately, by name, in the service body — see
 * file-header point 4) so the "real" registration payload this service
 * eventually threads through to `EventService.tryRegisterWithCapacityCheck`
 * is typed as exactly what it is: a registrant's personal data, nothing more. */
export interface RegisterAttendeeInput {
  firstName: string;
  surname: string;
  age: number;
  email: string;
  phone: string;
  /** See `createRegistrationSchema`'s `honeypot` doc-comment — optional,
   * permissive at the schema layer; inspected BY NAME, here, for the
   * silent-accept-and-discard branch (file-header point 4). */
  honeypot?: string;
}

/** The router-facing outcome of `registerAttendee` — deliberately a PLAIN,
 * minimal shape that is IDENTICAL whether the submission was genuinely
 * persisted or silently discarded as a honeypot hit (file-header point 4's
 * "the caller cannot distinguish this from a real success" requirement).
 * `registrationId` is `undefined` for the discarded-honeypot branch — the
 * router never inspects it (there is nothing useful an anonymous RSVP
 * submitter could do with their own registration's id), it exists purely so
 * the genuine-success branch has SOMETHING concrete to return without
 * inventing a parallel "fabricated id" that could be mistaken for a real one
 * in logs/traces. */
export interface RegisterAttendeeResult {
  registered: true;
}

export interface RegistrationService {
  /**
   * The public RSVP submission entry point — see this file's header for the
   * full "what this adds on top of the capacity primitive" decision record
   * (eligibility check, duplicate guard, honeypot translation, POPIA
   * placeholder wiring, in that order).
   *
   * Throws:
   *   - `notFound()` — no such slug, OR the event exists but is not
   *     `PUBLISHED` (collapsed; see file-header point 1's anti-enumeration
   *     reasoning).
   *   - `conflict()` — the event is `PUBLISHED` but has already started
   *     (registration is closed), OR the submission is a soft-guarded
   *     duplicate within the configured window.
   *   - `capacityExceeded()` — surfaced FROM `EventService.
   *     tryRegisterWithCapacityCheck` (this service does not catch/
   *     re-translate it — the factory in `lib/errors.ts` already produces
   *     exactly the shape the SPA needs; re-wrapping it here would only risk
   *     losing the distinct `CAPACITY_EXCEEDED` code `conflict()` lacks).
   *
   * Returns `{ registered: true }` — see `RegisterAttendeeResult`'s
   * doc-comment for why this shape is IDENTICAL across the genuine-success
   * and discarded-honeypot branches.
   */
  registerAttendee(slug: string, input: RegisterAttendeeInput): Promise<RegisterAttendeeResult>;

  /** Staff attendee list for a single event — paginated (see
   * `RegistrationRepository.listForEvent`'s doc-comment for the "why
   * paginate the list but ALSO expose a dedicated headcount" reasoning),
   * augmented with the event's total headcount so the router can shape the
   * `{ items, page, ..., registrationCount }` response the admin UI needs in
   * ONE round trip — mirrors `EventService.transitionStatus`'s
   * "registration-count-awareness hook: always present, zero extra
   * requests" posture. 404s for "no such event" — an existence check BEFORE
   * any registration query runs (the same "ask 'how many does X have' for a
   * nonexistent X should 404, not return a confusing empty list" discipline
   * `EventService.countRegistrations` documents), performed via
   * `EventService.getForAdmin` (NOT `getPublishedBySlug` — staff routes
   * legitimately need attendee lists for DRAFT/CANCELLED events too, e.g.
   * while preparing to publish or winding down a cancelled event; "any
   * Event Manager may view any event" — see `events.service.ts`'s
   * "EVENT-MANAGER OWNERSHIP" decision — applies identically here, so the
   * real, authenticated `actor` is threaded straight through with no
   * additional ownership gate of this service's own). */
  listForEvent(
    actor: AuthenticatedUser,
    eventId: string,
    pagination: PaginationQuery,
  ): Promise<{ registrations: PaginatedResult<Registration>; registrationCount: number }>;

  /**
   * The COMPLETE, unpaginated attendee list for a single event, in export
   * order — the data behind `GET /admin/events/:id/registrations.csv`.
   * 404s for "no such event," identically to `listForEvent`.
   *
   * ===========================================================================
   * THE EXPORT AUDIT LOG (plan.md Phase 4c step 6 / architecture.md §12.1.6)
   * ===========================================================================
   * Per architecture.md §12.1.6 — "CSV export [is] the most likely vector
   * for personal data to leave the system's control" — this method records
   * a structured audit entry: WHO exported (actor id + email + role), WHAT
   * (which `eventId`), and WHEN (timestamp), via `logger.info(...)` at the
   * point of export — BEFORE returning the data to the caller, so the audit
   * trail exists even if a downstream failure (e.g. the response stream
   * breaking mid-write) prevents the export from completing.
   *
   * ---------------------------------------------------------------------------
   * DECISION: structured pino logging — NOT a new `AuditLog` database table
   * ---------------------------------------------------------------------------
   * This is a DELIBERATE, FLAGGED engineering decision, not an oversight —
   * the brief explicitly asks to surface this rather than unilaterally
   * shipping a schema migration for a cross-cutting concern (Users/Phase 4f
   * separately wants role-change audit logging; the two would naturally
   * share ONE mechanism, and that mechanism's shape shouldn't be decided
   * piecemeal, module-by-module, by whichever one happens to ship first).
   *
   * Reasoning for choosing structured logging AS THE V1 MECHANISM:
   *   - `app.ts` already constructs ONE shared, structured, redaction-aware
   *     `pino` logger instance (`rootLogger`) specifically so every
   *     module-level service can log through the SAME instance/policy — see
   *     that file's extensive comment on why a second hand-rolled logger
   *     would risk drifting from the carefully-considered `redact`/`level`
   *     config. `AuthService` already receives and uses a `logger` this way
   *     (e.g. `logger.info({ userId: user.id }, 'Password reset completed
   *     via emailed token')`) — this is an ESTABLISHED pattern in this
   *     codebase for "record a security-relevant event," not a new one this
   *     module invents.
   *   - `pino`'s structured JSON output (architecture.md §11 — "pairs well
   *     with PM2/journald log collection on the VPS") is ALREADY the
   *     project's chosen durable, queryable, off-process record of
   *     security-relevant events — `journald`/PM2 log files persist
   *     independently of the Node process and the Postgres database,
   *     arguably making them a MORE robust audit trail for "did someone
   *     export personal data" than a row in the SAME database that data
   *     lives in (an attacker who compromises the DB cannot retroactively
   *     edit an already-shipped log line the way they could `DELETE FROM
   *     audit_log`).
   *   - A real `AuditLog` table is genuinely more capable for some futures
   *     (queryable via the admin UI, joinable with `User`, filterable by
   *     date range in-app) — but NONE of those capabilities are named as a
   *     v1 requirement anywhere in architecture.md/plan.md for THIS module;
   *     building one now, for one call site, would be exactly the kind of
   *     speculative cross-cutting infrastructure the YAGNI guidance warns
   *     against, AND would almost certainly need revisiting the moment
   *     Phase 4f's role-change audit need arrives and wants a different
   *     shape than whatever this module guessed at in isolation.
   *   - The MINIMUM BAR — "an audit-log entry per export ... is not
   *     optional, treat it as a v1 requirement" — is fully met: every
   *     export produces a structured, timestamped, attributed,
   *     off-process-durable record naming exactly who/what/when. What is
   *     NOT yet built is an in-app QUERY interface over that record — a
   *     strictly separate, larger, and more speculative piece of work that
   *     a real `AuditLog` table would exist to serve.
   *
   * FLAGGED FOR CONFIRMATION: if/when a stakeholder (or Phase 4f's
   * role-change audit need) concretely requires an in-app, queryable audit
   * trail, a real `AuditLog` table is the right next step — at that point it
   * should be designed ONCE, as a shared cross-cutting primitive (its own
   * migration, its own narrow repository, probably its own tiny module),
   * and this call site should be migrated to write to it ALONGSIDE (not
   * instead of — the off-process log durability argument above still holds)
   * the structured log line. That is future work this module deliberately
   * does not attempt to pre-design.
   */
  exportForEvent(
    actor: AuthenticatedUser,
    eventId: string,
  ): Promise<{ event: { id: string; title: string }; registrations: Registration[] }>;
}

/** The duplicate-guard window, expressed in milliseconds — derived ONCE from
 * the named, documented minutes constant (`registrations.constants.ts`),
 * never re-derived inline at the comparison site. */
const DUPLICATE_GUARD_WINDOW_MS = DUPLICATE_GUARD_WINDOW_MINUTES * 60_000;

export function createRegistrationService(options: RegistrationServiceOptions): RegistrationService {
  const { eventService, repository, logger } = options;

  return {
    async registerAttendee(slug, input) {
      // ------------------------------------------------------------------
      // STEP 0 — HONEYPOT CHECK (file-header point 4). Performed FIRST,
      // before any database read whatsoever — a bot-filled submission
      // should cost this system as close to nothing as possible: no event
      // lookup, no eligibility check, no duplicate-guard query, no capacity
      // primitive invocation. "Silently accept and discard" means EXACTLY
      // that — discard as early as structurally possible, fabricate the
      // identical-looking success the genuine path would produce.
      // ------------------------------------------------------------------
      if (input.honeypot && input.honeypot.trim().length > 0) {
        return { registered: true };
      }

      // ------------------------------------------------------------------
      // STEP 1 — ELIGIBILITY: does a PUBLICLY VISIBLE event exist at this
      // slug, and has it not yet started? (file-header point 1)
      //
      // Reuses `getPublishedBySlug` — the SAME "is this event public right
      // now?" predicate the public detail-page route resolves through (see
      // this file's header for the full "why reuse, not re-derive"
      // reasoning, including the anti-enumeration "collapse not-found and
      // not-published" posture this inherits for free).
      // ------------------------------------------------------------------
      const event = await eventService.getPublishedBySlug(slug);

      if (event.startsAt <= new Date()) {
        throw conflict('This event has already started — registration is closed');
      }

      // ------------------------------------------------------------------
      // STEP 2 — THE SOFT DUPLICATE-SUBMISSION GUARD (file-header point 3 /
      // `registrations.constants.ts`'s `DUPLICATE_GUARD_WINDOW_MINUTES`
      // doc-comment for the full match-key-and-window reasoning).
      //
      // A plain, advisory `findFirst` — NOT inside any transaction, NOT
      // racing the capacity check for atomicity (see file-header "why a
      // TOCTOU race here is acceptable" for the full argument: this is a
      // SOFT rule by explicit architectural decision, and the schema has,
      // deliberately, no unique constraint to back a stronger guarantee).
      // ------------------------------------------------------------------
      const recentDuplicate = await repository.findRecentDuplicate({
        eventId: event.id,
        email: input.email,
        firstName: input.firstName,
        surname: input.surname,
      });

      if (recentDuplicate) {
        const ageMs = Date.now() - recentDuplicate.registeredAt.getTime();
        if (ageMs >= 0 && ageMs < DUPLICATE_GUARD_WINDOW_MS) {
          throw conflict(
            'It looks like you already submitted this registration moments ago — ' +
              'no need to submit it again. If you meant to register a different person, ' +
              'please double-check the name fields.',
          );
        }
        // Outside the window — NOT a duplicate for this guard's purposes
        // (could be a deliberate later resubmission, a corrected retry long
        // after the fact, or — per the schema's own documented stance — a
        // second, differently-timed registration the system has no business
        // blocking). Fall through to the normal registration path.
      }

      // ------------------------------------------------------------------
      // STEP 3 — THE TWO-LAYER, RACE-SAFE CAPACITY-CHECK-AND-INSERT
      // (file-header point 2). Delegates WHOLESALE to `EventService.
      // tryRegisterWithCapacityCheck` — see that method's doc-comment in
      // `events.service.ts` for the complete "fast pre-check, then atomic
      // guarantee" decision record this service does not re-derive.
      //
      // POPIA PLACEHOLDER WIRING (file-header point 5): `consentVersion`
      // and `retainUntil` are stamped HERE, from the ONE named, documented
      // placeholder source each — never guessed, never computed inline.
      // ------------------------------------------------------------------
      await eventService.tryRegisterWithCapacityCheck(event.id, {
        firstName: input.firstName,
        surname: input.surname,
        age: input.age,
        email: input.email,
        phone: input.phone,
        consentVersion: CONSENT_VERSION_PLACEHOLDER,
        retainUntil: retainUntilPlaceholder(),
      });

      return { registered: true };
    },

    async listForEvent(actor, eventId, pagination) {
      // Existence check first — mirrors `EventService.countRegistrations`'s
      // "ask about a nonexistent event -> 404, not a confusing empty
      // result" discipline. `getForAdmin` 404s via its own `loadOrNotFound`
      // (see `events.service.ts`) for "no such event," and performs no
      // additional ownership check (any Event Manager/Admin may view any
      // event — see "EVENT-MANAGER OWNERSHIP" in that file's header), so
      // threading the real, authenticated `actor` straight through is both
      // necessary (it's the method's contract) and complete (there is
      // nothing further to gate here).
      await eventService.getForAdmin(actor, eventId);

      const [{ items, total }, registrationCount] = await Promise.all([
        repository.listForEvent(eventId, pagination),
        repository.countForEvent(eventId),
      ]);

      return {
        registrations: toPaginatedResult(items, pagination, total),
        registrationCount,
      };
    },

    async exportForEvent(actor, eventId) {
      const event = await eventService.getForAdmin(actor, eventId);

      const registrations = await repository.listAllForEvent(eventId);

      // THE AUDIT LOG ENTRY — see this method's interface doc-comment for
      // the full "structured pino logging vs. AuditLog table" decision
      // record. Logged BEFORE returning, at `info` level (a normal,
      // expected, security-relevant operation — not a warning/error), with
      // a dedicated, greppable `event` field (`'registration_export'`) so
      // this exact audit trail can be isolated from the surrounding request
      // log via `journalctl`/log-aggregation tooling regardless of what else
      // is logged at `info` elsewhere.
      logger.info(
        {
          event: 'registration_export',
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          eventId: event.id,
          eventTitle: event.title,
          registrationCount: registrations.length,
          exportedAt: new Date().toISOString(),
        },
        'Registration CSV export',
      );

      return { event: { id: event.id, title: event.title }, registrations };
    },
  };
}
