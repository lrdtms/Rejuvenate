/**
 * Registrations module router (plan.md Phase 4c steps 4-6).
 *
 * Routes (mounted on the `/api/v1` router — see `app.ts`):
 *   Public:
 *     POST /api/v1/events/:slug/registrations             — RSVP submission
 *                                                            (rate-limited,
 *                                                            honeypot-defended)
 *   Staff (gated `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')`):
 *     GET  /api/v1/admin/events/:id/registrations         — paginated attendee
 *                                                            list + headcount
 *     GET  /api/v1/admin/events/:id/registrations.csv     — full CSV export
 *                                                            (audited)
 *
 * This is the "interface adapter" layer in the router -> service ->
 * repository chain (architecture.md §6 "Clean layering") — mirrors
 * `events.router.ts`'s shape and division of responsibility: it parses/
 * validates HTTP input, translates between Express and `RegistrationService`'s
 * plain-data contract, and shapes responses/status codes/headers. NO domain
 * rules live here — eligibility, the capacity guarantee, the duplicate
 * guard, the honeypot translation, and the export-audit entry are all
 * `RegistrationService`'s job (see that file's extensive doc-comments for
 * the *why* behind each).
 *
 * A factory (`createRegistrationRouter`), not a module-level `router` —
 * mirrors `createEventRouter`'s convention, letting `app.ts` (the
 * composition root) inject the constructed `RegistrationService`/
 * `AuthService` instances.
 *
 * ===========================================================================
 * Why staff routes are gated `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')`
 * — and why there is NO additional per-resource ownership check
 * ===========================================================================
 * Identical reasoning to `events.router.ts`'s "no per-resource ownership
 * check" note: `RegistrationService.listForEvent`/`exportForEvent` delegate
 * their existence/visibility check to `EventService.getForAdmin`, which —
 * per `events.service.ts`'s "EVENT-MANAGER OWNERSHIP" decision — performs
 * NO ownership gate of its own (any Event Manager or Admin may view any
 * event's data). `requireEventStaff` is therefore both necessary AND
 * sufficient here, exactly as it is for `/admin/events/:id*`.
 *
 * Architecture.md §12's "restrict registration data reads/exports to Admin +
 * Event Manager" is honoured precisely by this gate — registration rows are
 * the highest-concentration personal-data resource in this system (full
 * name, age, email, phone, in bulk), and `requireEventStaff` is the ONE
 * place that restriction is enforced for every read/export route below.
 *
 * ===========================================================================
 * Why the public RSVP route is rate-limited AND honeypot-defended
 * ===========================================================================
 * architecture.md §12 names "rate-limit the public RSVP and login endpoints"
 * and "honeypot/lightweight bot defense on RSVP" as explicit, non-negotiable
 * controls. `RSVP_RATE_LIMIT` below mirrors `auth.router.ts`'s
 * `LOGIN_RATE_LIMIT` shape (a small, named, documented `{ windowMs, max }`
 * object) but is tuned to a meaningfully DIFFERENT abuse profile — see that
 * constant's doc-comment for the full reasoning. The honeypot itself is
 * entirely `RegistrationService.registerAttendee`'s concern (see that
 * method's doc-comment "honeypot bot-defense translation" section); this
 * router does nothing more than let the (permissive, by design — see
 * `createRegistrationSchema`'s `honeypot` field doc-comment) field reach the
 * service untouched.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { stringify } from 'csv-stringify/sync';

import { rateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import type { AuthService } from '../auth/auth.service';
import type { RegistrationService } from './registrations.service';
import {
  createRegistrationSchema,
  eventIdParamSchema,
  eventSlugParamSchema,
  type CreateRegistrationInput,
  type EventIdParam,
  type EventSlugParam,
} from './registrations.schemas';

export interface CreateRegistrationRouterOptions {
  authService: AuthService;
  registrationService: RegistrationService;
}

/**
 * RSVP submission rate-limit budget — deliberately LOOSER than
 * `LOGIN_RATE_LIMIT` (10 per 15 minutes), but still a real, named bound.
 *
 * WHY LOOSER THAN LOGIN: login's threat model is credential-stuffing/
 * brute-force — a tight per-IP+email budget is exactly right because a
 * legitimate user essentially never needs more than a handful of login
 * attempts in 15 minutes. RSVP's threat model is different: architecture.md
 * §12 frames it as "bot/spam submission volume," not credential guessing —
 * and the LEGITIMATE traffic shape is meaningfully bursty in a way login's
 * isn't. Consider the realistic scenario this app is built for (architecture.
 * md §3's "small church/community org"): an event announcement goes out to a
 * congregation/mailing list, and a cluster of genuine attendees — a family
 * registering several members from the same household/shared connection,
 * members of the same youth group on the same campus Wi-Fi — submit RSVPs
 * within minutes of each other, very plausibly from the SAME apparent IP
 * (NAT, shared venue/office networks, mobile carriers' shared egress IPs are
 * all common in South Africa). A login-tight budget would actively lock out
 * exactly the legitimate burst this feature exists to handle.
 *
 * `windowMs: 10 * 60_000` (10 minutes), `max: 20` — generous enough to
 * absorb a genuine multi-person household/group burst (and the occasional
 * accidental-resubmission the duplicate-guard separately handles) while
 * still bounding a scripted spam-submission flood to a low, harmless rate
 * (at most 20 attempts per 10-minute window per apparent client — a script
 * trying to flood an event's attendee list, or probe the duplicate-guard's
 * behaviour, makes negligible progress at this rate before the 429s start).
 * Tuned for THIS app's small, low-traffic, single-VPS profile
 * (architecture.md §3/§11) — not copied from login's, because the two
 * endpoints' legitimate-traffic shapes are genuinely different, and a
 * one-size-fits-all budget would under-serve one or over-permit the other.
 */
const RSVP_RATE_LIMIT = { windowMs: 10 * 60_000, max: 20 };

/**
 * `GET /admin/events/:id/registrations` query — extends the shared
 * `paginationQuerySchema` with no module-specific filters (unlike Events'
 * `branch`/`upcoming`/`past`). An attendee list for a SINGLE, already-
 * identified event has no meaningful further slicing dimension this app's
 * admin UI needs (YAGNI — there is no named requirement for "filter
 * attendees by age range/registration date" anywhere in the brief, and
 * inventing one speculatively would be exactly the kind of premature
 * generality the plan warns against). Reusing the bare shared schema keeps
 * this consistent with every other paginated list in the app while adding
 * zero speculative surface area.
 */
const listRegistrationsQuerySchema = paginationQuerySchema;

/** Keeps the staff list-response shape consistent and self-documenting:
 * `{ registrations: <PaginatedResult>, registrationCount }` — mirrors
 * `EventService`'s `{ event, registrationCount }` "registration-count-
 * awareness hook" shape (the SAME underlying number, surfaced through the
 * SAME naming convention, in the place an admin attendee-list view actually
 * needs it: as a headline headcount alongside the paginated rows). */
function listResponse(
  registrations: unknown,
  registrationCount: number,
): { registrations: unknown; registrationCount: number } {
  return { registrations, registrationCount };
}

/**
 * CSV column order and header row — named once, here, so the export's shape
 * is defined in exactly one place (the same "encode the rule once,
 * structurally" discipline `events.service.ts`'s `ALLOWED_TRANSITIONS` table
 * documents). Deliberately OMITS `id`/`eventId`/`consentVersion`/
 * `retainUntil` — an admin planning catering/seating from this export needs
 * the registrant-facing fields; internal bookkeeping columns would only add
 * noise to a document whose entire purpose is "a list of names and contact
 * details a human reads." (Those internal fields remain fully available via
 * the JSON list endpoint and the database itself for any future operational/
 * compliance need — this is purely an export-shape decision, not a data-
 * retention one.)
 */
const CSV_COLUMNS: ReadonlyArray<{ key: string; header: string }> = [
  { key: 'firstName', header: 'First name' },
  { key: 'surname', header: 'Surname' },
  { key: 'age', header: 'Age' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'registeredAt', header: 'Registered at' },
];

export function createRegistrationRouter(options: CreateRegistrationRouterOptions): Router {
  const { authService, registrationService } = options;
  const router = Router();

  // The single shared role gate for every staff registrations route — named
  // once for the identical "avoid copy-pasted-and-drifted gates" reason
  // `events.router.ts`'s `requireEventStaff` exists. Deliberately the SAME
  // role pair as Events' gate (architecture.md §12's "restrict registration
  // data reads/exports to Admin + Event Manager" — the identical pair the
  // RBAC matrix names for managing the events those registrations belong to).
  const requireRegistrationStaff = requireRole(authService, 'ADMIN', 'EVENT_MANAGER');

  // -------------------------------------------------------------------------
  // POST /events/:slug/registrations — public RSVP submission
  //
  // Order matters: rate-limit FIRST (cheapest possible rejection for a
  // flooding client — mirrors `auth.router.ts`'s `/auth/login` ordering),
  // THEN validate (so a malformed body from a client who's within budget
  // gets a normal `VALIDATION_ERROR`, not a confusing 429), THEN the
  // service (which owns every remaining domain decision).
  // -------------------------------------------------------------------------
  router.post(
    '/events/:slug/registrations',
    rateLimiter({
      ...RSVP_RATE_LIMIT,
      message: 'Too many registration attempts from this connection — please try again later',
    }),
    validate({ params: eventSlugParamSchema, body: createRegistrationSchema }),
    (
      req: Request<EventSlugParam, unknown, CreateRegistrationInput>,
      res: Response,
      next: NextFunction,
    ) => {
      registrationService
        .registerAttendee(req.params.slug, req.body)
        .then((result) => {
          res.status(201).json(result);
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/events/:id/registrations — paginated attendee list + headcount
  // -------------------------------------------------------------------------
  router.get(
    '/admin/events/:id/registrations',
    requireRegistrationStaff,
    validate({ params: eventIdParamSchema, query: listRegistrationsQuerySchema }),
    (req: Request<EventIdParam>, res: Response, next: NextFunction) => {
      const query = req.query as unknown as PaginationQuery;

      registrationService
        .listForEvent(req.user!, req.params.id, query)
        .then(({ registrations, registrationCount }) => {
          res.status(200).json(listResponse(registrations, registrationCount));
        })
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // GET /admin/events/:id/registrations.csv — full CSV export (audited)
  //
  // ===========================================================================
  // CSV correctness — a REAL CSV-writing library, never string-templated rows
  // ===========================================================================
  // `csv-stringify/sync` (added as a dependency specifically for this route —
  // see this module's `package.json` entry) handles RFC 4180 quoting/escaping
  // correctly: a `surname` containing a comma (`"Smith, Jr."`), a `firstName`
  // containing a double-quote (`Sam "Sammy" Jones`), or any field containing
  // an embedded newline — all routinely-occurring real personal-name shapes —
  // are quoted and escaped per spec, producing a file that opens cleanly in
  // Excel/Numbers/Google Sheets without corrupting column boundaries. A
  // naive `rows.map(r => r.join(',')).join('\n')` would silently produce a
  // BROKEN file for any of those inputs — exactly the "never string-template
  // rows" instruction this brief names explicitly, and exactly the kind of
  // bug that looks fine in a quick manual test (whoever tests it types a
  // name without a comma) and then corrupts a real export the first time a
  // "Smith, Jr." or "O'Brien" registrant's actual data reaches it.
  //
  // `stringify(..., { columns, header: true })` — the synchronous form
  // (`csv-stringify/sync`) is the right choice here: this app's "small,
  // low-traffic, single-VPS" attendee-list sizes (architecture.md §3 — at
  // most a few hundred rows for even the most popular event) make streaming
  // pure overhead; building the complete string in memory and sending it in
  // one `res.send(...)` is simpler, easier to reason about, and trivially
  // testable end-to-end without wiring up stream-assertion machinery for a
  // problem this app's scale doesn't have.
  //
  // ===========================================================================
  // Headers — `Content-Type`/`Content-Disposition`
  // ===========================================================================
  // `Content-Type: text/csv; charset=utf-8` names both the format AND the
  // encoding explicitly (personal names routinely contain non-ASCII
  // characters — accents, etc. — and an unspecified charset risks a
  // mojibake'd download in some clients).
  // `Content-Disposition: attachment; filename="..."` triggers a download
  // (rather than an in-browser render) with a human-meaningful filename
  // derived from the event's title and the export date — `slugify`-style
  // sanitization keeps it filesystem-safe across Windows/macOS/Linux
  // (no `/`, `\`, `:`, quotes, etc.) without pulling in Blog's `slugify`
  // helper for what is, here, a one-off filename-sanitization need (a
  // dedicated, narrowly-scoped regex is simpler and avoids a cross-module
  // import for a transformation with subtly different requirements —
  // filenames tolerate characters slugs don't, and vice versa).
  // -------------------------------------------------------------------------
  router.get(
    '/admin/events/:id/registrations.csv',
    requireRegistrationStaff,
    validate({ params: eventIdParamSchema }),
    (req: Request<EventIdParam>, res: Response, next: NextFunction) => {
      registrationService
        .exportForEvent(req.user!, req.params.id)
        .then(({ event, registrations }) => {
          const rows = registrations.map((registration) => ({
            firstName: registration.firstName,
            surname: registration.surname,
            age: registration.age,
            email: registration.email,
            phone: registration.phone,
            registeredAt: registration.registeredAt.toISOString(),
          }));

          const csv = stringify(rows, { columns: [...CSV_COLUMNS], header: true });

          const datePart = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
          const safeTitle = event.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80);
          const filename = `registrations-${safeTitle || event.id}-${datePart}.csv`;

          res.status(200);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.send(csv);
        })
        .catch(next);
    },
  );

  return router;
}
