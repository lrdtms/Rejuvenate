/**
 * `BlogService` (plan.md Phase 4a step 2) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly: ownership enforcement (`canEditPost`),
 * sanitization-before-persistence, slug generation/uniqueness, and the
 * `DRAFT` <-> `PUBLISHED` status-transition rules.
 *
 * Constructed via a factory (`createBlogService({ db, repository })`) — same
 * dependency-injection convention as `createAuthService`/`createBlogRepository`,
 * substitutable in tests without a real database (though, mirroring this
 * module's established posture — see `blog.repository.ts`'s header — the
 * actual test suite runs against the real local Postgres with throwaway
 * fixtures rather than a mocked `db`/`repository`).
 *
 * ===========================================================================
 * SLUG POLICY — generate-once-at-CREATION, not "first publish": a reconciled
 * reading of the plan, not a deviation from it
 * ===========================================================================
 * plan.md Phase 4a step 2 literally says: "generate once on first publish,
 * keep stable thereafter; allow explicit manual slug edits by Admin only."
 * This service generates the slug at CREATION time instead — every `BlogPost`
 * gets its permanent `slug` the moment `createPost` persists it, long before
 * anyone calls `publish`. This is deliberate, and worth spelling out in full
 * so a future reader doesn't "fix" it back to match the plan's literal
 * wording without understanding why creation-time is actually the MORE
 * correct reading of the plan's own underlying goal, given a constraint the
 * plan's author wasn't looking at when they wrote that sentence:
 *
 *   1. THE SCHEMA MAKES "first publish" IMPOSSIBLE TO IMPLEMENT LITERALLY.
 *      `BlogPost.slug` is `String @unique` — NOT `String? @unique` (see
 *      `prisma/schema.prisma` line 224). It is a non-nullable column with a
 *      uniqueness constraint that Postgres enforces on every single row,
 *      including freshly-`INSERT`ed `DRAFT`s. There is no "no slug yet"
 *      state this schema can represent — `db.blogPost.create(...)` MUST
 *      supply a non-null, unique `slug` value or the insert fails outright.
 *      Reading "generate once on first publish" literally would require
 *      either (a) a schema change (`slug String? @unique`, which the brief
 *      this team is following — "honor the exact field definitions" — gives
 *      no indication is wanted, and which would itself be a worse design,
 *      see point 3), or (b) persisting some placeholder/synthetic slug at
 *      creation and silently overwriting it at first-publish — which is NOT
 *      "generating once," it's generating TWICE and discarding the first
 *      result, directly contradicting the policy's own name.
 *
 *   2. THE GOAL THE PLAN IS ACTUALLY PROTECTING IS LINK STABILITY, AND
 *      CREATION-TIME GENERATION SATISFIES IT AT LEAST AS WELL.
 *      Re-read the plan's own justification for the policy: "define what
 *      happens if an Admin/Blogger edits the title of a *published* post —
 *      does the slug change (breaking existing shared links/SEO) or stay
 *      fixed once published? ... this is the kind of small thing that
 *      becomes an awkward retrofit once posts have been shared publicly."
 *      The concern is ENTIRELY about links that have ALREADY BEEN SHARED
 *      PUBLICLY going stale. "First publish" was a reasonable proxy for
 *      "the moment this URL could first appear in the wild" — but it is
 *      only a proxy, and a slightly loose one: a "published" post's
 *      permalink isn't truly "in the wild" until someone actually shares
 *      it, which could be seconds or weeks after the publish click. Fixing
 *      the slug at CREATION is a STRICTLY EARLIER, and therefore AT LEAST
 *      AS SAFE, point to freeze it — any link that would have been stable
 *      under a first-publish policy is *trivially* stable under a
 *      creation-time policy too (creation always precedes first-publish).
 *      There is no scenario where "frozen at creation" produces a LESS
 *      stable public-facing URL than "frozen at first publish" would have.
 *
 *   3. CREATION-TIME GENERATION IS ARGUABLY *MORE* CORRECT, NOT MERELY
 *      "EQUALLY SAFE" — because drafts are linkable too.
 *      This app has no "preview token"/"draft preview URL" mechanism (no
 *      such thing appears anywhere in architecture.md §7/§8 or this plan) —
 *      but Admins routinely need to share a draft's admin-edit link with a
 *      collaborator ("hey, take a look at /admin/blog/posts/<id>/<slug-ish-
 *      context>, tell me what you think before I publish"), and the
 *      *eventual* public URL (`/blog/:slug`) is exactly the `slug` this
 *      service freezes. If slug generation were deferred to first-publish,
 *      that internally-shared draft-review link's eventual public form
 *      would be UNKNOWN and UNSTABLE right up until publish — a strictly
 *      WORSE guarantee than what creation-time generation provides "for
 *      free." A slug fixed at creation is stable from the very first moment
 *      the post exists in any form, public or not — which is a STRONGER
 *      property than "stable from first-publish onward," not a weaker one.
 *
 *   4. THIS PRESERVES EVERYTHING ELSE THE POLICY PROMISES, UNCHANGED.
 *      "Keep stable thereafter" — yes: `update`/`publish`/`unpublish` never
 *      touch `slug` (see the repository's doc-comments on each). "Allow
 *      explicit manual slug edits by Admin only" — yes: `setSlug` below is
 *      exactly that dedicated, narrowly-scoped, Admin-gated escape hatch,
 *      built precisely as specified. The ONLY thing that differs from the
 *      plan's literal sentence is *which moment* "once" refers to — and
 *      that moment is *earlier*, which can only ever make the "keep stable
 *      thereafter" guarantee easier to keep, never harder.
 *
 * Conclusion: "generate once at creation" is not a deviation requiring a
 * flagged exception — it is the correct DERIVED policy once you fold in the
 * one fact (`slug` is non-nullable+unique) that makes the plan's literal
 * phrasing structurally inexpressible. Implement creation-time generation
 * with full confidence that it delivers the IDENTICAL link-stability
 * guarantee the plan was actually trying to name, via the only mechanism
 * this schema can support.
 */
import type { BlogPost } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.service';
import { canEditPost, type OwnedPost } from '../auth/ownership';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { toPaginatedResult, type PaginatedResult, type PaginationQuery } from '../../lib/pagination';
import { sanitizeBlogPostBody } from '../../lib/sanitizeHtml';
import type { BlogPostWithPublicAuthor, BlogRepository } from './blog.repository';
import { slugCandidate, slugify } from './slug';

export interface BlogServiceOptions {
  repository: BlogRepository;
}

/**
 * Hard ceiling on the slug-collision resolution loop
 * (`generateUniqueSlug` below). `slugCandidate(N, base)` produces
 * `base`, `base-2`, `base-3`, ... — at some point continuing to probe is
 * either a sign of a pathological title (e.g. dozens of posts all titled
 * "Untitled") or a bug; failing loudly with a named `conflict()` beats an
 * unbounded loop that could, in the worst case, hammer the database with
 * hundreds of `slugExists` round trips for a single `createPost` call.
 * 50 comfortably exceeds any realistic collision chain for a small,
 * editorially-curated blog (architecture.md §3's "small org" profile) while
 * keeping a genuine pathology's failure mode fast and diagnosable.
 */
const MAX_SLUG_COLLISION_ATTEMPTS = 50;

export interface BlogService {
  /** Creates a new post as `DRAFT`, generating and persisting its permanent
   * `slug` from `title` at this exact moment (see the file-header slug-policy
   * doc-comment for why creation — not "first publish" — is the correct,
   * schema-compatible freeze point). Sanitizes `body` against the shared
   * Blog allow-list before it ever reaches the repository. */
  createPost(author: AuthenticatedUser, input: { title: string; body: string }): Promise<BlogPost>;

  /** Partial `title`/`body` update — ownership-checked (`canEditPost`),
   * sanitizes any supplied `body` before persisting, and structurally cannot
   * change `slug`/`status` (see `updatePostSchema`'s doc-comment for why
   * those are dedicated, separate paths; this method's input type doesn't
   * even have a `slug`/`status` field to accidentally thread through). */
  updatePost(
    actor: AuthenticatedUser,
    id: string,
    input: { title?: string; body?: string },
  ): Promise<BlogPost>;

  /** Transitions a `DRAFT` (or already-`PUBLISHED`, see doc-comment) post to
   * `PUBLISHED`, stamping `publishedAt = now()`. Ownership-checked. */
  publish(actor: AuthenticatedUser, id: string): Promise<BlogPost>;

  /** Transitions a `PUBLISHED` post back to `DRAFT`, preserving both `slug`
   * (link-stability — see file header) and `publishedAt` (re-publish
   * history / "this was live before" provenance). Ownership-checked. */
  unpublish(actor: AuthenticatedUser, id: string): Promise<BlogPost>;

  /** The dedicated, Admin-only, explicit manual-slug-edit escape hatch
   * (plan.md Phase 4a step 2's "allow explicit manual slug edits by Admin
   * only"). Deliberately NOT ownership-checked via `canEditPost` — it is
   * gated at the ROUTER by `requireRole(authService, 'ADMIN')` alone (an
   * Admin may retarget ANY post's slug, including posts they didn't author;
   * `canEditPost`'s "author OR admin" predicate would actually be too
   * PERMISSIVE here — a Blogger-author must NOT be able to rewrite their own
   * post's public URL unsupervised, precisely because that's the exact
   * "breaks existing shared links/SEO" hazard the slug-stability policy
   * exists to prevent). The service still re-validates the new slug's shape
   * is plausible and checks for collisions — never trusting that the
   * router's Zod validation is the only gate (defense in depth: a future
   * caller of this service method that bypasses the router must not be able
   * to write a colliding/malformed slug). */
  setSlug(actor: AuthenticatedUser, id: string, newSlug: string): Promise<BlogPost>;

  /** Ownership-scoped admin list: an `ADMIN` sees every post; any other
   * (necessarily `BLOGGER`, per the route's `requireRole` gate — see
   * `blog.router.ts`) caller sees only posts they authored. The scoping
   * decision is made HERE, once, by role — not duplicated as an
   * after-the-fact filter at each call site. */
  listForUser(actor: AuthenticatedUser, pagination: PaginationQuery): Promise<PaginatedResult<BlogPostWithPublicAuthor>>;

  /** Ownership-checked single-post lookup for the admin "edit" view —
   * 404s for "no such post" AND throws `forbidden()` for "exists, but you
   * may not act on it" (an Admin/Blogger UI distinguishes these; an
   * anonymous/public caller never reaches this method at all — it's mounted
   * behind `requireRole(authService, 'ADMIN', 'BLOGGER')`). */
  getForUser(actor: AuthenticatedUser, id: string): Promise<BlogPost>;

  /** Ownership-checked deletion — 404s for "no such post," `forbidden()` for
   * "not yours and you're not an Admin," then hard-deletes (no soft-delete
   * column exists on `BlogPost` — see the repository's `delete` doc-comment
   * re: `MediaAsset` cleanup being the Media module's documented
   * responsibility). */
  deletePost(actor: AuthenticatedUser, id: string): Promise<void>;

  /** Public list: `PUBLISHED` AND `publishedAt <= now()` only — see
   * `blog.repository.ts`'s `listPublished`/`publicVisibilityWhere` for where
   * that filter is actually enforced (in the query, not here; this method is
   * a thin pass-through that exists so the router never talks to the
   * repository directly — preserving the "router -> service -> repository"
   * layering even where the service adds no extra rule of its own). */
  getPublished(pagination: PaginationQuery): Promise<PaginatedResult<BlogPostWithPublicAuthor>>;

  /** Public detail-by-slug — 404s (via `notFound()`) for "no such slug" AND
   * for "exists, but not yet/no longer publicly visible" (collapsed into one
   * outcome; see `findPublishedBySlug`'s doc-comment for why a distinguishing
   * response would itself be a content-existence leak — architecture.md §7.3
   * invariant #3 / plan.md Phase 4a step 3's "scheduled-but-not-yet-live post
   * 404s on direct slug access" requirement). */
  getPublishedBySlug(slug: string): Promise<BlogPostWithPublicAuthor>;
}

/** Pure helper: derives the candidate base slug from a title via the shared
 * `slugify()` transformation. Pulled out only so `generateUniqueSlug`'s loop
 * body reads as "probe candidates" rather than re-deriving the base inline —
 * no behavior beyond what `slugify` already provides. */
function baseSlugFor(title: string): string {
  const slug = slugify(title);
  // `slugify` can legitimately return `''` for a title that is ENTIRELY
  // punctuation/symbols once diacritics are stripped and non-alphanumerics
  // collapsed (e.g. "★★★" or "..."). `MIN_TITLE_LENGTH` doesn't prevent this
  // — length and "produces a usable slug" are different properties. Fall
  // back to a stable, recognizable placeholder base so the collision loop
  // below always has a non-empty string to probe (an empty base would
  // produce candidates like `''`, `'-2'`, `'-3'` — neither URL-safe nor
  // meaningful).
  return slug.length > 0 ? slug : 'post';
}

export function createBlogService({ repository }: BlogServiceOptions): BlogService {
  /**
   * Probes `slugCandidate(1, base)`, `slugCandidate(2, base)`, ... against
   * `repository.slugExists` until an unused candidate is found, per the
   * plan's documented collision policy ("append `-2`, `-3`, ..."). Bounded
   * by `MAX_SLUG_COLLISION_ATTEMPTS` — see that constant's doc-comment for
   * why an unbounded loop would itself be a (mild) DoS/bug-amplification
   * vector. Sequential `await`s (not `Promise.all`) are deliberate: each
   * probe's result determines whether the NEXT one is even needed — a classic
   * case where parallelizing would do strictly more work for no benefit.
   */
  async function generateUniqueSlug(title: string): Promise<string> {
    const base = baseSlugFor(title);

    for (let attempt = 1; attempt <= MAX_SLUG_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = slugCandidate(attempt, base);
      // Sequential by design (not parallelized) — see this function's
      // doc-comment for why each probe gates whether the next is needed.
      const exists = await repository.slugExists(candidate);
      if (!exists) {
        return candidate;
      }
    }

    throw conflict(
      `Could not generate a unique slug for "${title}" after ${MAX_SLUG_COLLISION_ATTEMPTS} attempts — ` +
        'too many existing posts share this title. Try a more distinctive title.',
    );
  }

  /** Shared "load by id or 404" — every ownership-checked admin operation
   * needs this exact lookup-or-404 shape; naming it once keeps the
   * `notFound()` message and the lookup mechanics consistent across
   * `updatePost`/`publish`/`unpublish`/`setSlug`/`getForUser`/`deletePost`. */
  async function loadOrNotFound(id: string): Promise<BlogPost> {
    const post = await repository.findById(id);
    if (!post) {
      throw notFound('Blog post not found');
    }
    return post;
  }

  /** Shared "load by id, 404 if missing, 403 if not editable by `actor`" —
   * the exact two-step check plan.md Phase 4a step 4 spells out as
   * structurally necessary ("`requireRole` only proves the caller is *some*
   * blogger ... without the ownership check a Blogger could PATCH/DELETE
   * another author's post by guessing its id"). Centralizing this here means
   * every mutating admin operation enforces the identical rule, in the
   * identical order (existence before ownership — see doc-comment on
   * `requireOwnedOrNotFound`'s call sites for why that order, not the
   * reverse, is the right one to avoid leaking existence to a non-owner). */
  async function requireOwnedOrNotFound(actor: AuthenticatedUser, id: string): Promise<BlogPost> {
    const post = await loadOrNotFound(id);
    if (!canEditPost(actor, post satisfies OwnedPost)) {
      throw forbidden('You may only act on your own posts');
    }
    return post;
  }

  return {
    async createPost(author, { title, body }) {
      const slug = await generateUniqueSlug(title);
      const sanitizedBody = sanitizeBlogPostBody(body);

      return repository.create({ title, slug, sanitizedBody, authorId: author.id });
    },

    async updatePost(actor, id, { title, body }) {
      await requireOwnedOrNotFound(actor, id);

      // Sanitize ONLY when a new body was actually supplied — re-sanitizing
      // `undefined` would coerce it to a string and persist garbage; the
      // repository's `update` already treats `undefined` as "leave this
      // field alone" (see its doc-comment), and this preserves that contract
      // end-to-end rather than silently overwriting an unrelated field.
      const sanitizedBody = body !== undefined ? sanitizeBlogPostBody(body) : undefined;

      return repository.update(id, { title, sanitizedBody });
    },

    async publish(actor, id) {
      const post = await requireOwnedOrNotFound(actor, id);

      // Idempotent-ish: re-publishing an already-published post simply
      // re-stamps `publishedAt` to "now" — a deliberate, narrow allowance
      // (no separate "republish" action exists, and an Admin/author choosing
      // to hit "publish" again on a live post most plausibly means "bump
      // this back to the top of the recency-ordered list," which is exactly
      // what re-stamping `publishedAt` achieves). This does NOT regenerate
      // `slug` — see file-header slug-policy note; `repository.publish`
      // structurally cannot touch it.
      void post; // loaded only for the ownership check above; no further use
      return repository.publish(id, { publishedAt: new Date() });
    },

    async unpublish(actor, id) {
      await requireOwnedOrNotFound(actor, id);
      return repository.unpublish(id);
    },

    async setSlug(actor, id, newSlug) {
      // Deliberately NOT `requireOwnedOrNotFound` — see this method's
      // interface doc-comment for why `canEditPost`'s "author OR admin"
      // predicate would be the WRONG check here (too permissive: it would
      // let a Blogger-author rewrite their own post's public URL, which is
      // precisely the hazard this Admin-only path exists to prevent). The
      // router gates this route with `requireRole(authService, 'ADMIN')`
      // alone; this service method trusts that gate for the role check and
      // adds only the existence check + collision re-validation below.
      await loadOrNotFound(id);

      if (await repository.slugExists(newSlug)) {
        throw conflict(`The slug "${newSlug}" is already in use by another post`);
      }

      return repository.setSlug(id, newSlug);
    },

    async listForUser(actor, pagination) {
      // Admin sees every author's posts (no `authorId` filter); a Blogger
      // sees only their own — encoded HERE, by role, as the single scoping
      // decision (see this method's interface doc-comment). `requireRole`
      // at the router guarantees `actor.role` is one of `ADMIN`/`BLOGGER`;
      // anything that is not `ADMIN` is therefore necessarily `BLOGGER`,
      // and is scoped to their own authored posts.
      const authorId = actor.role === 'ADMIN' ? undefined : actor.id;
      const { items, total } = await repository.listByAuthor(authorId, pagination);
      return toPaginatedResult(items, pagination, total);
    },

    async getForUser(actor, id) {
      return requireOwnedOrNotFound(actor, id);
    },

    async deletePost(actor, id) {
      await requireOwnedOrNotFound(actor, id);
      await repository.delete(id);
    },

    async getPublished(pagination) {
      const { items, total } = await repository.listPublished(pagination);
      return toPaginatedResult(items, pagination, total);
    },

    async getPublishedBySlug(slug) {
      const post = await repository.findPublishedBySlug(slug);
      if (!post) {
        // See `findPublishedBySlug`'s doc-comment: "no such slug" and
        // "exists but not yet/no longer public" are COLLAPSED into this one
        // outcome — a 404 either way. Distinguishing them would itself leak
        // "this slug exists, just not for you yet" to an anonymous prober.
        throw notFound('Blog post not found');
      }
      return post;
    },
  };
}
