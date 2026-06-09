/**
 * Zod request-validation schemas for the Users module routes (plan.md Phase
 * 4f), consumed via `validate({ body?, params?, query? })` — see
 * `middleware/validate.ts`'s file-header doc-comment for the project-wide
 * "schemas are duplicated per module, mirrored by hand in the SPA"
 * convention. The SPA's mirrored copy would live at
 * `web/src/shared/schemas/users.schema.ts`.
 */
import { z } from 'zod';

import { MAX_EMAIL_LENGTH } from './users.constants';

/**
 * `:id` route param — shared by `GET /admin/users/:id` and
 * `PATCH /admin/users/:id`. A non-empty string at the schema level; the
 * service layer is responsible for "is this a real user id?" (producing the
 * named `notFound()` error). Mirrors `blog.schemas.ts`'s `slugParamSchema`
 * and `cms.schemas.ts`'s `slotKeyParamSchema` posture: validating shape here
 * only; domain-level existence validation belongs to the service.
 */
export const userIdParamSchema = z.object({
  id: z.string().trim().min(1, 'id is required'),
});
export type UserIdParam = z.infer<typeof userIdParamSchema>;

/**
 * `GET /admin/users` query — optional `role` and `isActive` filters layered
 * onto the shared pagination schema.
 *
 * `z.coerce.number()` for `page`/`limit` (query strings always arrive as
 * strings); `role` and `isActive` are both optional — omitting them returns
 * all users without filtering.
 *
 * `isActive` is a boolean flag that arrives as a query-string: `'true'` ->
 * `true`, `'false'` -> `false`. `z.coerce.boolean()` is NOT used here
 * (coercing an arbitrary string to boolean is notoriously permissive —
 * `z.coerce.boolean()` treats any non-empty string as `true`, which would
 * make `?isActive=no` silently behave as `?isActive=true`). Instead:
 * a small `preprocess` that maps the exact strings `'true'`/`'false'` to
 * their boolean equivalents and rejects anything else — the same "explicit
 * mapping over implicit coercion" posture the events module uses for
 * `branch`/`upcoming` filters.
 */
export const listUsersQuerySchema = z.object({
  page: z.coerce
    .number()
    .int('page must be a whole number')
    .min(1, 'page must be at least 1')
    .default(1),
  limit: z.coerce
    .number()
    .int('limit must be a whole number')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must be at most 100')
    .default(20),
  role: z.enum(['ADMIN', 'BLOGGER', 'EVENT_MANAGER']).optional(),
  isActive: z
    .preprocess((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return val; // let Zod's type check handle other values
    }, z.boolean())
    .optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * `POST /admin/users` body — create a staff account.
 *
 * `firstName` and `surname` are accepted purely for the welcome email
 * greeting text — they are NOT stored (the `User` schema has no name-split
 * fields; `User.name` is a single `String`). The service uses them if
 * present, then discards them. See `users.service.ts`'s `createUser`
 * doc-comment for the full "accept-for-greeting, discard-from-DB" rationale.
 */
export const createUserSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .email('must be a valid email address')
    .max(MAX_EMAIL_LENGTH, `email must be at most ${MAX_EMAIL_LENGTH} characters`),
  role: z.enum(['ADMIN', 'BLOGGER', 'EVENT_MANAGER'], {
    required_error: 'role is required',
    invalid_type_error: 'role must be ADMIN, BLOGGER, or EVENT_MANAGER',
  }),
  /** Accepted for the welcome email greeting only — NOT persisted to the DB. */
  firstName: z.string().trim().min(1).max(100).optional(),
  /** Accepted for the welcome email greeting only — NOT persisted to the DB. */
  surname: z.string().trim().min(1).max(100).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * `PATCH /admin/users/:id` body — partial update to `role`, `email`, or
 * `isActive`. At least one field must be provided (the schema rejects an
 * entirely empty body via a `.refine()` — a PATCH that changes nothing is a
 * client bug, not a no-op we should silently accept).
 *
 * `name` is not patchable here — it is set at creation from `User.email`'s
 * domain part (or from `firstName`/`surname` if provided to POST), and there
 * is no documented use case for an Admin changing another staff member's
 * display name via this endpoint. Add it when there is a real need (YAGNI).
 */
export const patchUserSchema = z
  .object({
    role: z.enum(['ADMIN', 'BLOGGER', 'EVENT_MANAGER']).optional(),
    email: z
      .string()
      .trim()
      .min(1)
      .email('must be a valid email address')
      .max(MAX_EMAIL_LENGTH, `email must be at most ${MAX_EMAIL_LENGTH} characters`)
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => data.role !== undefined || data.email !== undefined || data.isActive !== undefined,
    { message: 'At least one field (role, email, isActive) must be provided', path: ['_root'] },
  );
export type PatchUserInput = z.infer<typeof patchUserSchema>;
