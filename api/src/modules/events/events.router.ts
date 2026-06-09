/**
 * Events module router (plan.md Phase 4b steps 3-4).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   Public:
 *     GET  /api/v1/events            — paginated, published-only list
 *                                       (filterable: `branch`, `upcoming`/`past`)
 *     GET  /api/v1/events/:slug      — single published event by slug
 *   Admin (gated `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')` unless noted):
 *     GET    /api/v1/admin/events            — all events (optionally `branch`-filtered)
 *     POST   /api/v1/admin/events            — create (always DRAFT)
 *     GET    /api/v1/admin/events/:id        — single event
 *     PATCH  /api/v1/admin/events/:id        — update descriptive/scheduling fields
 *     DELETE /api/v1/admin/events/:id        — delete (blocked if registrations exist)
 *     POST   /api/v1/admin/events/:id/status — explicit status transition
 *     PATCH  /api/v1/admin/events/:id/slug   — manual slug edit (ADMIN ONLY — see below)
 *
 * This is the "interface adapter" layer in the router -> service ->
 * repository chain (architecture.md §6 "Clean layering") — mirrors
 * `blog.router.ts`'s shape and division of responsibility line for line: it
 * parses/validates HTTP input, translates between Express and `EventService`'s
 * plain-data contract, and shapes responses/status codes. NO domain rules
 * live here — slug policy, the status-transition graph, the dormant-fields
 * guarantee, and the capacity primitive are all `EventService`'s job (see
 * that file's extensive doc-comments for the *why* behind each).
 *
 * A factory (`createEventRouter`), not a module-level `router` — mirrors
 * `createBlogRouter`'s convention, letting `app.ts` (the composition root)
 * inject the constructed `EventService`/`AuthService` instances.
 *
 * ===========================================================================
 * Why there is NO per-resource ownership check on `/admin/events/:id*`
 * (unlike Blog's extensive "necessary but not sufficient" note)
 * ===========================================================================
 * `blog.router.ts`'s file header spends a long paragraph explaining why
 * `requireRole(authService, 'ADMIN', 'BLOGGER')` is NOT, by itself, a
 * sufficient gate for `/admin/blog/posts/:id*` — a Blogger could otherwise
 * act on another author's post by guessing its id, so `BlogService` layers
 * `canEditPost`/`requireOwnedOrNotFound` on top.
 *
 * THAT REASONING DOES NOT APPLY HERE — by design, not by oversight. See
 * `events.service.ts`'s file-header "EVENT-MANAGER OWNERSHIP" decision in
 * full: any `EVENT_MANAGER` (or `ADMIN`) may manage ANY event; there is no
 * per-Event-Manager ownership boundary for `requireRole` to be insufficient
 * against. `requireEventStaff` below is therefore BOTH NECESSARY AND
 * SUFFICIENT for every `/admin/events/:id*` route — `EventService`'s methods
 * perform an existence check (`loadOrNotFound` -> 404) and nothing more,
 * exactly as documented on `getForAdmin`/`updateEvent`/etc.
 *
 * ===========================================================================
 * Why the manual-slug-edit route is gated DIFFERENTLY (`requireRole(authService, 'ADMIN')`)
 * ===========================================================================
 * Mirrors `blog.router.ts`'s identical carve-out for `PATCH
 * /admin/blog/posts/:id/slug` exactly — see that file's matching section and
 * `EventService.setSlug`'s doc-comment (which itself points back to
 * `BlogService.setSlug`'s full "why `canEditPost`-equivalent reasoning would
 * be too permissive here" argument, confirmed to transfer verbatim in
 * `events.service.ts`'s file-header "SLUG POLICY" note). Gated to `ADMIN`
 * alone — an Event Manager rewriting their own event's public URL
 * unsupervised is precisely the link-breakage hazard the slug-stability
 * policy exists to prevent, regardless of the fact that ownership isn't
 * otherwise scoped for this module.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import type { AuthService } from '../auth/auth.service';
import type { MediaRepository } from '../media/media.repository';
import type { EventService } from './events.service';
import {
  createEventSchema,
  eventIdParamSchema,
  eventStatusSchema,
  listEventsQuerySchema,
  slugParamSchema,
  updateEventSchema,
  updateSlugSchema,
  type CreateEventInput,
  type EventIdParam,
  type ListEventsQuery,
  type SlugParam,
  type UpdateEventInput,
  type UpdateSlugInput,
} from './events.schemas';

export interface CreateEventRouterOptions {
  authService: AuthService;
  eventService: EventService;
  mediaRepository: MediaRepository;
}

/** Keeps the `{ event: {...} }` single-resource response shape consistent
 * across every route that resolves to one event — mirrors `blog.router.ts`'s
 * `postResponse` helper exactly (including its "exists purely to avoid
 * re-deriving the wrapper literal at each call site" rationale). */
function eventResponse(event: unknown): { event: unknown } {
  return { event };
}

/**
 * `POST /admin/events/:id/status` body — a single, explicit `to` field
 * naming the target status. Deliberately a dedicated route + schema (not
 * folded into the generic `PATCH`) — mirrors the reasoning
 * `updatePostSchema`'s doc-comment gives for keeping `status` out of Blog's
 * generic update path: a status transition is its own atomic, named,
 * heavily-ruled operation (`EventService.transitionStatus`'s state-machine
 * check + registration-count augmentation), not a side effect a client
 * should be able to trigger by slipping a `status` field into an otherwise
 *-descriptive PATCH.
 */
const transitionStatusSchema = z.object({ to: eventStatusSchema });
type TransitionStatusInput = z.infer<typeof transitionStatusSchema>;

export function createEventRouter(options: CreateEventRouterOptions): Router {
  const { authService, eventService, mediaRepository } = options;
  const router = Router();

  // The single shared role gate for every `/admin/events/*` route — named
  // once for the identical "avoid copy-pasted-and-drifted gates" reason
  // `blog.router.ts`'s `requireBlogStaff` exists.
  const requireEventStaff = requireRole(authService, 'ADMIN', 'EVENT_MANAGER');

  // -------------------------------------------------------------------------
  // GET /events — public, paginated, published-only, branch/upcoming/past-filterable
  // -------------------------------------------------------------------------
  router.get(
    '/events',
    validate({ query: listEventsQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      // See `blog.router.ts`'s public-list handler for why this cast (not a
      // `Request<..., ListEventsQuery>` generic) is the correct shape —
      // `validate()` replaces `req.query` with the parsed/coerced result,
      // but Express's `RequestHandler` overloads reject threading a custom
      // query type through the generic.
      const query = req.query as unknown as ListEventsQuery;

      // `temporal` is derived HERE, once, from the mutually-exclusive
      // `upcoming`/`past` flags `listEventsQuerySchema` validated — see
      // `events.service.ts`'s file-header "UPCOMING/PAST SEMANTICS" note.
      // Absent both flags -> `'all'` (every published event, regardless of
      // whether it has concluded — the PRD's blog-recap discovery use case
      // plan.md Phase 4b step 3 names as the reason `past=true` browsing
      // must be supported; `'all'` is the natural "no opinion" default that
      // serves both "what's coming up" and "what did we just do" callers
      // without forcing either to pass an explicit flag for the common case).
      const temporal: 'upcoming' | 'past' | 'all' =
        query.upcoming === true ? 'upcoming' : query.past === true ? 'past' : 'all';

      eventService
        .getPublished(query, { branch: query.branch, temporal })
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /events/:slug — public, single published event
  //
  // Enforces `status = PUBLISHED` (the COMPLETE public-visibility predicate
  // for `Event` — see `events.service.ts`'s file-header "no scheduling gap"
  // confirmation: unlike `BlogPost`, there is no `publishedAt`-equivalent
  // column that could put a `PUBLISHED` row in a "not yet live" limbo).
  // -------------------------------------------------------------------------
  router.get(
    '/events/:slug',
    validate({ params: slugParamSchema }),
    async (req: Request<SlugParam>, res: Response, next: NextFunction) => {
      try {
        const event = await eventService.getPublishedBySlug(req.params.slug);
        const images = await mediaRepository.listByOwner('EVENT', event.id);
        res.status(200).json(eventResponse({ ...event, images }));
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/events — all events, optionally branch-filtered
  //
  // NOT scoped by creator — see file-header "no per-resource ownership
  // check" note and `EventService.listForAdmin`'s doc-comment.
  // -------------------------------------------------------------------------
  router.get(
    '/admin/events',
    requireEventStaff,
    validate({ query: listEventsQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      const query = req.query as unknown as ListEventsQuery;

      eventService
        .listForAdmin(req.user!, query, { branch: query.branch })
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/events — create (always DRAFT; see EventService.createEvent)
  // -------------------------------------------------------------------------
  router.post(
    '/admin/events',
    requireEventStaff,
    validate({ body: createEventSchema }),
    (req: Request<unknown, unknown, CreateEventInput>, res: Response, next: NextFunction) => {
      eventService
        .createEvent(req.user!, req.body)
        .then((event) => {
          res.status(201).json(eventResponse(event));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/events/:id — single event
  // -------------------------------------------------------------------------
  router.get(
    '/admin/events/:id',
    requireEventStaff,
    validate({ params: eventIdParamSchema }),
    (req: Request<EventIdParam>, res: Response, next: NextFunction) => {
      eventService
        .getForAdmin(req.user!, req.params.id)
        .then((event) => {
          res.status(200).json(eventResponse(event));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/events/:id — update descriptive/scheduling fields
  //
  // Returns `{ event, registrationCount }` — the registration-count-
  // awareness hook (`events.service.ts`'s `EventWithRegistrationCount`),
  // ALWAYS present (not gated behind "did this change a date") so the SPA's
  // response-handling stays uniform. See that type's doc-comment.
  // -------------------------------------------------------------------------
  router.patch(
    '/admin/events/:id',
    requireEventStaff,
    validate({ params: eventIdParamSchema, body: updateEventSchema }),
    (
      req: Request<EventIdParam, unknown, UpdateEventInput>,
      res: Response,
      next: NextFunction,
    ) => {
      eventService
        .updateEvent(req.user!, req.params.id, req.body)
        .then(({ event, registrationCount }) => {
          res.status(200).json({ event, registrationCount });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/events/:id — hard delete (blocked at the DB+service layer
  // if registrations exist — see `EventService.deleteEvent`'s doc-comment
  // for the `Restrict`-FK -> named `conflict()` translation)
  // -------------------------------------------------------------------------
  router.delete(
    '/admin/events/:id',
    requireEventStaff,
    validate({ params: eventIdParamSchema }),
    (req: Request<EventIdParam>, res: Response, next: NextFunction) => {
      eventService
        .deleteEvent(req.user!, req.params.id)
        .then(() => {
          res.status(204).end();
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/events/:id/status — explicit status transition
  //
  // Body: `{ to: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' }`. Validated against
  // the explicit transition graph in `EventService.transitionStatus`
  // (`conflict()` for any illegal `(from, to)` pair, including same-state).
  // Returns `{ event, registrationCount }` — see the PATCH route's comment
  // immediately above; this is the OTHER (and more consequential — cancel/
  // unpublish are the genuinely destructive transitions) half of the
  // registration-count-awareness hook.
  // -------------------------------------------------------------------------
  router.post(
    '/admin/events/:id/status',
    requireEventStaff,
    validate({ params: eventIdParamSchema, body: transitionStatusSchema }),
    (
      req: Request<EventIdParam, unknown, TransitionStatusInput>,
      res: Response,
      next: NextFunction,
    ) => {
      eventService
        .transitionStatus(req.user!, req.params.id, req.body.to)
        .then(({ event, registrationCount }) => {
          res.status(200).json({ event, registrationCount });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/events/:id/slug — Admin-only manual slug edit
  //
  // Deliberately gated by `requireRole(authService, 'ADMIN')` ALONE — not
  // `requireEventStaff` — mirroring `blog.router.ts`'s identical carve-out
  // for posts. See file-header "why the manual-slug-edit route is gated
  // differently" note and `EventService.setSlug`'s doc-comment.
  // -------------------------------------------------------------------------
  router.patch(
    '/admin/events/:id/slug',
    requireRole(authService, 'ADMIN'),
    validate({ params: eventIdParamSchema, body: updateSlugSchema }),
    (
      req: Request<EventIdParam, unknown, UpdateSlugInput>,
      res: Response,
      next: NextFunction,
    ) => {
      eventService
        .setSlug(req.user!, req.params.id, req.body.slug)
        .then((event) => {
          res.status(200).json(eventResponse(event));
        })
        .catch(next);
    },
  );

  return router;
}
