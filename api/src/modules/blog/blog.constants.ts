/**
 * Shared, named constants for the Blog module — referenced by both
 * `blog.schemas.ts` (validation bounds) and `blog.service.ts` (so the
 * service never has to "trust" that the router validated correctly; the
 * SAME named bound is available to whichever layer needs to reason about
 * it). Centralizing these here means a future bound change is a one-line
 * edit in one file, not a hunt across schema/service for matching magic
 * numbers that may have drifted apart.
 */

/** Floor for `BlogPost.title` — guards against an effectively-empty title
 * like `"a"` slipping through `min(1)`; a post needs an actual, readable
 * headline. Generous enough not to annoy a real author. */
export const MIN_TITLE_LENGTH = 3;

/** Ceiling for `BlogPost.title` — see `createPostSchema`'s doc-comment for
 * why an explicit bound exists at all (unbounded `string()` is a storage/
 * transmission cost vector, not a feature). 200 comfortably covers any
 * realistic blog headline while remaining far short of "this is being
 * abused as a body field" territory. Also reused as the slug-length ceiling
 * in `updateSlugSchema` — a slug derived from (or replacing) a title should
 * never need to be longer than the title bound that produced it. */
export const MAX_TITLE_LENGTH = 200;

/** Floor for `BlogPost.body` — guards against a near-empty post (e.g. a
 * single character) being published; this is intentionally a LOW bar (the
 * sanitizer may strip a non-trivial amount of submitted markup down to a
 * shorter plain-text-equivalent length, and a short-but-real post — e.g. a
 * brief announcement — is legitimate). Real quality control belongs to
 * editorial review, not a character-count gate. */
export const MIN_BODY_LENGTH = 10;
