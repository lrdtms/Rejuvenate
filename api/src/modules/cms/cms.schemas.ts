/**
 * Zod request-validation schemas for the CMS module's routes (plan.md
 * Phase 4d), consumed via `validate({ body/params/query: ... })` — see
 * `middleware/validate.ts`'s file-header doc-comment for the project-wide
 * "schemas are duplicated per module, mirrored by hand in the SPA"
 * convention. The SPA's mirrored copy would live at
 * `web/src/shared/schemas/cms.schema.ts` per that convention.
 */
import { z } from 'zod';

import { MAX_BATCH_KEYS, MAX_SLOT_VALUE_LENGTH } from './cms.constants';

/**
 * `:slotKey` route param — shared by `GET/PUT /admin/cms/:slotKey`.
 *
 * Deliberately a bare non-empty string, NOT validated against the registry's
 * shape/character set here: `slotKey` is a developer-defined dotted
 * identifier (`about.card.who-are-we`), and the REAL "is this a legitimate
 * slot?" check is the registry membership check in `CmsService` (which
 * produces the named `unknownSlot()` error the plan calls for — a much more
 * informative response than a generic 400 "doesn't match this regex"). This
 * mirrors `blog.schemas.ts`'s `slugParamSchema` reasoning verbatim: validating
 * shape here would only reject "not a registered slot" requests slightly
 * earlier, with a less specific error, for no real benefit.
 */
export const slotKeyParamSchema = z.object({
  slotKey: z.string().trim().min(1, 'slotKey is required'),
});
export type SlotKeyParam = z.infer<typeof slotKeyParamSchema>;

/**
 * `PUT /admin/cms/:slotKey` body — the single field this narrowly-scoped
 * write path accepts. Deliberately does NOT accept `format` (the format is
 * an immutable property of the registered slot — see `cms.slots.ts` — never
 * a per-write choice; accepting it here would let a client silently change
 * how a slot's value is sanitized/rendered without a reviewed registry
 * change) or `slotKey` (the route param is authoritative; a body field that
 * could disagree with it would be a confusing, redundant surface).
 *
 * `MAX_SLOT_VALUE_LENGTH` mirrors `MAX_TITLE_LENGTH`'s "named, reviewed
 * ceiling on a `@db.Text` column" reasoning — see that constant's doc-comment
 * in `cms.constants.ts`. No `.min()` floor: an admin clearing a card back to
 * empty (e.g. "we're rewriting this section, blank it for now") is a
 * legitimate, intentional action — `value: ''` is exactly the registry's own
 * seeded "not yet written" convention (see `prisma/seed.ts`), not an error
 * state to reject.
 */
export const updateSlotSchema = z.object({
  value: z
    .string()
    .max(MAX_SLOT_VALUE_LENGTH, `value must be at most ${MAX_SLOT_VALUE_LENGTH} characters long`),
});
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;

/**
 * `GET /cms?keys=a,b,c` query — the public, batched read endpoint (plan.md
 * Phase 4d step 3 / the Frontend Review Note's explicit contract: a single
 * comma-separated `keys` param, never an array-of-`keys[]` repeated-param
 * shape, matching `useCmsSlots(keys: string[]).join(',')`'s natural
 * serialization and every other query-string convention this API uses).
 *
 * Transformation pipeline, in order:
 *   1. `min(1)` — an empty `?keys=` is almost certainly a client bug (the
 *      batch contract exists precisely so a page asks for ITS keys; asking
 *      for none is not a meaningful request) — reject early with a clear
 *      `VALIDATION_ERROR` rather than silently returning `{}`.
 *   2. Split on `,`, trim each segment, drop empties (defends against
 *      `?keys=a,,b` / `?keys=a,` typos producing a phantom `''` key that
 *      would otherwise round-trip through `isRegisteredSlot('')` ->
 *      `false` -> get silently omitted, confusing a client who's debugging
 *      "why is my third key missing").
 *   3. De-duplicate (a client requesting the same key twice — e.g. the
 *      Contact page composing two components that both need
 *      `contact.page.details` — should get ONE map entry, not waste a
 *      lookup; `Set` -> `Array.from` preserves first-seen order, which is
 *      presentation-irrelevant for a map response anyway).
 *   4. Bound by `MAX_BATCH_KEYS` — see that constant's doc-comment for why
 *      this is a real, meaningful ceiling despite the registry's small size.
 *
 * Returns a `string[]` — `cms.service.ts`'s `getSlots` is the layer that
 * decides what to do with a key that ISN'T in the registry (see that
 * method's doc-comment for the documented decision); this schema's job ends
 * at "produce a clean, bounded, de-duplicated list of requested key strings."
 */
export const cmsBatchQuerySchema = z.object({
  keys: z
    .string()
    .trim()
    .min(1, 'keys is required (comma-separated slot keys, e.g. ?keys=a,b,c)')
    .transform((raw, ctx) => {
      const seen = new Set<string>();
      const result: string[] = [];

      for (const segment of raw.split(',')) {
        const trimmed = segment.trim();
        if (trimmed.length === 0) {
          continue;
        }
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          result.push(trimmed);
        }
      }

      if (result.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'keys must contain at least one non-empty slot key',
        });
        return z.NEVER;
      }

      if (result.length > MAX_BATCH_KEYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `keys must contain at most ${MAX_BATCH_KEYS} distinct slot keys`,
        });
        return z.NEVER;
      }

      return result;
    }),
});
export type CmsBatchQuery = z.infer<typeof cmsBatchQuerySchema>;
