/**
 * Shared, named constants for the CMS module — referenced by `cms.schemas.ts`
 * (validation bounds), `cms.service.ts` (batch-fetch ceiling), and tests.
 * Mirrors `blog.constants.ts`'s "centralize the magic numbers, once" posture.
 */

/**
 * Ceiling on `CMSContent.value` length accepted at the API boundary.
 *
 * `value` is `String @db.Text` in the schema (effectively unbounded at the
 * DB layer) — exactly the same "the schema *can* store anything; the service
 * boundary is where a sane ceiling belongs" reasoning `MAX_TITLE_LENGTH`
 * documents for `BlogPost.title`. CMS slots are SMALL, structured text
 * regions — short card blurbs and contact details (architecture.md §9.5:
 * "small structured text regions... no headings, tables, embeds" for rich
 * text; the plain-text slots are shorter still, e.g. a phone number/address
 * block). 10,000 characters is roughly "several paragraphs" — comfortably
 * generous for any legitimate card/contact-detail copy while still rejecting
 * a multi-megabyte payload a buggy or malicious admin client might submit
 * (which Postgres would happily store and the public batch endpoint would
 * then have to transmit on every About/Contact page view).
 */
export const MAX_SLOT_VALUE_LENGTH = 10_000;

/**
 * Ceiling on the number of `keys` accepted by the public batch-fetch endpoint
 * (`GET /cms?keys=a,b,c`). The registry itself only has SIX slots total — no
 * legitimate request (the About page needs 3, a single-card page needs 1,
 * the admin `SlotEditor` needs 1) ever approaches this bound. Set generously
 * above the registry's current size (rather than hard-coding it to exactly
 * `CMS_SLOTS.length`) so a future registry growth doesn't require touching
 * this bound too — but still a REAL, named ceiling that keeps a malformed or
 * adversarial `?keys=a,a,a,a,...` query from forcing the handler to build an
 * arbitrarily large response map. 50 comfortably covers any realistic future
 * registry size for "a small content site" (architecture.md §3) while
 * remaining a meaningful bound, not a decorative one.
 */
export const MAX_BATCH_KEYS = 50;
