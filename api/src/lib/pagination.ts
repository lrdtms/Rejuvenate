/**
 * Shared pagination convention (plan.md Phase 4a step 5).
 *
 * Established here, in the Blog module, specifically so the Events module
 * (Phase 4b) and any future paginated list endpoint can import this verbatim
 * rather than reinventing page/limit parsing, bounds, and the response
 * envelope shape per-module — "Pagination convention established here —
 * reuse for Events" is the plan's literal instruction.
 *
 * ---------------------------------------------------------------------------
 * Shape: page/limit (offset-based), not cursor-based — and why
 * ---------------------------------------------------------------------------
 * architecture.md §8 leaves the choice open ("cursor or page/limit"). This
 * project picks page/limit:
 *   - The lists involved (published blog posts, published events, an author's
 *     own posts, an event's registrations) are small, slowly-growing,
 *     admin-curated collections on a single-VPS deployment (architecture.md
 *     §3) — not infinite-scroll social-media feeds where cursor pagination's
 *     stable-ordering-under-concurrent-writes guarantee earns its complexity.
 *   - Page/limit lets the SPA build conventional "Prev / Next / page N of M"
 *     pager UI (plan.md Phase 6 step 2 explicitly wants this for `BlogIndex`)
 *     directly from a `total`/`page`/`pageCount` response — a cursor gives you
 *     none of that "jump to page 3" affordance for free.
 *   - It is the simplest model that satisfies the requirement (YAGNI/CUPID
 *     *Predictable* — same posture architecture.md names for the RBAC matrix).
 *
 * ---------------------------------------------------------------------------
 * The DoS angle — why `limit` is capped server-side regardless of the request
 * ---------------------------------------------------------------------------
 * An unbounded `?limit=100000` is a cheap denial-of-service vector on a small,
 * single-instance Linode VPS (architecture.md §11): one client requesting a
 * huge page forces Postgres to materialize and the Node process to serialize
 * a correspondingly huge result set, for every such request. `MAX_PAGE_LIMIT`
 * is enforced INSIDE the Zod schema (`paginationQuerySchema` below) via
 * `.max()`, not merely documented as a recommendation callers should respect —
 * the validation layer is the actual boundary (architecture.md §12: "validate
 * ALL ... input server-side ... regardless of client validation"), so a
 * request for `limit=100000` is rejected with a normal `VALIDATION_ERROR`
 * (400) rather than silently clamped to 100 — clamping would be a surprising,
 * undocumented behaviour change from the caller's point of view ("I asked for
 * 100000 and got 100 with no indication why"); an explicit validation error
 * that names the bound is more honest and more debuggable.
 */
import { z } from 'zod';

/** Default page size when the caller doesn't specify `limit`. Small enough to
 * keep a single response light on a low-resource VPS, large enough that the
 * common case (browsing recent posts/events) rarely needs a second page. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Hard upper bound on `limit`, enforced by the Zod schema below — see the
 * file-header "DoS angle" note for why this is a REJECTED-if-exceeded bound,
 * not a silently-clamped one. 100 comfortably covers every legitimate admin/
 * public list view this app has (architecture.md §11's "small, low-traffic"
 * profile) while keeping worst-case response size bounded and predictable. */
export const MAX_PAGE_LIMIT = 100;

/**
 * Shared `{ page, limit }` query-string schema. Mount via
 * `validate({ query: paginationQuerySchema })` (or `.extend(...)` it to layer
 * on module-specific filters, e.g. Events' `branch`/`upcoming` — `.extend`
 * preserves these exact `page`/`limit` rules while adding fields alongside).
 *
 * `z.coerce.number()` because query-string values always arrive as strings
 * (`?page=2` -> `req.query.page === '2'`) — coercion turns `'2'` into `2`
 * before the `.int()`/`.min()`/`.max()` checks run, mirroring the
 * `z.coerce` convention `validate.ts`'s header comment points to (`env.ts`).
 *
 * `page` defaults to `1` (1-indexed — friendlier for both API consumers
 * building "page N of M" UI and for humans reading query strings/logs than a
 * 0-indexed convention would be) and `limit` to `DEFAULT_PAGE_LIMIT`.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int('page must be a whole number').min(1, 'page must be at least 1').default(1),
  limit: z.coerce
    .number()
    .int('limit must be a whole number')
    .min(1, 'limit must be at least 1')
    .max(MAX_PAGE_LIMIT, `limit must be at most ${MAX_PAGE_LIMIT}`)
    .default(DEFAULT_PAGE_LIMIT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** The response envelope every paginated list endpoint returns — `items` plus
 * enough metadata for the SPA to render a conventional pager (current page,
 * page size, total row count, and the derived total page count) without it
 * having to recompute `Math.ceil(total / limit)` itself in N call sites. */
export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  pageCount: number;
}

/** Converts a validated `{ page, limit }` into the `(skip, take)` pair Prisma's
 * `findMany` expects — the one arithmetic detail ("page 1 -> skip 0") worth
 * naming once rather than re-deriving at every repository call site. */
export function toSkipTake(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

/** Wraps a page of `items` plus the total row count into the shared
 * `PaginatedResult` envelope, deriving `pageCount` consistently (`0` total
 * rows -> `0` pages, never `1` — an empty list is zero pages of results, not
 * one empty page; this keeps "is there anything at all?" a simple
 * `pageCount === 0` check for the SPA's empty-state rendering). */
export function toPaginatedResult<T>(
  items: T[],
  query: PaginationQuery,
  total: number,
): PaginatedResult<T> {
  return {
    items,
    page: query.page,
    limit: query.limit,
    total,
    pageCount: total === 0 ? 0 : Math.ceil(total / query.limit),
  };
}
