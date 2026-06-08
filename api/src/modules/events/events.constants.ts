/**
 * Shared, named constants for the Events module — mirrors
 * `blog.constants.ts`'s "one named bound, referenced by both the schema and
 * the service, so a future change is a one-line edit, not a magic-number
 * hunt" convention (plan.md Phase 4b / 4a step 5's "reuse Blog's
 * conventions").
 */

/** Floor for `Event.title` — same rationale as `blog.constants.ts`'s
 * `MIN_TITLE_LENGTH`: guards against an effectively-empty title like `"a"`
 * slipping through `min(1)`. An event needs an actual, readable name. */
export const MIN_TITLE_LENGTH = 3;

/** Ceiling for `Event.title` — see `blog.constants.ts`'s `MAX_TITLE_LENGTH`
 * doc-comment for why an explicit bound exists at all. 200 comfortably covers
 * any realistic event name while bounding storage/transmission cost. Also
 * reused as the slug-length ceiling, mirroring Blog's "slug derived from
 * title should never need to be longer than the title bound" reasoning. */
export const MAX_TITLE_LENGTH = 200;

/** Floor for `Event.description` — same "guard against a near-empty value,
 * leave real quality control to editorial review" posture as
 * `MIN_BODY_LENGTH` in the Blog module. Intentionally low. */
export const MIN_DESCRIPTION_LENGTH = 10;

/** Floor/ceiling for `Event.locationDetail` — a short human-readable venue
 * description (e.g. "Fellowship Hall, 12 Main Road, Cape Town"). Bounded for
 * the same storage/transmission-cost reasons named throughout this file;
 * generous enough for a full street address plus a room/venue name. */
export const MIN_LOCATION_DETAIL_LENGTH = 3;
export const MAX_LOCATION_DETAIL_LENGTH = 300;

/** Sane bound on `Event.capacity` — architecture.md doesn't name an explicit
 * ceiling, but an unbounded `Int` would let a typo (`capacity: 99999999`)
 * slip through unnoticed and would make the capacity-check primitive's
 * "count current registrations" query pointlessly expensive to reason about.
 * 100,000 is comfortably larger than any realistic single-event attendance
 * for a small church/community org (architecture.md §3's "small org"
 * profile) while still catching obvious data-entry mistakes. */
export const MAX_CAPACITY = 100_000;
