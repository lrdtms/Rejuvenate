/**
 * Blog module router (plan.md Phase 4a steps 3-4).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   Public:
 *     GET  /api/v1/blog/posts            — paginated, published-only list
 *     GET  /api/v1/blog/posts/:slug      — single published post by slug
 *   Admin (gated `requireRole(authService, 'ADMIN', 'BLOGGER')` unless noted):
 *     GET    /api/v1/admin/blog/posts            — "my posts" (Blogger) / "all posts" (Admin)
 *     POST   /api/v1/admin/blog/posts            — create (always DRAFT)
 *     GET    /api/v1/admin/blog/posts/:id        — single post (ownership-checked)
 *     PATCH  /api/v1/admin/blog/posts/:id        — update title/body (ownership-checked)
 *     DELETE /api/v1/admin/blog/posts/:id        — delete (ownership-checked)
 *     POST   /api/v1/admin/blog/posts/:id/publish    — DRAFT -> PUBLISHED (ownership-checked)
 *     POST   /api/v1/admin/blog/posts/:id/unpublish  — PUBLISHED -> DRAFT (ownership-checked)
 *     PATCH  /api/v1/admin/blog/posts/:id/slug   — manual slug edit (ADMIN ONLY — see below)
 *
 * This is the "interface adapter" layer in the router -> service ->
 * repository chain (architecture.md §6 "Clean layering"): it parses/
 * validates HTTP input (via `validate()` + `blog.schemas.ts`), translates
 * between Express's request/response world and `BlogService`'s plain-data
 * contract, and shapes responses/status codes. NO domain rules live here —
 * ownership, sanitization, slug policy, and status-transition rules are all
 * `BlogService`'s job (see that file's doc-comments for the *why* behind
 * each one); this file's job is solely "is the request well-formed, is the
 * caller the right kind of user, and does the response look right."
 *
 * A factory (`createBlogRouter`), not a module-level `router` — mirrors
 * `createAuthRouter`'s convention, letting `app.ts` (the composition root)
 * inject the constructed `BlogService`/`AuthService` instances.
 *
 * ===========================================================================
 * Why `requireRole(authService, 'ADMIN', 'BLOGGER')` is necessary BUT NOT
 * SUFFICIENT for the `/admin/blog/posts/:id*` routes
 * ===========================================================================
 * `requireRole` proves "this caller is *some* Admin or Blogger" — it does
 * NOT prove "this caller may act on *this specific* post id." Every route
 * below that targets a single post by `:id` (`GET`/`PATCH`/`DELETE`/
 * `publish`/`unpublish`) delegates the per-resource ownership decision to
 * `BlogService` (`getForUser`/`updatePost`/`deletePost`/`publish`/
 * `unpublish`, all of which call the shared `requireOwnedOrNotFound` ->
 * `canEditPost` chain internally and throw `forbidden()`/`notFound()` as
 * appropriate) — see plan.md Phase 4a step 4's explicit warning that this is
 * "easy to assume but forget to write." The router never re-implements that
 * check; it simply lets the service's thrown `AppError`s flow to `next()`
 * and from there to the central error handler. This keeps the rule defined
 * in EXACTLY ONE place (`canEditPost`) regardless of how many routes need it.
 *
 * ===========================================================================
 * Why the manual-slug-edit route is gated DIFFERENTLY (`requireRole(authService, 'ADMIN')`)
 * ===========================================================================
 * Every other `/admin/blog/posts/:id*` route is reachable by `ADMIN` OR
 * `BLOGGER` (subject to the ownership check above). The slug-edit route is
 * the one deliberate exception — gated to `ADMIN` alone, with NO ownership
 * fallback for authors. See `BlogService.setSlug`'s interface doc-comment
 * for the full "why `canEditPost` would be too permissive here" reasoning;
 * in short, allowing a Blogger-author to rewrite their own post's public URL
 * unsupervised is precisely the link-breakage hazard plan.md Phase 4a step 2
 * names ("becomes an awkward retrofit once posts have been shared
 * publicly") — this is a deliberately narrower gate than the rest of the
 * module, not an oversight.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import type { AuthService } from '../auth/auth.service';
import type { BlogService } from './blog.service';
import {
  createPostSchema,
  listPostsQuerySchema,
  postIdParamSchema,
  slugParamSchema,
  updatePostSchema,
  updateSlugSchema,
  type CreatePostInput,
  type ListPostsQuery,
  type PostIdParam,
  type SlugParam,
  type UpdatePostInput,
  type UpdateSlugInput,
} from './blog.schemas';

export interface CreateBlogRouterOptions {
  authService: AuthService;
  blogService: BlogService;
}

/**
 * Both `:id` admin routes and the public `:slug` route resolve to a single
 * post and then must answer "what does the response body look like." This
 * helper exists ONLY to keep that JSON shape (`{ post: {...} }`) consistent
 * across every "single post" response the router sends — including ones from
 * different code paths (public vs. admin) — without re-deriving the wrapper
 * object literal at each of the seven call sites below.
 */
function postResponse(post: unknown): { post: unknown } {
  return { post };
}

export function createBlogRouter(options: CreateBlogRouterOptions): Router {
  const { authService, blogService } = options;
  const router = Router();

  // The single shared role gate for every `/admin/blog/*` route — named once
  // so the seven admin route registrations below read as "admin blog route,
  // then its specific path/handler" rather than repeating the same
  // three-argument `requireRole` call seven times (a textbook case where a
  // copy-pasted gate could silently drift — e.g. one route accidentally
  // omitting `'BLOGGER'` — without anyone noticing at review time).
  const requireBlogStaff = requireRole(authService, 'ADMIN', 'BLOGGER');

  // -------------------------------------------------------------------------
  // GET /blog/posts — public, paginated, published-only
  // -------------------------------------------------------------------------
  router.get(
    '/blog/posts',
    validate({ query: listPostsQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      // `validate({ query: ... })` replaces `req.query` with the PARSED
      // result (coerced/defaulted `{ page, limit }` — see `validate.ts`'s
      // "replaces req.<part> with the parsed result" note), but Express's
      // own `Request['query']` type remains the generic `ParsedQs` — there
      // is no clean way to thread a custom query type through Express's
      // `RequestHandler` generics here (the overload resolution rejects a
      // `Request<..., ListPostsQuery>` handler being assigned where a
      // `Request<..., ParsedQs>` is expected). A single, named, narrowly-
      // scoped cast at the point of consumption — backed by the fact that
      // `validate()` is THE thing that put this shape there — is clearer
      // than fighting Express's generics with a parallel custom `Request`
      // augmentation for one field.
      const query = req.query as unknown as ListPostsQuery;

      blogService
        .getPublished(query)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /blog/posts/:slug — public, single published post
  //
  // Enforces BOTH `status = PUBLISHED` AND `publishedAt <= now()` (via
  // `BlogService.getPublishedBySlug` -> `findPublishedBySlug` -> the shared
  // `publicVisibilityWhere` predicate) — architecture.md §7.3 invariant #3 /
  // plan.md Phase 4a step 3's explicit warning that this is "easy to satisfy
  // on the list endpoint but forget on the detail endpoint." A
  // scheduled-but-not-yet-live post 404s here exactly as it would for a
  // nonexistent slug — see `getPublishedBySlug`'s doc-comment for why that
  // collapse is itself a deliberate anti-enumeration control, not laziness.
  // -------------------------------------------------------------------------
  router.get(
    '/blog/posts/:slug',
    validate({ params: slugParamSchema }),
    (req: Request<SlugParam>, res: Response, next: NextFunction) => {
      blogService
        .getPublishedBySlug(req.params.slug)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/blog/posts — "my posts" (Blogger) / "all posts" (Admin)
  //
  // Scoping is decided INSIDE `BlogService.listForUser` (by `actor.role`),
  // not here — see that method's doc-comment for why the decision belongs in
  // exactly one place.
  // -------------------------------------------------------------------------
  router.get(
    '/admin/blog/posts',
    requireBlogStaff,
    validate({ query: listPostsQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      // See the public `/blog/posts` handler's comment for why this cast —
      // not a `Request<..., ListPostsQuery>` generic — is the right shape
      // here (Express's `RequestHandler` overloads reject the latter).
      const query = req.query as unknown as ListPostsQuery;

      // `requireBlogStaff` (via `requireRole`) has already populated
      // `req.user` with a live, active, role-checked `AuthenticatedUser` —
      // see `middleware/rbac.ts`'s "req.user — populated for downstream
      // handlers" note. It is always defined on every route past this gate;
      // the non-null assertion documents that guarantee rather than
      // re-deriving a runtime check the middleware already performed.
      blogService
        .listForUser(req.user!, query)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/blog/posts — create (always DRAFT; see BlogService.createPost)
  // -------------------------------------------------------------------------
  router.post(
    '/admin/blog/posts',
    requireBlogStaff,
    validate({ body: createPostSchema }),
    (req: Request<unknown, unknown, CreatePostInput>, res: Response, next: NextFunction) => {
      blogService
        .createPost(req.user!, req.body)
        .then((post) => {
          res.status(201).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/blog/posts/:id — single post, ownership-checked
  // -------------------------------------------------------------------------
  router.get(
    '/admin/blog/posts/:id',
    requireBlogStaff,
    validate({ params: postIdParamSchema }),
    (req: Request<PostIdParam>, res: Response, next: NextFunction) => {
      blogService
        .getForUser(req.user!, req.params.id)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/blog/posts/:id — update title/body, ownership-checked,
  // sanitized-on-save (all inside BlogService.updatePost)
  // -------------------------------------------------------------------------
  router.patch(
    '/admin/blog/posts/:id',
    requireBlogStaff,
    validate({ params: postIdParamSchema, body: updatePostSchema }),
    (
      req: Request<PostIdParam, unknown, UpdatePostInput>,
      res: Response,
      next: NextFunction,
    ) => {
      blogService
        .updatePost(req.user!, req.params.id, req.body)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/blog/posts/:id — ownership-checked hard delete
  // -------------------------------------------------------------------------
  router.delete(
    '/admin/blog/posts/:id',
    requireBlogStaff,
    validate({ params: postIdParamSchema }),
    (req: Request<PostIdParam>, res: Response, next: NextFunction) => {
      blogService
        .deletePost(req.user!, req.params.id)
        .then(() => {
          res.status(204).end();
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/blog/posts/:id/publish — DRAFT -> PUBLISHED, ownership-checked
  // -------------------------------------------------------------------------
  router.post(
    '/admin/blog/posts/:id/publish',
    requireBlogStaff,
    validate({ params: postIdParamSchema }),
    (req: Request<PostIdParam>, res: Response, next: NextFunction) => {
      blogService
        .publish(req.user!, req.params.id)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/blog/posts/:id/unpublish — PUBLISHED -> DRAFT, ownership-checked
  // -------------------------------------------------------------------------
  router.post(
    '/admin/blog/posts/:id/unpublish',
    requireBlogStaff,
    validate({ params: postIdParamSchema }),
    (req: Request<PostIdParam>, res: Response, next: NextFunction) => {
      blogService
        .unpublish(req.user!, req.params.id)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/blog/posts/:id/slug — Admin-only manual slug edit
  //
  // Deliberately gated by `requireRole(authService, 'ADMIN')` ALONE — not
  // `requireBlogStaff` — and deliberately does NOT layer an additional
  // ownership check on top (an Admin may retarget ANY post's slug). See the
  // file-header "why the manual-slug-edit route is gated differently" note
  // and `BlogService.setSlug`'s doc-comment for the full rationale.
  // -------------------------------------------------------------------------
  router.patch(
    '/admin/blog/posts/:id/slug',
    requireRole(authService, 'ADMIN'),
    validate({ params: postIdParamSchema, body: updateSlugSchema }),
    (
      req: Request<PostIdParam, unknown, UpdateSlugInput>,
      res: Response,
      next: NextFunction,
    ) => {
      blogService
        .setSlug(req.user!, req.params.id, req.body.slug)
        .then((post) => {
          res.status(200).json(postResponse(post));
        })
        .catch(next);
    },
  );

  return router;
}
