/**
 * `BlogPost` repository (plan.md Phase 4a step 1) — the persistence layer in
 * this module's router -> service -> repository chain (architecture.md §6
 * "Clean layering"). Owns ALL direct Prisma access for `BlogPost`; the
 * service composes these primitives and applies domain rules on top (slug
 * generation, sanitization, ownership, status transitions) — no business
 * logic lives here, only typed, named queries.
 *
 * Constructed via a factory (`createBlogRepository({ db })`), mirroring
 * `createAuthService`'s dependency-injection convention — lets tests
 * substitute a fake/in-memory `db` (or, as this module's tests do, run
 * against the real local Postgres with throwaway fixtures, matching
 * `auth.service.test.ts`'s established "no DB-mocking infrastructure exists;
 * standing one up purely for these assertions would be more machinery than
 * it's worth" posture).
 */
import type { BlogPost, BlogStatus, PrismaClient, Prisma } from '@prisma/client';

import { toSkipTake, type PaginationQuery } from '../../lib/pagination';

export interface BlogRepositoryOptions {
  db: PrismaClient;
}

/** The minimal author projection the public list/detail endpoints expose
 * alongside a post — never the full `User` row (no `passwordHash`/`email`/
 * `isActive` leakage to anonymous visitors; this is the same "select only
 * what the consumer needs" discipline `OwnedPost` documents in
 * `ownership.ts`). */
const PUBLIC_AUTHOR_SELECT = {
  select: { id: true, name: true },
} satisfies { select: Prisma.UserSelect };

export type BlogPostWithPublicAuthor = BlogPost & {
  author: { id: string; name: string };
};

/** Ordering for every public-facing list: most-recently-published first —
 * matches the `@@index([status, publishedAt])` defined on `BlogPost`
 * specifically to serve this query shape efficiently (see
 * `prisma/schema.prisma`'s inline comment on that index). */
const PUBLISHED_ORDER_BY = { publishedAt: 'desc' } as const;

export interface BlogRepository {
  /**
   * Public list: posts that are `PUBLISHED` AND whose `publishedAt` has
   * already passed (architecture.md §7.3 invariant #3 — enforced HERE, in
   * the query, not as an application-layer filter after the fact, so the
   * pagination `total` count and the returned page agree with each other
   * and with what the DB actually holds).
   */
  listPublished(
    pagination: PaginationQuery,
  ): Promise<{ items: BlogPostWithPublicAuthor[]; total: number }>;

  /**
   * Public detail: a single post by `slug`, but ONLY if it is currently
   * publicly visible (`PUBLISHED` AND `publishedAt <= now()`). Returns
   * `null` for "no such slug" AND for "exists but not yet/no longer public"
   * — collapsed into one outcome so the router can 404 either case
   * identically (architecture.md §7.3 invariant #3 / plan.md Phase 4a step 3
   * — "a scheduled-but-not-yet-live post must 404 even if its slug is
   * guessed/shared directly"; a 403 or any other distinguishing response
   * would itself leak "this slug exists, just not for you yet").
   */
  findPublishedBySlug(slug: string): Promise<BlogPostWithPublicAuthor | null>;

  /**
   * Admin "my posts" / "all posts" list — optionally scoped to a single
   * `authorId` (Bloggers see their own only; Admins see everyone's — see
   * `blog.service.ts`'s `listForUser` for where that branch is decided).
   * Scoping happens IN THE QUERY (a `where: { authorId }` clause), not by
   * fetching everyone's posts and filtering in memory — plan.md Phase 4a
   * step 4 calls this out explicitly as the correct shape ("For the list
   * endpoint, scope the *query*").
   */
  listByAuthor(
    authorId: string | undefined,
    pagination: PaginationQuery,
  ): Promise<{ items: BlogPostWithPublicAuthor[]; total: number }>;

  /** Admin lookup by id — returns the full row (including `authorId`, needed
   * for `canEditPost`) or `null`. No visibility filter — admin routes show
   * drafts, scheduled, and published posts alike (subject to the
   * ownership check the service performs on top). */
  findById(id: string): Promise<BlogPost | null>;

  /** Existence check used by `BlogService.generateUniqueSlug`'s collision
   * loop — a `findFirst` with a `select` projection rather than `findUnique`
   * returning the full row, since the caller only needs a yes/no answer.
   * Returns `true` iff a row with this exact `slug` exists. */
  slugExists(slug: string): Promise<boolean>;

  /** Persists a brand-new post, always as `DRAFT`, with the SERVICE-computed
   * `slug` (generated from the title at creation time — see
   * `blog.service.ts`'s extensive slug-stability doc-comment for why
   * creation, not first-publish, is the generation point THIS schema
   * requires, and why that's still the right "stable forever after" policy
   * the plan calls for). The repository never derives the slug itself — it
   * persists whatever unique value the service has already computed and
   * verified. */
  create(input: {
    title: string;
    slug: string;
    sanitizedBody: string;
    authorId: string;
  }): Promise<BlogPost>;

  /** Applies a partial `title`/`body` update. Takes the ALREADY-SANITIZED
   * body (the repository never sanitizes — that's a service concern, see
   * `lib/sanitizeHtml.ts`'s "sanitize before persisting" ordering note) and
   * does not touch `slug`/`status`/`publishedAt` — those have their own
   * dedicated repository methods below, matching the schema-level decision
   * to keep generic updates and status/slug transitions on separate paths. */
  update(id: string, input: { title?: string; sanitizedBody?: string }): Promise<BlogPost>;

  /**
   * Transitions a post to `PUBLISHED`, stamping `publishedAt` (the service
   * always passes "now" for a manual publish — no scheduled-publish UI
   * exists yet, but the repository accepts an explicit `Date` so that
   * feature, if ever built, is a service-layer change, not a schema/
   * repository one). Deliberately does NOT touch `slug` — the slug is
   * generated once, at CREATION time (see `create` above and
   * `blog.service.ts`'s slug-stability doc-comment), and publish never
   * regenerates or reassigns it. Kept as a separate repository method from
   * `update`/`unpublish` because "transition to published + stamp the
   * timestamp" is its own atomic, named operation worth its own intention-
   * revealing call site.
   */
  publish(id: string, input: { publishedAt: Date }): Promise<BlogPost>;

  /** Transitions a post back to `DRAFT`. Deliberately does NOT clear
   * `publishedAt` or `slug` — see `blog.service.ts`'s `unpublish` doc-comment
   * for why both are preserved (re-publish history + slug stability). */
  unpublish(id: string): Promise<BlogPost>;

  /** Sets `slug` directly — the persistence half of the dedicated,
   * Admin-only manual-slug-edit path (`BlogService.setSlug` /
   * `updateSlugSchema`). Takes a pre-validated, pre-uniqueness-checked
   * value; the service owns both checks. */
  setSlug(id: string, slug: string): Promise<BlogPost>;

  /** Hard-deletes a post row. `BlogPost` has no soft-delete flag in the
   * schema (unlike `User.isActive`) — deletion is a real, destructive
   * operation here, gated by `canEditPost` in the service before this is
   * ever called. (Associated `MediaAsset` cleanup is the Media module's
   * documented responsibility per plan.md Phase 4e step 2 — "must be handled
   * explicitly in `BlogService.deletePost`" — flagged here so whoever wires
   * Media in finds this exact comment rather than rediscovering the gap.) */
  delete(id: string): Promise<void>;
}

export function createBlogRepository({ db }: BlogRepositoryOptions): BlogRepository {
  /** Shared "is this row publicly visible right now?" predicate, expressed
   * as a Prisma `where` fragment — used by both `listPublished` and
   * `findPublishedBySlug` so the two endpoints can never disagree about
   * what "public" means (the exact bug plan.md Phase 4a step 3 warns is
   * "easy to satisfy on the list endpoint but forget on the detail
   * endpoint" — encoding it ONCE, here, makes forgetting it on either
   * endpoint structurally impossible rather than merely "remembered"). */
  const publicVisibilityWhere = (): Prisma.BlogPostWhereInput => ({
    status: 'PUBLISHED' as BlogStatus,
    publishedAt: { lte: new Date() },
  });

  return {
    async listPublished(pagination) {
      const where = publicVisibilityWhere();
      const { skip, take } = toSkipTake(pagination);

      const [items, total] = await db.$transaction([
        db.blogPost.findMany({
          where,
          orderBy: PUBLISHED_ORDER_BY,
          skip,
          take,
          include: { author: PUBLIC_AUTHOR_SELECT },
        }),
        db.blogPost.count({ where }),
      ]);

      return { items, total };
    },

    async findPublishedBySlug(slug) {
      return db.blogPost.findFirst({
        where: { slug, ...publicVisibilityWhere() },
        include: { author: PUBLIC_AUTHOR_SELECT },
      });
    },

    async listByAuthor(authorId, pagination) {
      const where: Prisma.BlogPostWhereInput = authorId ? { authorId } : {};
      const { skip, take } = toSkipTake(pagination);

      const [items, total] = await db.$transaction([
        db.blogPost.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          include: { author: PUBLIC_AUTHOR_SELECT },
        }),
        db.blogPost.count({ where }),
      ]);

      return { items, total };
    },

    async findById(id) {
      return db.blogPost.findUnique({ where: { id } });
    },

    async slugExists(slug) {
      const match = await db.blogPost.findFirst({ where: { slug }, select: { id: true } });
      return match !== null;
    },

    async create({ title, slug, sanitizedBody, authorId }) {
      return db.blogPost.create({
        data: {
          title,
          slug,
          body: sanitizedBody,
          authorId,
          status: 'DRAFT',
          publishedAt: null,
        },
      });
    },

    async update(id, { title, sanitizedBody }) {
      return db.blogPost.update({
        where: { id },
        data: {
          ...(title !== undefined ? { title } : {}),
          ...(sanitizedBody !== undefined ? { body: sanitizedBody } : {}),
        },
      });
    },

    async publish(id, { publishedAt }) {
      return db.blogPost.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt,
        },
      });
    },

    async unpublish(id) {
      return db.blogPost.update({
        where: { id },
        data: { status: 'DRAFT' },
      });
    },

    async setSlug(id, slug) {
      return db.blogPost.update({ where: { id }, data: { slug } });
    },

    async delete(id) {
      await db.blogPost.delete({ where: { id } });
    },
  };
}
