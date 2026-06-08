/**
 * Shared, named constants for the Registrations module — mirrors
 * `events.constants.ts`'s "one named bound, referenced by both the schema
 * and the service, so a future change is a one-line edit, not a magic-number
 * hunt" convention (plan.md Phase 4c step 3's explicit "don't leave 'short
 * window' as an undefined magic constant in the code" instruction).
 */

/**
 * POPIA control #8 (architecture.md §7.3 invariant #7) — `age` is collected
 * as an exact integer, NOT a birthdate or age range (a deliberate, explicit
 * stakeholder decision the schema's inline comment names — do not "improve"
 * this), and validated server-side as an integer in `[MIN_AGE, MAX_AGE]`
 * regardless of any client-side check.
 *
 * `0` is the floor — an infant could legitimately be registered by a
 * parent/guardian for a family event; rejecting `0` outright would be an
 * invented restriction nobody asked for. `120` is a generous, "obviously a
 * data-entry slip beyond this" ceiling — comfortably above any verified
 * human lifespan, so it catches fat-finger errors (`920`, `1200`) without
 * ever rejecting a genuine value.
 */
export const MIN_AGE = 0;
export const MAX_AGE = 120;

/**
 * ===========================================================================
 * THE DUPLICATE-SUBMISSION SOFT-GUARD WINDOW (plan.md Phase 4c step 3/6)
 * ===========================================================================
 * The plan explicitly calls out "short window" as an undefined magic
 * constant that must be named and reasoned about, not left vague. This is
 * that name.
 *
 * THE RULE THIS CONSTANT PARAMETERIZES: reject a NEW registration whose
 * `(eventId, email, firstName, surname)` tuple EXACTLY matches an existing
 * registration's, where that existing registration's `registeredAt` is
 * within `DUPLICATE_GUARD_WINDOW_MINUTES` minutes of "now."
 *
 * WHY THIS SHAPE, SPECIFICALLY:
 *   - `email` ALONE is deliberately NOT the match key — `prisma/schema.prisma`'s
 *     comment on `Registration` (and architecture.md §7.3) is explicit that
 *     "the same email may legitimately register a companion under a
 *     different name" (e.g. a parent registering themselves AND their child
 *     under the same household email). A same-email-only guard would
 *     actively block that legitimate, common use case — precisely the
 *     reason the schema has NO `@@unique([eventId, email])`.
 *   - The FULL tuple `(eventId, email, firstName, surname)` is therefore the
 *     match key: it catches the actual failure mode this guard exists for —
 *     a double-click/page-refresh/network-retry resubmission of the EXACT
 *     SAME PERSON's details — while remaining structurally incapable of
 *     blocking a second, differently-named registrant sharing an email.
 *   - `age`/`phone` are deliberately EXCLUDED from the match key: a
 *     resubmission that corrects a typo'd phone number or age moments after
 *     the first attempt is a CORRECTION, not a duplicate, and should be
 *     allowed through (it will land as a second row; an admin reviewing the
 *     attendee list can trivially spot and reconcile two near-identical
 *     entries seconds apart — a far better failure mode than silently
 *     discarding what might be the *corrected* data).
 *
 * WHY 5 MINUTES, SPECIFICALLY:
 *   - Long enough to comfortably cover every realistic "client-side retry"
 *     scenario this guard targets: an impatient double-click, a page
 *     refresh after a slow/ambiguous response, a flaky mobile connection
 *     causing the browser to silently retry the POST. All of these resolve
 *     within seconds, not minutes — 5 minutes is roughly an order of
 *     magnitude more generous than the slowest plausible such retry.
 *   - Short enough that it can NEVER plausibly collide with a genuine,
 *     independent re-registration: nobody fills out an RSVP form, submits
 *     it, and then — minutes later, on purpose — re-submits IDENTICAL
 *     values for the SAME named person for the SAME event. If that ever
 *     happens, it is overwhelmingly more likely to be exactly the
 *     accidental-resubmission this guard targets than a deliberate "please
 *     register me twice" request (which would be a meaningless action
 *     anyway — one attendee, one seat).
 *   - This is a SOFT, advisory, UX-quality guard — not a security boundary
 *     and not a data-integrity constraint (the DB has, deliberately, no
 *     unique index backing it; see `prisma/schema.prisma`'s comment on
 *     `Registration` and this module's `registrations.repository.ts`). Its
 *     entire job is "don't let an accidental double-click create two rows
 *     for the same person seconds apart" — 5 minutes comfortably achieves
 *     that without ever being able to block a legitimate resubmission, so
 *     there is no meaningful "too short / too long" tradeoff to over-tune
 *     here (YAGNI: pick a reasonable, documented value; revisit only if
 *     real-world evidence ever suggests otherwise).
 */
export const DUPLICATE_GUARD_WINDOW_MINUTES = 5;

/**
 * ===========================================================================
 * THE PROVISIONAL `consentVersion` PLACEHOLDER (plan.md Phase 4c step 1/3)
 * ===========================================================================
 * POPIA requires CAPTURING a versioned consent — but the actual notice
 * WORDING (and therefore its real version identifier) is an unresolved
 * stakeholder/legal decision (architecture.md §12 / plan.md's "go-live
 * blocker" framing). The plan is explicit that this does NOT block building
 * the *submission* flow: "even a placeholder draft can be wired now and
 * swapped when the organization confirms wording."
 *
 * THIS STRING IS A PLACEHOLDER — clearly marked as such in its own value so
 * it is self-documenting wherever it appears (database rows, exports, logs):
 * a future reader who encounters `"consent-notice-DRAFT-v0-PENDING-LEGAL-SIGNOFF"`
 * in a CSV export or a database row immediately understands "this is
 * provisional," without needing to cross-reference this file.
 *
 * WHEN THE REAL NOTICE LANDS (Phase 9): replace this constant's value with
 * the real, stakeholder-approved version identifier (e.g.
 * `"popia-consent-v1-2026-XX-XX"`), and bump it again every time the notice
 * wording materially changes — this is the ONE place that value is defined,
 * by design (the same "one named constant, one place to change it" posture
 * `events.constants.ts`'s `MAX_CAPACITY` documents). No re-architecture is
 * needed: every registration already stores whatever string this constant
 * holds at submission time, so existing rows correctly retain the consent
 * version THEY were captured under, and new rows pick up the new value
 * automatically the moment this one line changes.
 */
export const CONSENT_VERSION_PLACEHOLDER = 'consent-notice-DRAFT-v0-PENDING-LEGAL-SIGNOFF';

/**
 * ===========================================================================
 * THE PROVISIONAL `retainUntil` VALUE — `null` (plan.md Phase 4c step 1/3)
 * ===========================================================================
 * `retainUntil` is `DateTime?` (nullable) specifically because "the
 * *retention period* is a pending stakeholder decision (go-live blocker) —
 * the mechanism (this column + a future purge job) is wired up regardless"
 * (`prisma/schema.prisma`'s own comment on this column).
 *
 * DECISION: persist `null`, not a guessed conservative default. Reasoning:
 *   - The plan flags TWO open sub-questions that must BOTH be answered
 *     before any real value can be computed correctly: (a) what the
 *     retention PERIOD is (e.g. "2 years"), and (b) what it's measured
 *     FROM — `now()` (registration date) or `event.startsAt` (event date).
 *     These genuinely differ for an event booked far in advance (a
 *     registration captured 8 months before the event would retain for
 *     very different absolute dates depending on which anchor is chosen).
 *     A guessed default risks encoding a WRONG anchor choice into real
 *     production data — which would then need a backfill migration to
 *     correct once the real policy lands, a strictly worse outcome than
 *     `null` ("not yet computed — purge job, when built in Phase 9, must
 *     either skip `null` rows or trigger a one-time backfill once the
 *     policy is confirmed").
 *   - `null` is unambiguous and self-documenting in the data itself: a
 *     future maintainer querying `WHERE retainUntil IS NULL` immediately
 *     sees "these rows predate the retention-policy decision," with zero
 *     risk of confusing a real computed date with a guessed placeholder
 *     date that happens to look plausible.
 *   - This is the literal "use a placeholder/null until the period is
 *     confirmed" option the plan names FIRST (plan.md Phase 4c step 1) —
 *     not a deviation from guidance, a direct application of it.
 *
 * Exported as a function (not a bare constant) purely so every call site —
 * and any future test — reads `retainUntilPlaceholder()` rather than a bare
 * `null` that could be mistaken for an oversight; the indirection costs
 * nothing and gives the "this IS the documented placeholder, not a missed
 * assignment" signal a literal `null` cannot carry on its own.
 */
export function retainUntilPlaceholder(): Date | null {
  return null;
}
