/**
 * Service-layer ownership-check helpers (plan.md Phase 3 step 6).
 *
 * architecture.md §9.2 / §14 specify the Blogger-own-posts rule as a
 * service-layer ownership check — `post.authorId === currentUser.id ||
 * currentUser.role === 'ADMIN'` — living ALONGSIDE (not instead of) the
 * route-level `requireRole()` gate. `requireRole('ADMIN', 'BLOGGER')` proves
 * "this caller is *some* blogger or admin"; it does NOT prove "this caller
 * may act on *this specific* post." Without an explicit per-resource check,
 * a Blogger could `PATCH`/`DELETE` another author's post by guessing its id
 * — `requireRole` alone would happily let that request through (the caller
 * IS a Blogger, after all). `canEditPost` is the single named function that
 * closes that gap, so the rule lives in exactly ONE place.
 *
 * ===========================================================================
 * Why a single named function, not scattered inline checks
 * ===========================================================================
 * architecture.md §9.2 explicitly flags the "own posts only" rule as an open
 * question pending stakeholder confirmation ("confirm whether Bloggers may
 * ever edit each other's posts ... changing this later is a one-line
 * service-layer change — not a schema or architecture change"). Concentrating
 * the rule here means that, when the answer comes back, the fix is changing
 * ONE boolean expression in ONE function — not auditing every Blog-module
 * route/service method for an inline `post.authorId === user.id` copy that
 * may have drifted (e.g. one spot checking `=== user.id` and another
 * `!== user.id` with inverted logic, a classic refactor hazard). Ship with
 * the documented default ("own only") here; flip it here when confirmed.
 *
 * ===========================================================================
 * The symmetric pattern for Media (`MediaService.upload`, Phase 4e)
 * ===========================================================================
 * architecture.md §14 / plan.md Phase 3 step 6 call out an easy-to-miss
 * symmetry: the architecture brief's ownership-checking language focuses on
 * blog posts, but the EXACT SAME "don't trust the client-supplied identifier"
 * rule applies to `MediaService.upload(file, ownerType, ownerId)`. A Blogger
 * must only be able to attach media to THEIR OWN posts (not an arbitrary
 * `ownerId` they happen to know/guess), and an Event Manager only to events
 * they manage. ADR-0005 (`MediaAsset` is polymorphic-by-convention — no DB-
 * level FK) makes this an APPLICATION-layer responsibility by design: the
 * database literally cannot enforce it, so the service must.
 *
 * THE PATTERN (to be applied, not yet implemented — Media doesn't exist
 * yet): before persisting a `MediaAsset` row, `MediaService.upload` must:
 *   1. Load the actual owning resource by the claimed `(ownerType, ownerId)`
 *      — e.g. `db.blogPost.findUnique({ where: { id: ownerId } })` when
 *      `ownerType === 'BLOG_POST'` (this ALSO satisfies ADR-0005's
 *      "MediaService validates that the referenced BlogPost/Event actually
 *      exists" requirement — the existence check and the ownership check
 *      are naturally the same database round trip, not two).
 *   2. Run the SAME ownership predicate this file already encodes for posts
 *      (`canEditPost`) — or an exactly analogous `canManageEvent`-shaped
 *      check for events — against the loaded resource and the acting user.
 *   3. Reject with `forbidden()` if the predicate is `false`, BEFORE writing
 *      anything to disk or to `media_assets`.
 *
 * When Phase 4e builds `MediaService`, it should import `canEditPost` from
 * here for the `BLOG_POST` owner-type branch (one function, one source of
 * truth, exactly the same "Bloggers act on their own content only" rule —
 * not a parallel copy that could drift), and define its event-side analogue
 * the same way once the Events module's `EventManager`-ownership shape is
 * settled (architecture.md doesn't currently model per-Event-Manager
 * ownership the way it models `BlogPost.authorId` — Phase 4b should resolve
 * whether Event Managers are scoped to "events they created" the same way
 * Bloggers are scoped to "posts they authored," or whether any Event Manager
 * may manage any event; that decision determines the exact shape of
 * `canManageEvent`, which is why it isn't stubbed here).
 */
import type { AuthenticatedUser } from './auth.service';

/** The minimal slice of `BlogPost` this check needs — callers may pass a full
 * Prisma `BlogPost` row or any object exposing just `authorId` (e.g. a
 * lightweight `select: { authorId: true }` projection, which is all an
 * authorization pre-check needs before fetching/returning the full resource). */
export interface OwnedPost {
  authorId: string;
}

/**
 * The single source of truth for "may `user` create/edit/publish/unpublish/
 * delete `post`?" — encodes the documented DEFAULT rule (architecture.md
 * §9.2's RBAC matrix): an Admin may act on ANY post; a Blogger may act ONLY
 * on posts they authored.
 *
 * Returns a plain `boolean` (does not throw) — it is a predicate, not a
 * guard. Callers (Blog-module service methods — Phase 4a) are expected to
 * write `if (!canEditPost(user, post)) throw forbidden(...)`, choosing
 * whatever message/context fits their call site (e.g. "publish" vs "delete"
 * may warrant slightly different wording) — baking a single hardcoded
 * message into this predicate would make it less reusable for that purpose.
 *
 * Deliberately does NOT check `user.isActive` — by the time a `req.user` has
 * reached service-layer code, `requireAuth()`/`requireRole()` have already
 * proven the session belongs to a live, active user (see `middleware/rbac.ts`'s
 * "isActive enforcement" notes); re-checking it here would be redundant
 * defensive-programming that obscures this function's single, named purpose
 * ("does ownership/role permit this edit?") behind an unrelated concern that
 * already has its own, better-positioned enforcement point.
 */
export function canEditPost(user: AuthenticatedUser, post: OwnedPost): boolean {
  return post.authorId === user.id || user.role === 'ADMIN';
}
