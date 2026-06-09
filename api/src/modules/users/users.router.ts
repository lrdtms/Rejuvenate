/**
 * Users module router (plan.md Phase 4f).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   Admin (all gated `requireRole(authService, 'ADMIN')` — no exceptions):
 *     GET   /api/v1/admin/users           — paginated list (filterable by
 *                                           ?role= and ?isActive=)
 *     GET   /api/v1/admin/users/:id       — single user by id
 *     POST  /api/v1/admin/users           — create staff account (generates
 *                                           temp password, sends welcome email)
 *     PATCH /api/v1/admin/users/:id       — update role, email, or isActive
 *                                           (with last-Admin + self-lock guards)
 *
 * No `DELETE` route — hard-delete is never allowed (use `isActive = false`
 * deactivation to preserve the audit trail for authored content, per
 * architecture.md §7.2 / plan.md Phase 4f step 2).
 *
 * This is the "interface adapter" layer in the router -> service ->
 * repository chain (architecture.md §6 "Clean layering"): it parses/validates
 * HTTP input (via `validate()` + `users.schemas.ts`), translates between
 * Express's request/response world and `UsersService`'s plain-data contract,
 * and shapes responses/status codes. NO domain rules live here — duplicate-
 * email rejection, temp-password generation, guard rails, `passwordHash`
 * stripping, and the welcome-email dispatch are all `UsersService`'s job (see
 * that file's doc-comments for the full *why* behind each).
 *
 * A factory (`createUsersRouter`), not a module-level `router` — mirrors
 * `createCmsRouter`'s/`createBlogRouter`'s convention, letting `app.ts` (the
 * composition root) inject the constructed `UsersService`/`AuthService`
 * instances.
 *
 * ===========================================================================
 * Why ALL routes are gated `requireRole(authService, 'ADMIN')` ALONE
 * ===========================================================================
 * Staff account management — creation, role assignment, deactivation — is an
 * operation with the highest trust requirement in this system. Only Admins
 * have the authority to create new staff accounts or change role assignments
 * (plan.md Phase 4f step 1: "confirm Admin-only staff account creation/role
 * assignment"). There are no per-resource ownership exceptions: an Admin may
 * read/update ANY user, and no non-Admin role is ever allowed access to any
 * route in this module.
 *
 * The self-lock and last-Admin guards (in `UsersService`) are the ONLY
 * restrictions on what an Admin may do to a user record — and those are
 * business-rule guards, not additional RBAC tiers.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import type { AuthService } from '../auth/auth.service';
import type { UsersService, AdminUserView } from './users.service';
import {
  createUserSchema,
  listUsersQuerySchema,
  patchUserSchema,
  userIdParamSchema,
  type CreateUserInput,
  type ListUsersQuery,
  type PatchUserInput,
  type UserIdParam,
} from './users.schemas';

export interface CreateUsersRouterOptions {
  authService: AuthService;
  usersService: UsersService;
}

/** Wraps a single `AdminUserView` in the `{ user: {...} }` envelope used by
 * single-user routes (GET by id, POST, PATCH) — mirrors `blog.router.ts`'s
 * `postResponse`/`{ post: {...} }` "name the wrapper once, reuse at every
 * call site that returns this shape" convention. */
function userResponse(user: AdminUserView): { user: AdminUserView } {
  return { user };
}

export function createUsersRouter(options: CreateUsersRouterOptions): Router {
  const { authService, usersService } = options;
  const router = Router();

  // The single shared role gate for all Admin Users routes — named once so
  // every registration below inherits the identical, correctly-scoped gate by
  // construction rather than by copy-paste. Mirrors `requireCmsAdmin` in
  // `cms.router.ts`.
  const requireUsersAdmin = requireRole(authService, 'ADMIN');

  // -------------------------------------------------------------------------
  // GET /admin/users — paginated list with optional role/isActive filters
  // -------------------------------------------------------------------------
  router.get(
    '/admin/users',
    requireUsersAdmin,
    validate({ query: listUsersQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      const query = req.query as unknown as ListUsersQuery;

      usersService
        .listUsers(
          { role: query.role, isActive: query.isActive },
          { page: query.page, limit: query.limit },
        )
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/users/:id — single user by id
  // -------------------------------------------------------------------------
  router.get(
    '/admin/users/:id',
    requireUsersAdmin,
    validate({ params: userIdParamSchema }),
    (req: Request<UserIdParam>, res: Response, next: NextFunction) => {
      usersService
        .getUserById(req.params.id)
        .then((user) => {
          res.status(200).json(userResponse(user));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/users — create staff account
  //
  // Returns 201 with `{ user: AdminUserView, temporaryPassword: string }` —
  // the `temporaryPassword` field appears ONLY in this response, never again.
  // The Admin copies it to send out-of-band, or the welcome email carries it.
  // -------------------------------------------------------------------------
  router.post(
    '/admin/users',
    requireUsersAdmin,
    validate({ body: createUserSchema }),
    (req: Request<Record<string, never>, unknown, CreateUserInput>, res: Response, next: NextFunction) => {
      usersService
        .createUser(req.body)
        .then(({ user, temporaryPassword }) => {
          res.status(201).json({ user, temporaryPassword });
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /admin/users/:id — partial update (role, email, isActive)
  //
  // 200 on success; 400 for guard-rail violations (last-Admin lockout, self-
  // lock); 404 for an unknown id; 409 for a duplicate email. Domain rules
  // (including the two guards and the role-change audit log) are entirely
  // `UsersService`'s concern — this handler is a thin translation layer.
  // -------------------------------------------------------------------------
  router.patch(
    '/admin/users/:id',
    requireUsersAdmin,
    validate({ params: userIdParamSchema, body: patchUserSchema }),
    (
      req: Request<UserIdParam, unknown, PatchUserInput>,
      res: Response,
      next: NextFunction,
    ) => {
      usersService
        .patchUser(req.user!, req.params.id, req.body)
        .then((user) => {
          res.status(200).json(userResponse(user));
        })
        .catch(next);
    },
  );

  return router;
}
