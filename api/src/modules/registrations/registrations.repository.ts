/**
 * `Registration` repository (plan.md Phase 4c) — the persistence layer in
 * this module's router -> service -> repository chain (architecture.md §6
 * "Clean layering"). Owns ALL direct Prisma access for `Registration` reads
 * used by the staff attendee-list/export/headcount routes and the soft
 * duplicate-submission guard. Mirrors `events.repository.ts`'s factory-based
 * shape (`createRegistrationRepository({ db })`) — no business rules live
 * here, only typed, named queries.
 *
 * ===========================================================================
 * Where does the WRITE path live?
 * ===========================================================================
 * Deliberately NOT here. The race-safe "is there room? if so, insert" write
 * is `EventRepository.tryRegisterAtomically` — built and exhaustively tested
 * in Phase 4b SPECIFICALLY so this module could call straight into it (see
 * that method's extensive doc-comment for the full "why this lives on
 * `EventRepository`, not a future `RegistrationRepository`" decision record,
 * and the genuine `Promise.all` concurrency test in
 * `events.repository.test.ts` that proves it race-safe). Re-deriving a
 * parallel insert path here — even one that "only" duplicates the capacity
 * check — would reintroduce the EXACT TOCTOU race that primitive exists to
 * close, and would mean two code paths to keep in sync forever after.
 * `RegistrationService.registerAttendee` therefore calls
 * `EventService.tryRegisterWithCapacityCheck` (which itself delegates to
 * `EventRepository.tryRegisterAtomically`) directly — see that service's
 * doc-comment for the full call chain.
 *
 * This repository owns exactly the READ-side queries that genuinely belong
 * to the `Registration` resource: listing/counting an event's attendees
 * (staff routes) and the soft duplicate-submission lookup (a plain,
 * non-atomic, advisory `findFirst` — see `registrations.service.ts`'s
 * "DUPLICATE-GUARD" doc-comment for why a TOCTOU race here is acceptable,
 * unlike the capacity check).
 */
import type { Prisma, PrismaClient, Registration } from '@prisma/client';

import { toSkipTake, type PaginationQuery } from '../../lib/pagination';

export interface RegistrationRepositoryOptions {
  db: PrismaClient;
}

/** Attendee-list ordering — earliest-registered first. The natural "in the
 * order people signed up" reading for a staff member scanning a list of
 * names ahead of an event (mirrors a physical sign-up sheet's chronological
 * order — the most intuitive default for this exact use case, and the same
 * "pick the obviously-correct default, don't invent a sort-picker nobody
 * asked for" YAGNI posture `events.repository.ts`'s ordering constants
 * document). */
const ATTENDEE_LIST_ORDER_BY = { registeredAt: 'asc' } as const;

export interface RegistrationRepository {
  /**
   * Staff attendee list for a single event — paginated, earliest-registered
   * first. Returns `{ items, total }` so the router/service can shape both
   * the paginated UI list AND the headcount from one query pair, mirroring
   * `EventRepository.listPublished`'s "list and count must agree with each
   * other and with the DB, computed in the SAME `$transaction`" discipline.
   *
   * NOTE on pagination here — a deliberate decision, not an oversight: the
   * brief asks us to weigh "does the admin UI want a full headcount list, or
   * is pagination appropriate?" CHOSEN: paginate the LIST view (consistency
   * with every other admin list in this app — Blog posts, Events — and a
   * defensive bound against a popular event's attendee list growing into the
   * thousands and producing an enormous single response on a low-resource
   * VPS), but ALSO expose an unpaginated, dedicated `count` (see below) so
   * the "headcount" the plan separately names is always cheap, accurate, and
   * NEVER entangled with "how many rows fit on the current page." This is
   * the same shape `EventService`'s registration-count-awareness hook
   * already established — count and list are RELATED but DISTINCT
   * questions, each best answered by its own narrowly-scoped query.
   */
  listForEvent(
    eventId: string,
    pagination: PaginationQuery,
  ): Promise<{ items: Registration[]; total: number }>;

  /**
   * The COMPLETE, unpaginated set of registrations for a single event, in
   * the SAME canonical order as `listForEvent` — the dedicated query behind
   * `GET /admin/events/:id/registrations.csv`.
   *
   * WHY a separate method rather than "page through `listForEvent` until
   * exhausted": a CSV export is, definitionally, "give me everything" — an
   * admin exporting an attendee list to plan catering/seating/whatever wants
   * the WHOLE list in one file, not a paginated subset. Looping
   * `listForEvent` with an ever-incrementing `page` would (a) be needlessly
   * convoluted for a "small, low-traffic, single-VPS" collection size
   * (architecture.md §3 — even a packed-out event tops out at a few hundred
   * attendees, comfortably within a single `findMany`'s reach), and (b)
   * risk subtle pagination-drift bugs (a registration landing between two
   * page-fetches could be double-counted or skipped). One query, one
   * consistent snapshot, one CSV — the simplest model that satisfies the
   * requirement (YAGNI).
   */
  listAllForEvent(eventId: string): Promise<Registration[]>;

  /** Headcount for a single event — a thin, dedicated `count`, kept
   * structurally distinct from `listForEvent`'s `total` (which is scoped to
   * whatever `where` the list query uses — today identical, but keeping
   * "how many people are registered" answerable without ANY pagination
   * machinery in the loop is the more honest, more reusable shape; this is
   * also the EXACT primitive `EventService.countRegistrations` already
   * exposes — see `registrations.service.ts`'s doc-comment for why this
   * repository nonetheless owns its own copy rather than reaching across
   * module boundaries for a read that legitimately belongs to BOTH
   * resources' read-models). */
  countForEvent(eventId: string): Promise<number>;

  /**
   * ===========================================================================
   * THE SOFT DUPLICATE-SUBMISSION GUARD LOOKUP
   * (plan.md Phase 4c step 3/6 — see `registrations.constants.ts`'s
   * `DUPLICATE_GUARD_WINDOW_MINUTES` doc-comment for the FULL match-key and
   * window-length reasoning; this method is purely the typed, named query
   * that reasoning compiles down to)
   * ===========================================================================
   * Looks up the most recent existing registration matching the EXACT
   * `(eventId, email, firstName, surname)` tuple, returning it (or `null`)
   * regardless of how old it is — the SERVICE compares its `registeredAt`
   * against the configured window and decides whether to reject. Splitting
   * the concerns this way (repository: "find the most recent match, if any";
   * service: "is it recent enough to matter?") keeps the time-window
   * POLICY in the layer that owns business rules, while the repository
   * stays a plain, named, reusable query — exactly the "domain rules live in
   * the service layer, never in the DB schema [or repository]" discipline
   * architecture.md §6 names.
   *
   * Case-insensitive `email` comparison: `createRegistrationSchema` already
   * lower-cases incoming `email` via `.toLowerCase()` before it reaches the
   * service — so values landing in this lookup (and in stored rows, since
   * the same schema gates the write path) are already normalized, and a
   * plain equality comparison is correct without needing
   * `mode: 'insensitive'` here. `firstName`/`surname` are compared exactly
   * as submitted (after `.trim()`) — these are free-text personal-name
   * fields where case carries real information (e.g. "Mcdonald" vs
   * "McDonald"), and silently folding case would risk treating two
   * genuinely-different people's submitted spellings as "the same person,"
   * which is a worse failure mode than occasionally missing a true duplicate
   * that differs only in capitalization (a vanishingly rare resubmission
   * shape — the double-click/retry scenario this guard targets reproduces
   * the EXACT same request body, capitalization included).
   */
  findRecentDuplicate(criteria: {
    eventId: string;
    email: string;
    firstName: string;
    surname: string;
  }): Promise<Registration | null>;
}

export function createRegistrationRepository({ db }: RegistrationRepositoryOptions): RegistrationRepository {
  return {
    async listForEvent(eventId, pagination) {
      const where: Prisma.RegistrationWhereInput = { eventId };
      const { skip, take } = toSkipTake(pagination);

      const [items, total] = await db.$transaction([
        db.registration.findMany({ where, orderBy: ATTENDEE_LIST_ORDER_BY, skip, take }),
        db.registration.count({ where }),
      ]);

      return { items, total };
    },

    async listAllForEvent(eventId) {
      return db.registration.findMany({
        where: { eventId },
        orderBy: ATTENDEE_LIST_ORDER_BY,
      });
    },

    async countForEvent(eventId) {
      return db.registration.count({ where: { eventId } });
    },

    async findRecentDuplicate({ eventId, email, firstName, surname }) {
      return db.registration.findFirst({
        where: { eventId, email, firstName, surname },
        orderBy: { registeredAt: 'desc' },
      });
    },
  };
}
