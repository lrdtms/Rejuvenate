/**
 * Request-validation middleware factory (plan.md Phase 2 step 4).
 *
 * `validate({ body?, params?, query? })` parses the named request part(s) with the
 * given Zod schema(s), replaces `req.<part>` with the *parsed* result (so coercions/
 * defaults from `z.coerce`/`.default()` reach the route handler — see `env.ts` for the
 * established `z.coerce` convention this mirrors), and calls `next()`. On failure it
 * converts the resulting `ZodError`(s) into the `Record<string, string[]>` shape
 * `validationError()` expects and forwards that to `next(err)` — relying entirely on
 * the central error handler in `app.ts` to produce the agreed
 * `{ error: { code: 'VALIDATION_ERROR', message, fields } }` response. This file does
 * NOT build a parallel error-response mechanism; see `lib/errors.ts`.
 *
 * ---------------------------------------------------------------------------
 * Design decisions
 * ---------------------------------------------------------------------------
 *
 * 1. Aggregate, don't short-circuit: if `body`, `params`, AND `query` schemas are all
 *    provided and all three fail, every issue from all three is merged into ONE
 *    `fields` map and a SINGLE `validationError` is thrown. This costs nothing extra
 *    here (each part is independent — there's no "params must be valid before body is
 *    even checked" dependency in this codebase's routes) and saves API consumers
 *    (including the SPA's RHF-driven forms) a wasted round trip: fix the body issues,
 *    resubmit, only to be told the query was *also* wrong. One response, every
 *    problem — see architecture.md §8 / Phase 6's note that `fields` should be a flat
 *    map keyed by field name so it maps directly onto `setError`.
 *
 *    A theoretical collision (e.g. both `params` and `body` define a field named
 *    `id`) would overwrite in the merged map — acceptable: this app's route schemas
 *    don't share field names across parts (params carry route identifiers like
 *    `slug`/`id`; bodies carry domain fields like `email`/`age`), so the collision
 *    case doesn't arise in practice and isn't worth designing around speculatively.
 *
 * 2. Path-to-field-key mapping: a Zod issue's `path` (e.g. `['age']` or, for a nested
 *    object, `['registrant', 'age']`) is joined with `.` to form the `fields` map key
 *    (`'age'` / `'registrant.age'`). An empty path (a whole-schema-level issue, e.g.
 *    `z.object({...}).refine(...)` failing at the root) maps to the key `'_root'` so
 *    it's never silently dropped from the map.
 *
 * ---------------------------------------------------------------------------
 * Shared-Zod-schema-location convention (the other half of plan.md Phase 2 step 4)
 * ---------------------------------------------------------------------------
 *
 * DECISION: schemas are DUPLICATED per module, not published/shared via a copy-step.
 *
 *   - Each backend module keeps its request-validation schemas in
 *     `api/src/modules/<module>/<module>.schemas.ts` (e.g.
 *     `modules/registrations/registrations.schemas.ts` exporting
 *     `createRegistrationSchema`), imported by that module's router via `validate()`
 *     and re-used by its service where the same shape constraints apply
 *     (e.g. the `age` 0–120 integer bound).
 *   - The SPA mirrors the same shape BY HAND in `web/src/shared/schemas/*.schema.ts`
 *     (see plan.md Phase 6's `rsvp.schema.ts` critical-file entry) — there is no
 *     published npm package, no build-time copy step, and no monorepo path-alias
 *     reaching across `api/`→`web/`.
 *
 * WHY duplicate over shared/published, explicitly:
 *   - This is a solo-operator, single-repo, small-surface-area project (architecture.md
 *     §3's Conway's-Law framing) — the number of validated shapes that need mirroring
 *     is small and stable (RSVP fields, login, a handful of admin forms). A publish/
 *     copy pipeline is real infrastructure (versioning, build wiring, drift-detection
 *     tooling of its own) to solve a problem this project doesn't have at its current
 *     or foreseeable scale — exactly the kind of speculative tooling the plan/YAGNI
 *     guidance warns against ("no build-step scaffolding").
 *   - `api/` and `web/` are independent npm projects with separate lockfiles
 *     (Phase 0 decision) — there is no existing workspace boundary a shared package
 *     would slot into cleanly; adding one purely to share Zod schemas would be a much
 *     larger structural change than the problem warrants.
 *   - The drift risk is real but small and cheap to manage by convention: the
 *     authoritative shape is always the BACKEND schema (the server is the actual
 *     security/validation boundary — see architecture.md §12 "validate ALL personal
 *     data input server-side regardless of client validation"). The SPA's copy is a
 *     UX nicety (fast inline feedback before a round trip); if it drifts, the worst
 *     case is a client-side check that's slightly looser/stricter than the server's,
 *     and the server's `fields` errors still surface correctly via `setError` either
 *     way (Phase 6's flat-`fields` decision exists precisely so server-side errors
 *     slot into the same UI path as client-side ones without special-casing).
 *   - When a shape changes, the convention is: update the backend `.schemas.ts` file
 *     first (it's the enforced boundary), then mirror the change in the SPA's copy in
 *     the same commit/PR — a one-line code-review checklist item, not a tooling
 *     problem to solve.
 *
 * Phase 4 module authors: create `<module>.schemas.ts` alongside your router/service/
 * repository, export your Zod schemas from it, and pass them to `validate()` per-route.
 * Don't reach for a shared-schemas package — that ship has explicitly not sailed.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

import { validationError } from '../lib/errors';

/** Which request part(s) to validate — at least one must be provided. */
export interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

const REQUEST_PARTS = ['body', 'params', 'query'] as const;
type RequestPart = (typeof REQUEST_PARTS)[number];

/** Joins a Zod issue's `path` into a flat `fields`-map key (see file-header note 2). */
function fieldKey(path: ZodError['issues'][number]['path']): string {
  if (path.length === 0) {
    return '_root';
  }
  return path.map(String).join('.');
}

/** Merges a `ZodError`'s issues into an existing `fields` accumulator, in place. */
function mergeZodError(target: Record<string, string[]>, error: ZodError): void {
  for (const issue of error.issues) {
    const key = fieldKey(issue.path);
    const existing = target[key];
    if (existing) {
      existing.push(issue.message);
    } else {
      target[key] = [issue.message];
    }
  }
}

/**
 * Express middleware factory: validates the configured request part(s) against their
 * Zod schemas, replaces each part with its parsed (coerced/defaulted) result on
 * success, and forwards an aggregated `validationError` on failure.
 *
 * Usage:
 *   router.post('/events/:slug/registrations',
 *     validate({ params: slugParamSchema, body: createRegistrationSchema }),
 *     (req, res) => { ... } // req.params/req.body are now the *parsed* shapes
 *   );
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const fields: Record<string, string[]> = {};
    // Parsed results are staged here and only written back to `req` once every
    // configured part has succeeded — so a failing `query` doesn't leave `req.body`
    // half-replaced with a parsed value while the request is ultimately rejected.
    const parsed: Partial<Record<RequestPart, unknown>> = {};

    for (const part of REQUEST_PARTS) {
      const schema = schemas[part];
      if (!schema) {
        continue;
      }

      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        mergeZodError(fields, result.error);
      }
    }

    if (Object.keys(fields).length > 0) {
      next(validationError(fields));
      return;
    }

    if (parsed.body !== undefined) {
      req.body = parsed.body;
    }
    if (parsed.params !== undefined) {
      req.params = parsed.params as Request['params'];
    }
    if (parsed.query !== undefined) {
      req.query = parsed.query as Request['query'];
    }

    next();
  };
}
