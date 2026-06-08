/**
 * CMS module router (plan.md Phase 4d steps 3-4).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   Public:
 *     GET  /api/v1/cms?keys=a,b,c          — batched slot-value fetch (a map
 *                                             keyed by `slotKey`; see
 *                                             `CmsService.getSlots`'s
 *                                             doc-comment for the full
 *                                             "every requested key present /
 *                                             out-of-registry keys omitted"
 *                                             contract)
 *   Admin (gated `requireRole(authService, 'ADMIN')` ONLY — see below):
 *     GET  /api/v1/admin/cms/:slotKey      — single-slot read (editor load)
 *     PUT  /api/v1/admin/cms/:slotKey      — single-slot write (editor save)
 *
 * This is the "interface adapter" layer in the router -> service ->
 * repository chain (architecture.md §6 "Clean layering"): it parses/
 * validates HTTP input (via `validate()` + `cms.schemas.ts`), translates
 * between Express's request/response world and `CmsService`'s plain-data
 * contract, and shapes responses/status codes. NO domain rules live here —
 * registry-membership enforcement, format-aware sanitization, and the
 * safe-empty-default read contract are all `CmsService`'s job (see that
 * file's doc-comments for the full *why* behind each).
 *
 * A factory (`createCmsRouter`), not a module-level `router` — mirrors
 * `createBlogRouter`'s/`createRegistrationRouter`'s convention, letting
 * `app.ts` (the composition root) inject the constructed `CmsService`/
 * `AuthService` instances.
 *
 * ===========================================================================
 * Why the admin routes are gated `requireRole(authService, 'ADMIN')` ALONE —
 * NOT `'ADMIN', 'EVENT_MANAGER'`/`'BLOGGER'`, and with NO ownership check
 * ===========================================================================
 * Every other admin module in this app (`/admin/blog/*`, `/admin/events/*`,
 * `/admin/events/:id/registrations*`) is reachable by a content-area-scoped
 * staff role (`BLOGGER`, `EVENT_MANAGER`) in addition to `ADMIN`, frequently
 * layered with a per-resource ownership check (`canEditPost`). The CMS admin
 * routes are the deliberate exception to BOTH patterns:
 *
 *   - `requireRole(authService, 'ADMIN')` ONLY — per the RBAC matrix
 *     (architecture.md §9.2 / plan.md Phase 4d step 4's explicit "gated
 *     `requireRole('ADMIN')` only"). `CMSContent` is sitewide branding/
 *     contact-detail copy that appears on EVERY visitor's About/Contact
 *     page — not a content-area-scoped resource a Blogger or Event Manager
 *     has any documented mandate over (the task brief's RBAC framing is
 *     explicit: "Bloggers have no event/CMS access; Event Managers have no
 *     blog/CMS access" — CMS is its own access tier, narrower than either).
 *   - NO ownership check layered on top — there is no "author" concept for
 *     `CMSContent` (`lastEditedById` is attribution/audit metadata, not an
 *     access-control field — see `cms.service.ts`'s `updateSlot` doc-comment
 *     and the schema's `onDelete: SetNull` relation comment for why it
 *     exists). `requireRole(authService, 'ADMIN')` is therefore both
 *     NECESSARY and SUFFICIENT here — there is no narrower "may this
 *     specific Admin touch this specific slot" question to ask; every Admin
 *     may read/write every slot, by design.
 *
 * ===========================================================================
 * "One shape, three routes" — `CmsSlotView` everywhere
 * ===========================================================================
 * `getSlots` (public batch), `getSlot` (admin single-read), and `updateSlot`
 * (admin single-write) all return/produce the SAME `CmsSlotView` shape
 * (`{ slotKey, format, value, updatedAt }`) — see `cms.service.ts`'s
 * doc-comment on that type for why this single shape, reused everywhere,
 * is what lets the SPA's `useCmsSlots`/`CmsSlot`/`SlotEditor` share one
 * rendering contract with zero special-casing between "viewing the public
 * page" and "editing in the admin." This router's job is simply to wrap
 * each shape in the response envelope its route's contract calls for
 * (a bare slot for admin single-slot routes — mirroring `blog.router.ts`'s
 * `{ post: {...} }` "single resource" convention via `slotResponse`; a
 * `{ slots: { ... } }`-wrapped map for the batch route — naming the field
 * so the response is self-describing and trivially extensible if a future
 * batch response ever needs to carry sibling metadata alongside the map).
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import type { AuthService } from '../auth/auth.service';
import type { CmsService, CmsSlotView } from './cms.service';
import {
  cmsBatchQuerySchema,
  slotKeyParamSchema,
  updateSlotSchema,
  type CmsBatchQuery,
  type SlotKeyParam,
  type UpdateSlotInput,
} from './cms.schemas';

export interface CreateCmsRouterOptions {
  authService: AuthService;
  cmsService: CmsService;
}

/** Wraps a single `CmsSlotView` in the `{ slot: {...} }` envelope used by
 * both admin single-slot routes (`GET`/`PUT /admin/cms/:slotKey`) — mirrors
 * `blog.router.ts`'s `postResponse`/`{ post: {...} }` "name the wrapper
 * once, reuse it at every call site that returns this shape" convention,
 * so a reviewer sees identically-shaped JSON regardless of which of the two
 * single-slot routes produced it (read vs. write — exactly the
 * "WYSIWYG... built once, reused" symmetry `cms.service.ts`'s file header
 * names as the point of sharing `CmsSlotView` everywhere). */
function slotResponse(slot: CmsSlotView): { slot: CmsSlotView } {
  return { slot };
}

export function createCmsRouter(options: CreateCmsRouterOptions): Router {
  const { authService, cmsService } = options;
  const router = Router();

  // The single shared role gate for both `/admin/cms/*` routes — named once
  // so the two registrations below read as "admin CMS route, then its
  // specific path/handler," and so a future third admin CMS route inherits
  // the identical, correctly-scoped gate by construction rather than by
  // copy-paste (the same "avoid copy-pasted-and-drifted gates" discipline
  // `requireBlogStaff`/`requireEventStaff`/`requireRegistrationStaff`
  // document in their respective modules).
  const requireCmsAdmin = requireRole(authService, 'ADMIN');

  // -------------------------------------------------------------------------
  // GET /cms?keys=a,b,c — public, batched slot-value fetch
  //
  // No `requireAuth`/`requireRole` — this is the route the public About/
  // Contact pages hit on every page view (Phase 6 step 1). `CmsService
  // .getSlots` is the ONLY place the "every requested key present /
  // out-of-registry keys omitted" contract is decided — see that method's
  // extensive doc-comment for the full reasoning behind both halves of that
  // contract.
  // -------------------------------------------------------------------------
  router.get(
    '/cms',
    validate({ query: cmsBatchQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      // See `blog.router.ts`'s public-list handler for why this cast (not a
      // `Request<..., CmsBatchQuery>` generic) is the correct shape here —
      // Express's `RequestHandler` overloads reject the latter, and
      // `validate({ query: ... })` is the thing that actually put this
      // parsed-and-transformed shape on `req.query`.
      const query = req.query as unknown as CmsBatchQuery;

      cmsService
        .getSlots(query.keys)
        .then((slots) => {
          res.status(200).json({ slots });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/cms/:slotKey — single-slot read (editor load)
  //
  // Reuses `CmsService.getSlot` (NOT `getSlots([slotKey])`) — the dedicated
  // single-slot path that throws a precise `unknownSlot()` for an
  // out-of-registry key (a 400 naming exactly what was wrong), which is the
  // CORRECT behaviour for an authenticated Admin operator typing/navigating
  // to a slot key directly (very plausibly a typo they'd want to know about
  // immediately) — categorically different from the public batch endpoint's
  // "silently omit and degrade gracefully" contract, which exists to protect
  // ANONYMOUS VISITORS from a developer-side drift they have no way to act
  // on. An Admin hitting this exact route IS the person who can act on
  // "that slotKey doesn't exist" — telling them so, precisely, is a feature,
  // not a layering violation. (See `cms.service.ts`'s `getSlot` doc-comment
  // for the parallel "categorically different" framing.)
  // -------------------------------------------------------------------------
  router.get(
    '/admin/cms/:slotKey',
    requireCmsAdmin,
    validate({ params: slotKeyParamSchema }),
    (req: Request<SlotKeyParam>, res: Response, next: NextFunction) => {
      cmsService
        .getSlot(req.params.slotKey)
        .then((slot) => {
          res.status(200).json(slotResponse(slot));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /admin/cms/:slotKey — single-slot write (editor save)
  //
  // PUT (not PATCH/POST) — the request fully replaces the slot's `value`
  // (the only mutable field this resource exposes; see `updateSlotSchema`'s
  // doc-comment for why `format`/`slotKey` are deliberately NOT
  // client-settable), and the operation is naturally idempotent: saving the
  // same `value` twice produces the identical stored row both times (modulo
  // `updatedAt`/`lastEditedById`, which legitimately reflect "when/who
  // performed this specific write" — exactly the same idempotency framing
  // REST conventions use to distinguish PUT's "replace this resource's
  // representation" from POST's "create a new thing"/PATCH's "apply a
  // partial delta"). `CmsService.updateSlot` owns every domain rule
  // (registry check, format-aware sanitization, `lastEditedById` stamping —
  // see that method's doc-comment).
  // -------------------------------------------------------------------------
  router.put(
    '/admin/cms/:slotKey',
    requireCmsAdmin,
    validate({ params: slotKeyParamSchema, body: updateSlotSchema }),
    (
      req: Request<SlotKeyParam, unknown, UpdateSlotInput>,
      res: Response,
      next: NextFunction,
    ) => {
      cmsService
        .updateSlot(req.user!, req.params.slotKey, req.body.value)
        .then((slot) => {
          res.status(200).json(slotResponse(slot));
        })
        .catch(next);
    },
  );

  return router;
}
