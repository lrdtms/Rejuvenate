/**
 * Slug derivation helper for the Blog module (plan.md Phase 4a step 2).
 *
 * Pure string transformation — no DB access, no collision handling (that
 * needs a uniqueness check against persisted rows, which is `BlogService`'s
 * job; see `blog.service.ts`'s `generateUniqueSlug`). Kept tiny and isolated
 * so it's trivially unit-testable and reusable if Events (Phase 4b, which
 * also has a unique `slug` column per the ER diagram) wants the identical
 * "title -> URL-safe identifier" transformation — import `slugify` from here
 * rather than re-deriving the same regex pipeline.
 */

/**
 * Converts a human-authored title into a URL-safe slug fragment:
 *   - Unicode-normalizes and strips diacritics (`é` -> `e`) so accented
 *     titles still produce plain-ASCII URLs (broad compatibility, avoids
 *     percent-encoding noise in shared links).
 *   - Lower-cases.
 *   - Replaces any run of non-alphanumeric characters with a single hyphen.
 *   - Trims leading/trailing hyphens left over from punctuation at the
 *     edges of the title (e.g. `"Hello, World!"` -> `"hello-world"`, not
 *     `"hello-world-"`).
 *
 * Deliberately does NOT truncate to a maximum length — `BlogPost.title` has
 * no documented length ceiling in the schema, and an overly-clever length
 * cap here risks truncating mid-word and producing an ugly, hard-to-read
 * URL for the (rare) long title. If this ever becomes a real problem, it's a
 * one-line addition in exactly this function — not a reason to add
 * speculative complexity now (YAGNI).
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds the Nth collision-resolution candidate for a base slug:
 * `attempt(1, 'my-post') === 'my-post'`,
 * `attempt(2, 'my-post') === 'my-post-2'`, etc. — matches the plan's
 * documented collision policy ("append `-2`, `-3`, ...").
 *
 * Exported separately from `generateUniqueSlug` (which needs DB access to
 * check each candidate) purely so the candidate-naming SCHEME itself is
 * unit-testable without a database.
 */
export function slugCandidate(attempt: number, baseSlug: string): string {
  return attempt <= 1 ? baseSlug : `${baseSlug}-${attempt}`;
}
