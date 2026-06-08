/**
 * Zod request-validation schemas for the Blog module's routes (plan.md
 * Phase 4a), consumed via `validate({ body/params/query: ... })` — see
 * `middleware/validate.ts`'s file-header doc-comment for the project-wide
 * "schemas are duplicated per module, mirrored by hand in the SPA"
 * convention. The SPA's mirrored copy lives at
 * `web/src/shared/schemas/blog.schema.ts` (per that convention).
 *
 * Pagination (`listPostsQuerySchema`) is built on the SHARED
 * `paginationQuerySchema` from `lib/pagination.ts` — see that file's header
 * for the page/limit convention this and the Events module both reuse.
 */
import { z } from 'zod';

import { paginationQuerySchema } from '../../lib/pagination';
import { MAX_TITLE_LENGTH, MIN_BODY_LENGTH, MIN_TITLE_LENGTH } from './blog.constants';

/** `GET /blog/posts` and `GET /admin/blog/posts` query — page/limit only for
 * now (no filters are specified for Blog in architecture.md §8; Events adds
 * `branch`/`upcoming` on top of the same shared base via `.extend()`). */
export const listPostsQuerySchema = paginationQuerySchema;
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

/** `GET /blog/posts/:slug` and admin single-post-by-id-adjacent slug routes —
 * a non-empty string is sufficient; the repository's `findUnique` on a
 * non-existent slug naturally yields "not found" without needing a stricter
 * shape check here (a slug is an opaque, URL-safe identifier — see `slug.ts`
 * for how it's derived; validating its exact character set here would only
 * reject "not found" requests slightly earlier, for no real benefit). */
export const slugParamSchema = z.object({
  slug: z.string().trim().min(1, 'slug is required'),
});
export type SlugParam = z.infer<typeof slugParamSchema>;

/** `:id` route param shared by every admin single-post route
 * (`PATCH`/`DELETE`/`publish`/`unpublish`). A UUID — `BlogPost.id` is
 * `@default(uuid())` in the schema (see `prisma/schema.prisma`). */
export const postIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});
export type PostIdParam = z.infer<typeof postIdParamSchema>;

/**
 * `POST /admin/blog/posts` body — creates a new post (always `DRAFT`; see
 * `blog.service.ts`'s `createPost` doc-comment for why publish is a
 * dedicated, separate transition rather than a creation-time flag).
 *
 * `title`/`body` bounds exist for the same reason `auth.schemas.ts` bounds
 * `newPassword` — documented, reviewed limits beat unbounded `string()`
 * (which would let a malicious or buggy client submit a multi-megabyte
 * `title` that Postgres would happily store and every list query would then
 * have to transmit). `MIN_BODY_LENGTH`/`MIN_TITLE_LENGTH`/`MAX_TITLE_LENGTH`
 * live in `blog.constants.ts` so the service layer can reference the SAME
 * bounds without re-deriving them (e.g. a future "draft auto-save" feature
 * that needs to know the minimum viable post shape).
 */
export const createPostSchema = z.object({
  title: z
    .string()
    .trim()
    .min(MIN_TITLE_LENGTH, `title must be at least ${MIN_TITLE_LENGTH} characters long`)
    .max(MAX_TITLE_LENGTH, `title must be at most ${MAX_TITLE_LENGTH} characters long`),
  body: z
    .string()
    .trim()
    .min(MIN_BODY_LENGTH, `body must be at least ${MIN_BODY_LENGTH} characters long`),
});
export type CreatePostInput = z.infer<typeof createPostSchema>;

/**
 * `PATCH /admin/blog/posts/:id` body — partial update of `title`/`body`
 * only. Deliberately does NOT accept `slug` or `status` here:
 *   - `slug`: see `blog.service.ts`'s extensive "slug stability" doc-comment
 *     — changing a post's slug is a narrowly-scoped, Admin-only operation
 *     with its own dedicated route/schema (`updateSlugSchema` below), never
 *     a side effect of a generic title edit.
 *   - `status`: status transitions go through the dedicated `publish`/
 *     `unpublish` actions (which also stamp/preserve `publishedAt` and
 *     generate the slug on first publish) — folding `status` into a generic
 *     `PATCH` would let a client flip `DRAFT`->`PUBLISHED` without the
 *     slug-generation/stability machinery running, silently breaking the
 *     "slug is generated once, on first publish" invariant.
 *
 * `.partial()` + `.refine(...)`: at least one of `title`/`body` must be
 * present — an empty `{}` body is a no-op the client almost certainly didn't
 * intend, and rejecting it early (400) is more honest than silently
 * succeeding with zero changes.
 */
export const updatePostSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(MIN_TITLE_LENGTH, `title must be at least ${MIN_TITLE_LENGTH} characters long`)
      .max(MAX_TITLE_LENGTH, `title must be at most ${MAX_TITLE_LENGTH} characters long`),
    body: z
      .string()
      .trim()
      .min(MIN_BODY_LENGTH, `body must be at least ${MIN_BODY_LENGTH} characters long`),
  })
  .partial()
  .refine((value) => value.title !== undefined || value.body !== undefined, {
    message: 'Provide at least one of: title, body',
    path: ['_root'],
  });
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

/**
 * `PATCH /admin/blog/posts/:id/slug` body — the dedicated, Admin-only,
 * narrowly-scoped manual-slug-edit path (plan.md Phase 4a step 2's "allow
 * explicit manual slug edits by Admin only"). Deliberately a SEPARATE route
 * + schema from `updatePostSchema`, not a field folded into it — see
 * `blog.service.ts`'s `setSlug` doc-comment for the full "why a dedicated
 * path" rationale (in short: a generic update accepting an optional `slug`
 * field makes "did this PATCH silently change the slug?" an easy-to-miss
 * question for both reviewers and the admin UI; a dedicated route makes the
 * intent explicit at the call site and lets the router gate it with
 * `requireRole(authService, 'ADMIN')` alone, independent of the
 * `BLOGGER`-inclusive gate on the rest of `/admin/blog/*`).
 *
 * Validated as a bare slug-shaped string (lower-case alphanumeric + hyphens,
 * no leading/trailing/doubled hyphens) — `slugify()` produces exactly this
 * shape, and rejecting anything else here means the service never has to
 * decide "should I slugify the admin's manual input, or trust it verbatim?"
 * (a confusing question with no good answer — trusting it verbatim risks
 * storing an unsafe-for-URLs string; silently re-slugifying it risks
 * surprising the admin who typed something specific). One clear contract:
 * type a valid slug, or get a field-level validation error explaining the
 * shape.
 */
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const updateSlugSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'slug is required')
    .max(MAX_TITLE_LENGTH, `slug must be at most ${MAX_TITLE_LENGTH} characters long`)
    .regex(
      SLUG_SHAPE,
      'slug must contain only lower-case letters, numbers, and single hyphens between segments',
    ),
});
export type UpdateSlugInput = z.infer<typeof updateSlugSchema>;
