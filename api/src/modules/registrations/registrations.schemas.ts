/**
 * Zod request-validation schemas for the Registrations module's routes
 * (plan.md Phase 4c), consumed via `validate({ body/params/query: ... })` —
 * mirrors `events.schemas.ts`'s structure and the project-wide
 * "schemas duplicated per module, mirrored by hand in the SPA" convention
 * documented in `middleware/validate.ts`'s file header. The SPA's mirrored
 * copy belongs at `web/src/shared/schemas/registrations.schema.ts` (or
 * `rsvp.schema.ts` per plan.md Phase 6's naming) per that convention.
 */
import { z } from 'zod';

import { MAX_AGE, MIN_AGE } from './registrations.constants';

/** `:slug` route param for `POST /events/:slug/registrations` — identical
 * shape and reasoning to `events.schemas.ts`'s `slugParamSchema` (a bare,
 * non-empty, opaque identifier; stricter shape-checking would only reject
 * "not found" requests slightly earlier, for no benefit). */
export const eventSlugParamSchema = z.object({
  slug: z.string().trim().min(1, 'slug is required'),
});
export type EventSlugParam = z.infer<typeof eventSlugParamSchema>;

/** `:id` route param shared by every staff registrations-list/export route —
 * `Event.id` is `@default(uuid())`, mirroring `eventIdParamSchema`. */
export const eventIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});
export type EventIdParam = z.infer<typeof eventIdParamSchema>;

/** Floor/ceiling for `firstName`/`surname` — short human names. Bounds exist
 * for the same storage/transmission-cost and "guard against an
 * effectively-empty value" reasons named throughout `events.constants.ts`;
 * generous enough for any real name (including multi-part surnames) while
 * catching obvious garbage (`""`, a 5,000-character paste). */
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 100;

/** Ceiling for `phone` — a free-text field (architecture.md doesn't mandate
 * a specific phone format/region — South African numbers, international
 * dialling codes, and the occasional "+27 12 345 6789"-with-spaces formats
 * all need to fit). Bounded generously so a pasted value with stray
 * formatting characters doesn't get rejected on length alone, while still
 * catching obvious abuse (a multi-kilobyte paste into a phone field). No
 * format/regex validation is imposed — over-validating a free-text contact
 * field is a common source of false-rejection frustration for legitimate
 * international numbers, and the architecture brief names no specific format
 * requirement to enforce. */
const MAX_PHONE_LENGTH = 30;

/**
 * `POST /events/:slug/registrations` body — the public RSVP submission.
 *
 * ===========================================================================
 * `age` — POPIA control #8 (architecture.md §7.3 invariant #7)
 * ===========================================================================
 * Validated as an INTEGER in `[MIN_AGE, MAX_AGE]` (`0`–`120`) at THIS exact
 * boundary — the Zod schema, not merely "somewhere in the service" — so a
 * malformed `age` surfaces as a field-level `{ error: { fields: { age: [...] } } }`
 * the form can attach directly to the input via `setError('age', ...)`
 * (architecture.md §8 / plan.md Phase 6's flat-`fields` convention).
 * `z.number().int()` rejects `30.5` outright (a fractional age is never
 * valid for this exact-integer field — see `prisma/schema.prisma`'s comment
 * on why `age` is an `Int`, not a birthdate, by deliberate stakeholder
 * choice); `.min`/`.max` enforce the documented sane bound.
 *
 * ===========================================================================
 * `honeypot` — minimal bot defense (architecture.md §12 / plan.md Phase 4c step 4)
 * ===========================================================================
 * An OPTIONAL, hidden form field a real human visitor never sees or fills
 * (the SPA renders it visually hidden — `display:none`/off-screen
 * positioning/`aria-hidden` — and gives it an innocuous-sounding `name` like
 * `website` or `company` that generic form-filling bots commonly
 * autocomplete). A genuine submission therefore arrives with this field
 * EITHER absent OR an empty string; a non-empty value is the bot tell.
 *
 * DECISION: silently accept-but-discard (NOT reject with a 4xx). Reasoning:
 *   - Rejecting loudly (`badRequest`/`validationError`) teaches an
 *     adversarial bot operator EXACTLY which field tripped the trap and
 *     gives them the specific error response shape to detect and route
 *     around (`if (response.status === 400 && error.fields.honeypot) { ...
 *     stop filling that field ... }`) — actively HELPING them defeat the
 *     defense on their very next attempt.
 *   - A silent 2xx that simply never persists a row is INDISTINGUISHABLE,
 *     from the bot's point of view, from a real submission that succeeded —
 *     there is no signal to learn from, no error shape to adapt to. This is
 *     the textbook "don't tip your hand" posture for a lightweight honeypot
 *     (the same reasoning `BlogService.getPublishedBySlug`'s/
 *     `EventService.getPublishedBySlug`'s "collapse 404 and 403 into one
 *     outcome" anti-enumeration posture applies in spirit: never let a
 *     response shape leak which specific check failed).
 *   - This is genuinely "lightweight" per the brief's own framing — no IP
 *     reputation lists, no CAPTCHA dependency, no third-party service
 *     integration (all explicit non-goals for this small, single-VPS app).
 *     One extra optional field, one `if` in the service, zero new
 *     infrastructure.
 * See `RegistrationService.registerAttendee`'s doc-comment for exactly how
 * "accept but discard" is implemented (a fabricated, non-persisted success
 * response — never a thrown error, never a real `INSERT`).
 *
 * `z.string().trim().max(0)` would be the "tightest" validation — but
 * REJECTING a non-empty honeypot value at the SCHEMA layer would itself be
 * the loud, distinguishing 400 this design explicitly avoids. Instead the
 * schema accepts ANY string (or absence) here, completely permissively —
 * the SERVICE is the layer that inspects it and silently short-circuits,
 * exactly because the service (not the schema) is positioned to fabricate an
 * honest-looking success response rather than a validation failure.
 */
export const createRegistrationSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(MIN_NAME_LENGTH, 'firstName is required')
    .max(MAX_NAME_LENGTH, `firstName must be at most ${MAX_NAME_LENGTH} characters long`),
  surname: z
    .string()
    .trim()
    .min(MIN_NAME_LENGTH, 'surname is required')
    .max(MAX_NAME_LENGTH, `surname must be at most ${MAX_NAME_LENGTH} characters long`),
  age: z
    .number({ message: 'age must be a number' })
    .int('age must be a whole number')
    .min(MIN_AGE, `age must be at least ${MIN_AGE}`)
    .max(MAX_AGE, `age must be at most ${MAX_AGE}`),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('email must be a valid email address')
    .max(254, 'email must be at most 254 characters long'),
  phone: z
    .string()
    .trim()
    .min(1, 'phone is required')
    .max(MAX_PHONE_LENGTH, `phone must be at most ${MAX_PHONE_LENGTH} characters long`),
  // See this schema's file-header "honeypot" doc-comment for the full
  // "accept anything here, let the SERVICE silently discard" reasoning.
  // Optional + permissive by design — a real client never sends it, or
  // sends an empty string; only a bot fills it with something.
  honeypot: z.string().optional(),
});
export type CreateRegistrationInput = z.infer<typeof createRegistrationSchema>;
