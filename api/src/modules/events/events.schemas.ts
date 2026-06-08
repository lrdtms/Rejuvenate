/**
 * Zod request-validation schemas for the Events module's routes (plan.md
 * Phase 4b), consumed via `validate({ body/params/query: ... })` — mirrors
 * `blog.schemas.ts`'s structure and the project-wide "schemas duplicated per
 * module, mirrored by hand in the SPA" convention documented in
 * `middleware/validate.ts`'s file header. The SPA's mirrored copy lives at
 * `web/src/shared/schemas/events.schema.ts` (per that convention).
 *
 * Pagination + the `branch`/`upcoming`/`past` filters
 * (`listEventsQuerySchema`) are built by `.extend()`-ing the SHARED
 * `paginationQuerySchema` from `lib/pagination.ts` — exactly the reuse that
 * file's header names as the expected Events extension point, and the
 * literal instruction in plan.md Phase 4a step 5 ("Pagination convention
 * established here — reuse for Events").
 */
import { z } from 'zod';

import { paginationQuerySchema } from '../../lib/pagination';
import {
  MAX_CAPACITY,
  MAX_LOCATION_DETAIL_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_DESCRIPTION_LENGTH,
  MIN_LOCATION_DETAIL_LENGTH,
  MIN_TITLE_LENGTH,
} from './events.constants';

/** Mirrors the Prisma `Branch` enum exactly (`prisma/schema.prisma`) — kept
 * as an explicit Zod enum (not a bare `z.string()`) so an invalid branch
 * value is rejected at the validation boundary with a field-level message
 * naming the allowed values, rather than surfacing as an opaque Prisma
 * "invalid enum value" error deep in the repository layer. */
const BRANCH_VALUES = ['CAPE_TOWN', 'DURBAN', 'OTHER'] as const;
export const branchSchema = z.enum(BRANCH_VALUES);

/** Mirrors the Prisma `EventStatus` enum exactly — see `events.service.ts`'s
 * file-header doc-comment ("STATUS TRANSITION GRAPH") for the full state
 * machine these values participate in. */
const EVENT_STATUS_VALUES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export const eventStatusSchema = z.enum(EVENT_STATUS_VALUES);

/**
 * `GET /events` and `GET /admin/events` query — extends the shared
 * `paginationQuerySchema` with Events-specific filters:
 *
 *   - `branch` (optional): scope to a single `Branch`. Omitted = all branches.
 *   - `upcoming` / `past` (optional booleans, mutually exclusive): see
 *     `events.service.ts`'s file-header "UPCOMING/PAST SEMANTICS" doc-comment
 *     for the full reasoning behind the chosen `endsAt >= now()` /
 *     `endsAt < now()` split and why both are exposed as filters rather than
 *     "upcoming" being the only browsable slice (the PRD's blog-recap use
 *     case — plan.md Phase 4b step 3 — wants past published events to remain
 *     discoverable, e.g. "what event was that recap post about?").
 *
 * `z.coerce.boolean()` is deliberately NOT used here: query-string boolean
 * coercion is notoriously surprising (`?upcoming=false` coerces to the
 * non-empty string `'false'`, which `Boolean('false')` — and naive
 * `z.coerce.boolean()`, which is just `Boolean(value)` — both treat as
 * `true`). Instead, `upcoming`/`past` are validated as the literal strings
 * `'true'`/`'false'` and transformed explicitly — an absent param means
 * "no filter," `'true'`/`'false'` mean what they say, and anything else
 * (`?upcoming=banana`) is a clear 400 naming the allowed values rather than
 * a silently-misinterpreted filter.
 */
const optionalBooleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const listEventsQuerySchema = paginationQuerySchema
  .extend({
    branch: branchSchema.optional(),
    upcoming: optionalBooleanFlag,
    past: optionalBooleanFlag,
  })
  .refine((value) => !(value.upcoming === true && value.past === true), {
    message: 'upcoming and past are mutually exclusive — provide at most one as true',
    path: ['past'],
  });
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

/** `GET /events/:slug` param — see `blog.schemas.ts`'s `slugParamSchema`
 * doc-comment for why a bare non-empty string is sufficient (an opaque,
 * URL-safe identifier; stricter shape-checking here would only reject
 * "not found" requests slightly earlier, for no real benefit). */
export const slugParamSchema = z.object({
  slug: z.string().trim().min(1, 'slug is required'),
});
export type SlugParam = z.infer<typeof slugParamSchema>;

/** `:id` route param shared by every admin single-event route. `Event.id` is
 * `@default(uuid())` in the schema, mirroring `BlogPost.id`. */
export const eventIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});
export type EventIdParam = z.infer<typeof eventIdParamSchema>;

/**
 * Shared `startsAt`/`endsAt` shape — both ISO-8601 datetime strings,
 * coerced to `Date`, with the cross-field invariant `endsAt > startsAt`
 * enforced at the schema level (an event that ends before/when it starts is
 * never valid input, regardless of which field a future PATCH touches).
 *
 * `z.coerce.date()` accepts both `Date` instances and ISO strings — the HTTP
 * boundary always sends strings (JSON has no `Date` type), but coercion
 * keeps this schema reusable if a future internal caller passes a `Date`
 * directly.
 */
const datesShape = {
  startsAt: z.coerce.date({ message: 'startsAt must be a valid date/time' }),
  endsAt: z.coerce.date({ message: 'endsAt must be a valid date/time' }),
};

/**
 * `isPaid`/`priceCents` — DORMANT fields (ADR-0006, architecture.md §7.2).
 * Present in the schema so the create/update body shape matches the Prisma
 * model 1:1 and the SPA's mirrored schema can reflect both fields existing —
 * but per the plan's Phase 8 admin-UI guidance ("v1 should hide these from
 * the admin UI entirely") and ADR-0006's "zero payment logic in v1," THE API
 * MUST NOT silently accept a live paid-ticketing configuration.
 *
 * DECISION: REJECT non-default values with a clear validation error, rather
 * than silently ignoring/zeroing them. Rationale:
 *   - Silently coercing `isPaid: true` to `false` (or a real `priceCents` to
 *     `null`) would mean an admin who submits a paid-event configuration —
 *     believing it took effect — gets a free, *unpaid* event published with
 *     no indication anything was altered. That is a much worse failure mode
 *     than a loud, immediate 400 naming exactly which field was rejected and
 *     why: the loud failure costs the admin one resubmission; the silent one
 *     costs them a misconfigured live event and a confused/short-changed
 *     congregation before anyone notices.
 *   - `.refine()` rather than `.optional().default(false)` so the rejection
 *     fires even when the client deliberately sends `true`/a number — a
 *     `.default()` only fills in *absent* values, it does not reject present
 *     ones.
 *
 * When ADR-0006's dormant fields are eventually activated (a deliberate,
 * future, fully-scoped v2 payment feature), this is the ONE schema to change
 * — relax these two `.refine()`s to accept real values, together with
 * whatever payment-integration validation that feature needs. Until then,
 * the only legal values are the safe defaults the schema (and v1 logic)
 * already assumes.
 */
const dormantPaidFieldsShape = {
  isPaid: z
    .boolean()
    .optional()
    .refine((value) => value === undefined || value === false, {
      message:
        'isPaid must be false — paid ticketing is dormant in v1 (ADR-0006); ' +
        'this field exists for future use only and cannot be set to true yet',
    }),
  priceCents: z
    .number()
    .int()
    .nullable()
    .optional()
    .refine((value) => value === undefined || value === null, {
      message:
        'priceCents must be omitted/null — paid ticketing is dormant in v1 (ADR-0006); ' +
        'this field exists for future use only and cannot carry a real price yet',
    }),
};

/**
 * `POST /admin/events` body — creates a new event (always `DRAFT`; see
 * `events.service.ts`'s `createEvent` doc-comment for why publish is a
 * dedicated, separate transition, mirroring Blog's `createPost`/`publish`
 * split).
 *
 * Deliberately does NOT accept `slug` or `status` here — see
 * `events.service.ts`'s file-header "SLUG POLICY" note (slug is generated
 * server-side at creation, exactly like Blog) and "STATUS TRANSITION GRAPH"
 * note (status changes go through dedicated transition endpoints that also
 * carry registration-count awareness).
 */
export const createEventSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(MIN_TITLE_LENGTH, `title must be at least ${MIN_TITLE_LENGTH} characters long`)
      .max(MAX_TITLE_LENGTH, `title must be at most ${MAX_TITLE_LENGTH} characters long`),
    description: z
      .string()
      .trim()
      .min(MIN_DESCRIPTION_LENGTH, `description must be at least ${MIN_DESCRIPTION_LENGTH} characters long`),
    ...datesShape,
    branch: branchSchema,
    locationDetail: z
      .string()
      .trim()
      .min(MIN_LOCATION_DETAIL_LENGTH, `locationDetail must be at least ${MIN_LOCATION_DETAIL_LENGTH} characters long`)
      .max(MAX_LOCATION_DETAIL_LENGTH, `locationDetail must be at most ${MAX_LOCATION_DETAIL_LENGTH} characters long`),
    // Nullable/optional — an event with no `capacity` is uncapped (the
    // capacity-check primitive is a structural no-op for such events; see
    // `events.service.ts`'s capacity-primitive doc-comment).
    capacity: z
      .number()
      .int('capacity must be a whole number')
      .positive('capacity must be a positive number')
      .max(MAX_CAPACITY, `capacity must be at most ${MAX_CAPACITY}`)
      .nullable()
      .optional(),
    ...dormantPaidFieldsShape,
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * `PATCH /admin/events/:id` body — partial update of the event's descriptive/
 * scheduling fields. Mirrors `updatePostSchema`'s shape-and-rationale:
 *   - `slug`/`status` are deliberately absent (dedicated paths — see above).
 *   - `.partial()` + `.refine()`: at least one field must be present.
 *   - The cross-field `endsAt > startsAt` check is re-applied against the
 *     MERGED result by the service (see `updateEvent`'s doc-comment) — a
 *     partial update might supply only one of the two dates, and validating
 *     the partial body in isolation cannot know whether the *resulting* row
 *     would still satisfy the invariant.
 */
export const updateEventSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(MIN_TITLE_LENGTH, `title must be at least ${MIN_TITLE_LENGTH} characters long`)
      .max(MAX_TITLE_LENGTH, `title must be at most ${MAX_TITLE_LENGTH} characters long`),
    description: z
      .string()
      .trim()
      .min(MIN_DESCRIPTION_LENGTH, `description must be at least ${MIN_DESCRIPTION_LENGTH} characters long`),
    startsAt: datesShape.startsAt,
    endsAt: datesShape.endsAt,
    branch: branchSchema,
    locationDetail: z
      .string()
      .trim()
      .min(MIN_LOCATION_DETAIL_LENGTH, `locationDetail must be at least ${MIN_LOCATION_DETAIL_LENGTH} characters long`)
      .max(MAX_LOCATION_DETAIL_LENGTH, `locationDetail must be at most ${MAX_LOCATION_DETAIL_LENGTH} characters long`),
    capacity: z
      .number()
      .int('capacity must be a whole number')
      .positive('capacity must be a positive number')
      .max(MAX_CAPACITY, `capacity must be at most ${MAX_CAPACITY}`)
      .nullable(),
    ...dormantPaidFieldsShape,
  })
  .partial()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.startsAt !== undefined ||
      value.endsAt !== undefined ||
      value.branch !== undefined ||
      value.locationDetail !== undefined ||
      value.capacity !== undefined ||
      value.isPaid !== undefined ||
      value.priceCents !== undefined,
    {
      message:
        'Provide at least one of: title, description, startsAt, endsAt, branch, locationDetail, capacity, isPaid, priceCents',
      path: ['_root'],
    },
  );
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

/**
 * `PATCH /admin/events/:id/slug` body — the dedicated, Admin-only,
 * narrowly-scoped manual-slug-edit path. Identical shape and rationale to
 * Blog's `updateSlugSchema` — see that schema's doc-comment in
 * `blog.schemas.ts` and `events.service.ts`'s "SLUG POLICY" note for why
 * Events follows the exact same "stable at creation, Admin-only manual
 * override" policy.
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
