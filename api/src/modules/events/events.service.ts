/**
 * `EventService` (plan.md Phase 4b steps 1-2) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly: slug generation/uniqueness, the
 * `status` state machine, the dormant-paid-fields guarantee (ADR-0006), and
 * — the most consequential piece of groundwork in this module — the
 * race-safe capacity-check-and-register primitive that Phase 4c's
 * `RegistrationService.registerAttendee` will call into directly.
 *
 * Constructed via a factory (`createEventService({ repository })`) — same
 * dependency-injection convention as `createBlogService`/`createAuthService`.
 *
 * ===========================================================================
 * DECISION 1 — SLUG POLICY: generate-once-at-CREATION, identical to Blog
 * ===========================================================================
 * `Event.slug` is `String @unique` — non-nullable, exactly the same schema
 * shape as `BlogPost.slug` (see `prisma/schema.prisma` line 258 vs line 224).
 * `blog.service.ts`'s file-header doc-comment already worked through, in
 * exhaustive detail, why a non-nullable unique `slug` column makes
 * "generate on first publish" structurally inexpressible (a `DRAFT` row
 * cannot be persisted without ALREADY having a permanent, unique slug) and
 * why generating at CREATION is not a deviation but the strictly-better
 * DERIVED reading of the underlying "stable public links" goal (creation
 * always precedes first-publish, so anything stable-from-first-publish is
 * trivially stable-from-creation too — and internally-shared draft-review
 * links benefit "for free").
 *
 * EVERY WORD of that reasoning transfers to `Event` UNCHANGED — this is a
 * CONFIRMATION that the identical policy applies (per this task's brief:
 * "confirm rather than silently assume"), not a fresh derivation:
 *   - The schema constraint is byte-for-byte identical (`String @unique`,
 *     non-nullable).
 *   - The underlying goal is identical: stable public URLs for shared/SEO'd
 *     event links (and, by the same "drafts are linkable too" logic,
 *     stable internal admin-review links for an Event Manager to share with
 *     an Admin before publishing).
 *   - The "keep stable thereafter + Admin-only manual override" promise is
 *     preserved exactly the same way: `update`/status-transitions never
 *     touch `slug`; `setSlug` is the dedicated, narrowly-scoped, ADMIN-ONLY
 *     escape hatch (gated at the router by `requireRole(authService,
 *     'ADMIN')` ALONE — not `requireRole(authService, 'ADMIN',
 *     'EVENT_MANAGER')` — for the identical "an author rewriting their own
 *     resource's public URL unsupervised is the exact link-breakage hazard
 *     the policy exists to prevent" reason `BlogService.setSlug` documents).
 * Slug generation reuses the SHARED `slugify`/`slugCandidate` helpers from
 * `modules/blog/slug.ts` VERBATIM — that file's own header explicitly
 * anticipates this ("reusable if Events ... wants the identical
 * 'title -> URL-safe identifier' transformation"); collision resolution
 * follows the identical `-2`/`-3`/... policy, probed up to
 * `MAX_SLUG_COLLISION_ATTEMPTS` before failing loudly with `conflict()`.
 *
 * ===========================================================================
 * DECISION 2 — STATUS TRANSITION GRAPH (plan.md Phase 4b step 4's "undecided")
 * ===========================================================================
 * The plan flags this explicitly as needing a decision: "can a CANCELLED
 * event be reopened? can a PUBLISHED event revert to DRAFT if it already has
 * registrations?" Below is the COMPLETE, EXPLICIT transition table this
 * service enforces — encoded as the single `ALLOWED_TRANSITIONS` map so
 * "is (from, to) legal?" is answered in exactly one place, the same
 * "encode the rule once, structurally, not as scattered inline checks"
 * discipline `canEditPost`/`publicVisibilityWhere` already established.
 *
 *   From \ To   | DRAFT | PUBLISHED | CANCELLED |  Notes
 *   ------------|-------|-----------|-----------|----------------------------
 *   DRAFT       |   -   |    YES    |    YES    |  normal launch path; an
 *               |       |           |           |  unwanted draft can be
 *               |       |           |           |  scrapped via CANCELLED
 *               |       |           |           |  (no DRAFT delete-equivalent
 *               |       |           |           |  status exists; CANCELLED
 *               |       |           |           |  is the closest "this is
 *               |       |           |           |  not happening" signal a
 *               |       |           |           |  status value can carry)
 *   PUBLISHED   |  YES  |     -     |    YES    |  see "PUBLISHED -> DRAFT"
 *               |       |           |           |  reasoning below
 *   CANCELLED   |  YES  |    YES    |     -     |  see "reopen" reasoning
 *               |       |           |           |  below — YES, with a loud
 *               |       |           |           |  registration-count signal
 *
 * Reasoning for each non-obvious cell:
 *
 *   1. PUBLISHED -> DRAFT ("unpublish") IS ALLOWED, REGARDLESS OF EXISTING
 *      REGISTRATIONS — mirroring Blog's `unpublish` exactly.
 *      An Event Manager who published an event prematurely (wrong date,
 *      missing detail, needs another review pass) must be able to pull it
 *      back from public view without destroying it — exactly the same
 *      "oops, not ready yet" recovery Blog's `unpublish` exists for. This is
 *      NOT the same as cancelling: `DRAFT` communicates "not currently
 *      public, may return," `CANCELLED` communicates "this is not
 *      happening." Existing registrations are NOT a structural blocker here
 *      — they remain attached to the event (the FK is `Restrict`, not
 *      `Cascade` — see `prisma/schema.prisma`'s inline note on
 *      `Registration.event`) and become visible again the moment the event
 *      re-publishes. HOWEVER — and this is where the "warn before a
 *      destructive change" requirement (plan.md Phase 4b step 4 / 4c step 4)
 *      actually bites — pulling a PUBLISHED event with existing registrants
 *      back to DRAFT is exactly the kind of "registrants might show up to
 *      something that's no longer publicly listed" surprise an Event
 *      Manager needs to see coming. See "THE REGISTRATION-COUNT-AWARENESS
 *      HOOK" section below for how this service surfaces that signal without
 *      building a notification mechanism that doesn't exist.
 *
 *   2. CANCELLED -> {DRAFT, PUBLISHED} ("reopen") IS ALLOWED.
 *      The plan asks this explicitly. Hard-forbidding it would mean a
 *      cancelled-by-mistake event (fat-fingered the wrong "cancel" button,
 *      or a venue/date conflict that later resolved) becomes PERMANENTLY
 *      unrecoverable — the only "fix" would be deleting it (impossible once
 *      it has registrations — `onDelete: Restrict`) and recreating it from
 *      scratch under a brand-new id/slug, silently breaking any link already
 *      shared. That is a strictly worse outcome than allowing a deliberate,
 *      visible "reopen" action. Symmetrically with point 1, reopening a
 *      CANCELLED event that already has registrations (people who registered
 *      before it was cancelled, and may since have been told "it's off") is
 *      exactly the kind of "are you sure? N people registered under the
 *      previous status" moment the registration-count hook exists to name —
 *      see below. `CANCELLED -> DRAFT` lets a manager quietly re-stage it
 *      before re-announcing; `CANCELLED -> PUBLISHED` re-announces
 *      immediately. Both are legal; which one a manager picks is an
 *      editorial choice this service has no business constraining further.
 *
 *   3. DRAFT -> CANCELLED IS ALLOWED (not merely DRAFT -> PUBLISHED).
 *      A drafted-but-never-published event can be definitively "called off"
 *      (e.g. the date no longer works, the idea was scrapped) without first
 *      having to publish-then-cancel it — an unnecessary, confusing detour
 *      through public visibility for something that should never have been
 *      public in the first place.
 *
 *   4. Same-state "transitions" (DRAFT->DRAFT, etc.) are REJECTED with
 *      `conflict()`, not silently accepted as a no-op. Unlike Blog's
 *      `publish` (which deliberately allows "re-publish to bump
 *      `publishedAt`" as a meaningful idempotent action), `Event` has no
 *      timestamp-stamping side effect a same-state transition could
 *      meaningfully re-trigger — accepting it would just be confusing API
 *      surface ("I asked to publish a published event and... nothing
 *      happened, silently?"). A named `conflict()` ("already in that state")
 *      is the more honest response.
 *
 * ===========================================================================
 * THE REGISTRATION-COUNT-AWARENESS HOOK (plan.md Phase 4b step 4 / 4c step 4)
 * ===========================================================================
 * The plan wants "the admin UI should warn 'this event has N registrations'
 * before a destructive status change or date change" — but explicitly warns
 * against over-building ("don't over-build a notification mechanism that
 * doesn't exist"; no email integration exists to actually notify registrants
 * — that's named as a known, unsolved gap, not this module's job to solve).
 *
 * THE CHOSEN SHAPE: `transitionStatus` and `updateEvent` (for `startsAt`/
 * `endsAt` changes) ALWAYS include `registrationCount` in their returned
 * result — not merely "when it's nonzero," not gated behind a special
 * "dry run" flag, and not as a separate round trip the SPA must remember to
 * make. This is the simplest possible hook that satisfies the requirement
 * (YAGNI): the admin UI can trivially render "Cancelling this event — it
 * currently has 12 registration(s)" (or omit the clause entirely when the
 * count is `0`) directly from the SAME response it already needed for the
 * status-change confirmation, with ZERO extra requests, ZERO new endpoints,
 * and ZERO speculative "warning severity" taxonomy this service has no basis
 * to design. Today (pre-Phase-4c) the count is structurally always `0` — no
 * `Registration` rows can exist without `RegistrationService.
 * registerAttendee` to create them — but the hook is wired NOW, correctly,
 * so Phase 4c's first registration makes it immediately meaningful with zero
 * further service-layer changes (a "no-op-but-correct stub," exactly as this
 * task's brief asks for).
 *
 * ===========================================================================
 * DECISION 3 — EVENT-MANAGER OWNERSHIP: any Event Manager may manage any event
 * ===========================================================================
 * `ownership.ts`'s file header explicitly flags this as the open question
 * Phase 4b must resolve: "whether Event Managers are scoped to 'events they
 * created' the same way Bloggers are scoped to 'posts they authored,' or
 * whether any Event Manager may manage any event."
 *
 * DECISION: any `EVENT_MANAGER` may manage ANY event — no `canManageEvent`
 * per-resource ownership predicate exists, and none is built. Reasoning:
 *   - architecture.md §9.2's RBAC matrix and plan.md Phase 4b step 4 both
 *     describe the gate as a flat `requireRole('ADMIN', 'EVENT_MANAGER')`
 *     with NO accompanying "and only their own" qualifier — contrast this
 *     with Blog, where the architecture brief explicitly names "Bloggers
 *     edit own posts only" as the rule (and even THAT is flagged as an open
 *     question pending stakeholder confirmation). No equivalent sentence
 *     exists anywhere for Events.
 *   - A small church/community org (architecture.md §3's "small org" Conway's
 *     Law framing) realistically has very few Event Managers — plausibly
 *     one or two — coordinating a shared events calendar across branches
 *     (Cape Town/Durban/Other). Per-manager silos would actively HURT the
 *     real workflow ("Sipho is on leave, can you publish the youth-camp
 *     event he drafted?" should be a non-event, not a permissions wall).
 *   - `Event.createdById` exists (and is `onDelete: Restrict`'d to `User`)
 *     for AUDIT/ATTRIBUTION purposes — "who set this up" — exactly the same
 *     role `BlogPost.authorId` plays for attribution, WITHOUT also being
 *     mechanically promoted into an access-control boundary. The schema
 *     comment on that field never claims an ownership semantic; this service
 *     does not invent one.
 *   - This is the SIMPLEST model that satisfies the stated requirement
 *     (YAGNI) — and, true to `ownership.ts`'s own framing of the *Blogger*
 *     default ("a one-line service change" to flip later), promoting
 *     `createdById` into an ownership boundary later — should a stakeholder
 *     ever ask for it — is similarly a small, contained, well-flagged change
 *     RIGHT HERE (add a `canManageEvent` predicate mirroring `canEditPost`'s
 *     shape, thread it through `requireOwnedOrNotFound`-equivalent helpers),
 *     not a retrofit that ripples through the whole module.
 * Consequently: `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')` is BOTH
 * necessary AND sufficient at the router for every `/admin/events/*` route —
 * unlike Blog, there is no second, service-layer ownership gate to layer on
 * top. (Compare `blog.router.ts`'s extensive "necessary but not sufficient"
 * note — that note's premise does not hold for this module, by design.)
 *
 * ===========================================================================
 * "NO PUBLISHEDAT-EQUIVALENT SCHEDULING GAP" — confirming the brief's question
 * ===========================================================================
 * The brief asks to "confirm there's no equivalent scheduling gap to worry
 * about" for `GET /events/:slug`'s visibility check. Confirmed: `Event` has
 * NO `publishedAt`-shaped column anywhere in its schema (contrast
 * `BlogPost.publishedAt DateTime?`, which exists specifically to support
 * scheduled publishing — see `prisma/schema.prisma` lines 224-252). There is
 * therefore no mechanism by which an `Event` could be marked `PUBLISHED` yet
 * remain non-public until some future instant — `status = PUBLISHED` is
 * ALREADY the complete, and only, public-visibility predicate. (Whether a
 * *future* feature should add scheduled-event-publishing is a product
 * question well outside this module's scope — and would, if ever built,
 * require its own migration; nothing here should be read as silently
 * assuming it exists.)
 */
import type { Event, EventStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.service';
import { capacityExceeded, conflict, notFound } from '../../lib/errors';
import { toPaginatedResult, type PaginatedResult, type PaginationQuery } from '../../lib/pagination';
import { slugCandidate, slugify } from '../blog/slug';
import type { AtomicRegistrationResult, EventRepository } from './events.repository';

export interface EventServiceOptions {
  repository: EventRepository;
}

/** Identical bound, identical reasoning, as `MAX_SLUG_COLLISION_ATTEMPTS` in
 * `blog.service.ts` — see that constant's doc-comment in full; everything it
 * says about "small, editorially-curated collection" and "fail loudly rather
 * than loop unboundedly" applies to Events with even more force (an org runs
 * dramatically fewer events than blog posts). */
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

/**
 * The complete, explicit status-transition graph — see this file's
 * "STATUS TRANSITION GRAPH" doc-comment for the full reasoning behind each
 * cell. `ALLOWED_TRANSITIONS[from]` is the SET of `to` values legal from
 * `from`; anything not listed (including `from === to`) is rejected.
 *
 * Encoding this as a lookup table — rather than a chain of `if` statements
 * scattered through `transitionStatus` — makes the graph itself
 * inspectable, testable in isolation (see `events.service.test.ts`'s
 * "transition graph" describe block, which asserts on this table's shape
 * directly, not just on `transitionStatus`'s behaviour through it), and
 * impossible to accidentally half-update (e.g. allowing `A->B` without also
 * deciding `B->A`).
 */
const ALLOWED_TRANSITIONS: Record<EventStatus, ReadonlySet<EventStatus>> = {
  DRAFT: new Set<EventStatus>(['PUBLISHED', 'CANCELLED']),
  PUBLISHED: new Set<EventStatus>(['DRAFT', 'CANCELLED']),
  CANCELLED: new Set<EventStatus>(['DRAFT', 'PUBLISHED']),
};

/** Human-readable transition-rejection messages — named here so
 * `transitionStatus`'s body reads as "is this legal? if not, explain why"
 * rather than interleaving string-building with the lookup logic. */
function transitionRejectionMessage(from: EventStatus, to: EventStatus): string {
  if (from === to) {
    return `Event is already ${to} — no transition occurred`;
  }
  return `Cannot transition an event from ${from} to ${to}`;
}

/** A single-event response augmented with the registration count — the
 * "registration-count-awareness hook" this file's header documents.
 * `transitionStatus` and `updateEvent` (when changing `startsAt`/`endsAt`)
 * return this shape so the SPA can render "this event has N
 * registration(s)" directly from the mutation response. */
export interface EventWithRegistrationCount {
  event: Event;
  registrationCount: number;
}

/** Pure helper: derives the candidate base slug from a title — identical
 * shape and "non-empty fallback" reasoning to `baseSlugFor` in
 * `blog.service.ts` (search that file for the full "`slugify` can return ''"
 * explanation; reproduced here, not imported, because it is a TINY,
 * self-contained helper and importing a non-exported function across module
 * boundaries would be worse coupling than three duplicated lines). */
function baseSlugFor(title: string): string {
  const slug = slugify(title);
  return slug.length > 0 ? slug : 'event';
}

export interface EventService {
  /** Creates a new event as `DRAFT`, generating and persisting its permanent
   * `slug` from `title` at this exact moment — see file-header "SLUG POLICY"
   * for why creation (mirroring Blog exactly) is correct here too.
   * `isPaid`/`priceCents` are NEVER threaded through to the repository (see
   * "DORMANT FIELDS" note on `events.schemas.ts`'s `dormantPaidFieldsShape`
   * — the schema already rejects non-default values before this is ever
   * called; this method's input type doesn't even carry those fields, a
   * second, structural layer of the same guarantee). */
  createEvent(
    actor: AuthenticatedUser,
    input: {
      title: string;
      description: string;
      startsAt: Date;
      endsAt: Date;
      branch: 'CAPE_TOWN' | 'DURBAN' | 'OTHER';
      locationDetail: string;
      capacity?: number | null;
    },
  ): Promise<Event>;

  /** Partial descriptive/scheduling update. Re-validates the cross-field
   * `endsAt > startsAt` invariant against the MERGED (existing + incoming)
   * result — see this method's body comment for why a partial body cannot
   * be checked in isolation. Returns the registration-count-augmented shape
   * (this file's header "REGISTRATION-COUNT-AWARENESS HOOK") whenever the
   * update changes `startsAt`/`endsAt` (a "material date change," in the
   * plan's words) — the admin UI's natural moment to show "N people are
   * registered for the CURRENT date/time" before committing a change that
   * could strand them. */
  updateEvent(
    actor: AuthenticatedUser,
    id: string,
    input: Partial<{
      title: string;
      description: string;
      startsAt: Date;
      endsAt: Date;
      branch: 'CAPE_TOWN' | 'DURBAN' | 'OTHER';
      locationDetail: string;
      capacity: number | null;
    }>,
  ): Promise<EventWithRegistrationCount>;

  /** The single, explicit status-transition entry point — validates
   * `(from, to)` against `ALLOWED_TRANSITIONS`, throws `conflict()` for any
   * illegal pair (including same-state "transitions"; see file-header point
   * 4), and ALWAYS returns the registration-count-augmented shape (the
   * "warn before a destructive change" hook). No separate `publish`/
   * `unpublish`/`cancel` methods — see `EventRepository.setStatus`'s
   * doc-comment for why one parameterized transition is the more honest
   * shape for a model with no per-transition side effect to stamp. */
  transitionStatus(actor: AuthenticatedUser, id: string, to: EventStatus): Promise<EventWithRegistrationCount>;

  /** The dedicated, Admin-only, explicit manual-slug-edit escape hatch —
   * IDENTICAL shape, gating, and reasoning to `BlogService.setSlug`
   * (deliberately NOT layered on the general `requireRole(authService,
   * 'ADMIN', 'EVENT_MANAGER')` gate — see file-header "SLUG POLICY" §
   * confirming why the Blog reasoning transfers verbatim). */
  setSlug(actor: AuthenticatedUser, id: string, newSlug: string): Promise<Event>;

  /** Admin "all events" list — NOT scoped by creator (see file-header
   * "EVENT-MANAGER OWNERSHIP" decision: any Event Manager may see/manage any
   * event). Optionally filtered by `branch`. A thin pass-through to
   * `repository.listForAdmin`, preserving the router -> service ->
   * repository layering even where this method adds no extra rule of its
   * own (mirrors `BlogService.getPublished`'s "thin pass-through" shape). */
  listForAdmin(
    actor: AuthenticatedUser,
    pagination: PaginationQuery,
    filters: { branch?: 'CAPE_TOWN' | 'DURBAN' | 'OTHER' },
  ): Promise<PaginatedResult<Event>>;

  /** Admin single-event lookup for the "edit" view — 404s for "no such
   * event." NO ownership check layered on top (see "EVENT-MANAGER
   * OWNERSHIP" — there is none to layer; any Event Manager may view any
   * event, by design). */
  getForAdmin(actor: AuthenticatedUser, id: string): Promise<Event>;

  /** Hard-deletes an event. 404s for "no such event." Translates the
   * database's `Restrict`-FK rejection (an event with existing
   * registrations cannot be deleted — see `EventRepository.delete`'s
   * doc-comment and `prisma/schema.prisma`'s inline note on
   * `Registration.event`) into a clear, named `conflict()` that ALSO
   * reports the registration count — the SAME registration-count-awareness
   * principle as `transitionStatus`/`updateEvent`, applied to the most
   * destructive operation this module exposes. An admin attempting to
   * delete a heavily-registered event gets "cannot delete — N people are
   * registered; export/handle their data first," not an opaque
   * foreign-key-violation stack trace. */
  deleteEvent(actor: AuthenticatedUser, id: string): Promise<void>;

  /** Public list: `status = PUBLISHED`, optionally `branch`-scoped, sliced
   * by `temporal` (`'upcoming' | 'past' | 'all'`) — see file-header
   * "UPCOMING/PAST SEMANTICS" note (encoded in `events.repository.ts`'s
   * `temporalWhere`) for the full `endsAt`-based reasoning. A thin
   * pass-through, mirroring `BlogService.getPublished`. */
  getPublished(
    pagination: PaginationQuery,
    filters: { branch?: 'CAPE_TOWN' | 'DURBAN' | 'OTHER'; temporal: 'upcoming' | 'past' | 'all' },
  ): Promise<PaginatedResult<Event>>;

  /** Public detail-by-slug — 404s (via `notFound()`) for "no such slug" AND
   * for "exists, but not `PUBLISHED`" — collapsed into one outcome,
   * mirroring `BlogService.getPublishedBySlug`'s anti-enumeration posture
   * (see that method's doc-comment for the full "a distinguishing response
   * would itself be a content-existence leak" reasoning, which transfers
   * here unchanged — confirmed in this file's header "no scheduling gap"
   * note that `status = PUBLISHED` alone is the complete predicate). */
  getPublishedBySlug(slug: string): Promise<Event>;

  /**
   * ===========================================================================
   * THE CAPACITY-CHECK PRIMITIVE — exported, documented, genuinely tested NOW
   * (architecture.md §7.3 invariant #6 / plan.md Phase 4b step 2)
   * ===========================================================================
   *
   * THIS is the method Phase 4c's `RegistrationService.registerAttendee`
   * calls — by name, directly — to perform the race-safe "is there room? if
   * so, insert" operation. Naming and placing it here (on `EventService`,
   * the module that owns the capacity invariant) rather than requiring
   * `RegistrationService` to re-derive any part of the algorithm is the
   * literal "build it as a reusable exported primitive ... so Phase 4c's
   * `registerAttendee` can call straight into it" instruction this task's
   * brief names.
   *
   * ---------------------------------------------------------------------------
   * What this method does NOT do (by design — these are `registerAttendee`'s
   * job, layered ON TOP of this primitive, not duplicated by it):
   * ---------------------------------------------------------------------------
   *   - It does NOT check that the event is `PUBLISHED` and not yet started
   *     (architecture.md §7.3 invariant #6's "only against a PUBLISHED,
   *     not-yet-started event"). That is a TEMPORAL/VISIBILITY rule about
   *     *whether registration should be attempted at all* — orthogonal to
   *     "is there room," and `RegistrationService`'s job to check FIRST
   *     (loading the event, confirming `status === 'PUBLISHED' && startsAt >
   *     now()`) before ever reaching this primitive. Folding it in here
   *     would make this primitive's contract muddier (what should it return
   *     for "event not found," "event not published," "event already
   *     started," vs. "event full"? — four different `AppError`s the
   *     capacity primitive has no business choosing between) and would
   *     prevent `RegistrationService` from giving each of those a distinct,
   *     clear message.
   *   - It does NOT perform the soft duplicate-`(eventId, email)` guard
   *     (plan.md Phase 4c step 3) — a SEPARATE, deliberately-non-atomic,
   *     advisory check ("the same email may legitimately register a
   *     companion under a different name" — see `prisma/schema.prisma`'s
   *     comment explaining why `Registration` has no `@@unique([eventId,
   *     email])`). Folding an advisory check into an atomic primitive would
   *     be a category error.
   *   - It does NOT validate the registration's PERSONAL-DATA fields
   *     (POPIA — `age` 0-120, email shape, consent version, etc.). Those are
   *     `RegistrationService`'s — and ultimately the Zod schema boundary's —
   *     job; this primitive trusts its caller has already produced
   *     well-formed values (the same "the repository never sanitizes/
   *     validates, it only persists already-verified values" discipline
   *     `blog.repository.ts` documents throughout).
   *
   * ---------------------------------------------------------------------------
   * What it DOES do — and the two-layer "fail fast, then guarantee" shape
   * (plan.md Phase 4c step 4's "capacity-check ordering matters under load")
   * ---------------------------------------------------------------------------
   *   1. FAST PRE-CHECK (UX nicety, not the guarantee): if `event.capacity`
   *      is set, compares it against `repository.countRegistrations` —
   *      a cheap, friendly "this event is full" `capacityExceeded()` for the
   *      overwhelmingly common case (an event that has been full for hours/
   *      days; the count check is stale-but-essentially-always-correct by
   *      the time a new attempt arrives). This is DELIBERATELY advisory —
   *      seeing room here does NOT mean the attempt will succeed; it only
   *      means it's worth ATTEMPTING the atomic step. Skipping this check
   *      entirely would still be CORRECT (the atomic step below is the real
   *      guarantee) — it exists purely so a definitely-full event returns
   *      fast without making every concurrent late-arriver pay for an
   *      `INSERT` attempt that the database will reject anyway.
   *   2. THE ATOMIC, RACE-SAFE GUARANTEE: delegates to
   *      `repository.tryRegisterAtomically` — see that method's extensive
   *      doc-comment in `events.repository.ts` for the full "why a single
   *      `INSERT ... SELECT ... WHERE count < capacity` SQL statement, not
   *      a `Serializable` transaction + retry-on-`40001`" decision record.
   *      Translates `{ inserted: false }` into `capacityExceeded()` — the
   *      ONE place that translation happens, so `RegistrationService` never
   *      has to know the primitive's raw `{ inserted, id? }` shape; it
   *      either gets back a created registration id, or a thrown,
   *      already-correctly-coded `AppError`.
   *
   * Returns the new `Registration.id` on success; throws `capacityExceeded()`
   * (the EXACT factory `lib/errors.ts` documents as existing "for this exact
   * purpose" — see this task's brief) on failure. `RegistrationService`
   * supplies the already-validated personal-data fields; this method neither
   * inspects nor transforms them — see the interface-level "what this does
   * NOT do" list above for why that boundary is drawn here.
   */
  tryRegisterWithCapacityCheck(
    eventId: string,
    registration: {
      firstName: string;
      surname: string;
      age: number;
      email: string;
      phone: string;
      consentVersion: string;
      retainUntil: Date | null;
    },
  ): Promise<{ registrationId: string }>;

  /** Thin, named pass-through to `repository.countRegistrations` — exposed
   * on the service (not left as a repository-only primitive) so
   * `RegistrationService`/admin "export" flows can ask "how many people are
   * registered for event X?" through the SAME layering discipline every
   * other cross-module read goes through, without reaching past this
   * service into `EventRepository` directly. */
  countRegistrations(eventId: string): Promise<number>;
}

export function createEventService({ repository }: EventServiceOptions): EventService {
  /**
   * Probes `slugCandidate(1, base)`, `slugCandidate(2, base)`, ... against
   * `repository.slugExists` until an unused candidate is found — IDENTICAL
   * algorithm, bound, and "sequential by design" reasoning to
   * `generateUniqueSlug` in `blog.service.ts` (see that function's
   * doc-comment for the full "why sequential, not `Promise.all`"
   * explanation — each probe's result determines whether the next is even
   * needed).
   */
  async function generateUniqueSlug(title: string): Promise<string> {
    const base = baseSlugFor(title);

    for (let attempt = 1; attempt <= MAX_SLUG_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = slugCandidate(attempt, base);
      // Sequential by design (not parallelized) — see this function's
      // doc-comment for why each probe gates whether the next is needed
      // (mirrors `generateUniqueSlug` in `blog.service.ts` exactly).
      const exists = await repository.slugExists(candidate);
      if (!exists) {
        return candidate;
      }
    }

    throw conflict(
      `Could not generate a unique slug for "${title}" after ${MAX_SLUG_COLLISION_ATTEMPTS} attempts — ` +
        'too many existing events share this title. Try a more distinctive title.',
    );
  }

  /** Shared "load by id or 404" — identical shape and purpose to
   * `loadOrNotFound` in `blog.service.ts`. */
  async function loadOrNotFound(id: string): Promise<Event> {
    const event = await repository.findById(id);
    if (!event) {
      throw notFound('Event not found');
    }
    return event;
  }

  /** Wraps an `Event` with its current registration count — the shared
   * mechanics behind the "registration-count-awareness hook" this file's
   * header documents. Named once so `transitionStatus`/`updateEvent` apply
   * the IDENTICAL wrapping, in the IDENTICAL order (load -> count), rather
   * than each re-deriving the pairing. */
  async function withRegistrationCount(event: Event): Promise<EventWithRegistrationCount> {
    const registrationCount = await repository.countRegistrations(event.id);
    return { event, registrationCount };
  }

  return {
    async createEvent(_actor, input) {
      const slug = await generateUniqueSlug(input.title);

      return repository.create({
        title: input.title,
        slug,
        description: input.description,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        branch: input.branch,
        locationDetail: input.locationDetail,
        capacity: input.capacity ?? null,
        createdById: _actor.id,
      });
    },

    async updateEvent(_actor, id, input) {
      const existing = await loadOrNotFound(id);

      // The cross-field `endsAt > startsAt` invariant is checked here, NOT
      // (only) at the Zod-schema boundary — `updateEventSchema` validates it
      // when BOTH fields are present in a single request, but a partial
      // update might supply only `startsAt` (or only `endsAt`), and the
      // schema in isolation cannot know whether the RESULTING merged row —
      // (new `startsAt`, existing `endsAt`) or (existing `startsAt`, new
      // `endsAt`) — would still satisfy the invariant. Re-deriving the
      // would-be-final values and checking them here is the only point that
      // actually has both halves of the picture.
      const nextStartsAt = input.startsAt ?? existing.startsAt;
      const nextEndsAt = input.endsAt ?? existing.endsAt;
      if (nextEndsAt <= nextStartsAt) {
        throw conflict('endsAt must be after startsAt');
      }

      const updated = await repository.update(id, input);

      // Always return the registration-count-augmented shape — this file's
      // header names "material date change" (startsAt/endsAt) as a moment
      // the admin UI should be able to show "N people are registered for the
      // CURRENT schedule" before committing a change that could strand them.
      // Returning it unconditionally (not only when dates changed) keeps the
      // response shape uniform and predictable — the SPA never has to branch
      // on "did this particular PATCH include a date field?" to know whether
      // a `registrationCount` will be present.
      return withRegistrationCount(updated);
    },

    async transitionStatus(_actor, id, to) {
      const existing = await loadOrNotFound(id);
      const from = existing.status;

      if (!ALLOWED_TRANSITIONS[from].has(to)) {
        throw conflict(transitionRejectionMessage(from, to));
      }

      const updated = await repository.setStatus(id, to);

      // ALWAYS augmented with the registration count — see file-header
      // "REGISTRATION-COUNT-AWARENESS HOOK": this is the canonical "warn
      // before a destructive change" moment (cancel, or pull back from
      // public view), and a uniform response shape means the SPA never has
      // to special-case "was this transition the dangerous kind?"
      return withRegistrationCount(updated);
    },

    async setSlug(_actor, id, newSlug) {
      // Deliberately mirrors `BlogService.setSlug` — see this file's header
      // "SLUG POLICY" section and that method's doc-comment in
      // `blog.service.ts` for the full "why no ownership check here, and why
      // the router gates this ADMIN-ONLY" reasoning, which transfers
      // unchanged (this service has no `canManageEvent` ownership predicate
      // at all — see "EVENT-MANAGER OWNERSHIP" — so there would be nothing
      // sensible to check here even if it wanted to; the router's
      // `requireRole(authService, 'ADMIN')` IS the entire gate).
      await loadOrNotFound(id);

      if (await repository.slugExists(newSlug)) {
        throw conflict(`The slug "${newSlug}" is already in use by another event`);
      }

      return repository.setSlug(id, newSlug);
    },

    async listForAdmin(_actor, pagination, filters) {
      const { items, total } = await repository.listForAdmin(pagination, filters);
      return toPaginatedResult(items, pagination, total);
    },

    async getForAdmin(_actor, id) {
      // No ownership check — see "EVENT-MANAGER OWNERSHIP": any Event
      // Manager (or Admin) may view any event. `loadOrNotFound` alone is
      // the complete authorization story for this method.
      return loadOrNotFound(id);
    },

    async deleteEvent(_actor, id) {
      await loadOrNotFound(id);

      try {
        await repository.delete(id);
      } catch (err) {
        // Postgres rejects the DELETE with a foreign-key-violation
        // (Prisma error code `P2003`) when `Registration` rows still
        // reference this event — `Registration.event` is `onDelete:
        // Restrict` precisely so POPIA-relevant personal-data rows are
        // never silently destroyed by an event deletion (see
        // `prisma/schema.prisma`'s inline comment on that relation).
        // Translate the opaque constraint violation into the SAME
        // registration-count-aware `conflict()` shape `transitionStatus`/
        // `updateEvent` use — "cannot delete; N people are registered;
        // export/handle their data first" is actionable; a raw P2003 stack
        // trace is not.
        const isForeignKeyViolation =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: unknown }).code === 'P2003';

        if (!isForeignKeyViolation) {
          throw err;
        }

        const registrationCount = await repository.countRegistrations(id);
        throw conflict(
          `Cannot delete this event — ${registrationCount} ${
            registrationCount === 1 ? 'person is' : 'people are'
          } registered for it. Export or otherwise handle their data before deleting.`,
        );
      }
    },

    async getPublished(pagination, filters) {
      const { items, total } = await repository.listPublished(pagination, filters);
      return toPaginatedResult(items, pagination, total);
    },

    async getPublishedBySlug(slug) {
      const event = await repository.findPublishedBySlug(slug);
      if (!event) {
        // Collapsed "no such slug" / "exists but not public" outcome — see
        // this file's header "no scheduling gap" confirmation and
        // `BlogService.getPublishedBySlug`'s doc-comment for the full
        // anti-enumeration reasoning this mirrors exactly.
        throw notFound('Event not found');
      }
      return event;
    },

    async tryRegisterWithCapacityCheck(eventId, registration) {
      const event = await loadOrNotFound(eventId);

      // LAYER 1 — fast, advisory pre-check (UX nicety, NOT the guarantee;
      // see this method's interface doc-comment "two-layer" section). Only
      // meaningful for capped events — `capacity === null` means uncapped,
      // and there is nothing to pre-check.
      if (event.capacity !== null) {
        const currentCount = await repository.countRegistrations(eventId);
        if (currentCount >= event.capacity) {
          throw capacityExceeded();
        }
      }

      // LAYER 2 — THE ATOMIC, RACE-SAFE GUARANTEE. See
      // `EventRepository.tryRegisterAtomically`'s extensive doc-comment for
      // the full "why a single SQL statement, not a Serializable transaction
      // + retry" decision record. This is the ONLY check that actually
      // matters for correctness under concurrency — layer 1 above is purely
      // a fast-fail nicety that could be deleted without changing the
      // invariant's truth, only its performance characteristics under load.
      const result: AtomicRegistrationResult = await repository.tryRegisterAtomically(eventId, registration);

      if (!result.inserted || !result.id) {
        throw capacityExceeded();
      }

      return { registrationId: result.id };
    },

    async countRegistrations(eventId) {
      // Existence-check first — an admin asking "how many registrations
      // does event X have" for a nonexistent X should get a 404, not a
      // confusing "0".
      await loadOrNotFound(eventId);
      return repository.countRegistrations(eventId);
    },
  };
}
