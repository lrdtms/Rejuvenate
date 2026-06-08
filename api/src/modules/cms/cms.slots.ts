/**
 * The fixed CMS slot registry (plan.md Phase 4d step 1 — "the single most
 * important file for ADR-0007 compliance").
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS — ADR-0007 / architecture.md §7.3 invariant #8
 * ===========================================================================
 * `CMSContent` is FIXED NAMED SLOTS, never a generic page-builder (ADR-0007).
 * The API must reject writes to any `slotKey` outside this registry. This
 * const array IS that allow-list — `CmsService.updateSlot` checks every write
 * against it via `findRegisteredSlot`/`isRegisteredSlot` below, and throws
 * `unknownSlot()` (see `lib/errors.ts`) for anything that isn't here.
 *
 * ===========================================================================
 * SINGLE SOURCE OF TRUTH — and the deliberate, documented risk of NOT fully
 * collapsing it with `prisma/seed.ts`
 * ===========================================================================
 * `prisma/seed.ts` ALSO defines a `CMS_SLOTS` array describing the same six
 * rows (`slotKey` + `format` + an initial `value`). These two lists currently
 * live separately rather than one importing the other. That is a conscious
 * choice, not an oversight — but it DOES carry a real drift risk, named here
 * explicitly so a future reader doesn't have to rediscover it:
 *
 *   - Why not have the seed import from here? `prisma/seed.ts` is run via
 *     `tsx prisma/seed.ts` — OUTSIDE the compiled `api/dist` output, against
 *     the Prisma-generated `CMSFormat` enum from `@prisma/client`. Reaching
 *     from `prisma/` back into `src/modules/cms/` would create a dependency
 *     edge from the database-tooling layer into application code — a layering
 *     inversion `architecture.md §6` doesn't otherwise have anywhere (the
 *     seed script is meant to be a standalone, infrastructure-adjacent tool
 *     that can run before/independent of the application even building). It
 *     would also coni a `value: ''` field this registry intentionally does
 *     NOT carry (see "no `value` field" note below) — the two lists describe
 *     overlapping but not identical concerns.
 *   - The mitigated risk: both lists are SMALL (six entries), CHANGE RARELY
 *     (a new CMS slot is a deliberate, reviewed, additive product decision —
 *     not a routine edit), and a drift between them fails LOUDLY and
 *     IMMEDIATELY in an obvious place: `cms.slots.test.ts` below asserts this
 *     registry's `slotKey`s match the `CMS_SLOTS` keys seeded in
 *     `prisma/seed.ts` 1:1 (same set, same `format`s) — see that file's
 *     "registry/seed parity" describe block. A drift is therefore caught by
 *     `npm test`, not discovered in production months later. This is the
 *     same "small + rarely-changes + a fitness-function test closes the gap"
 *     posture `architecture.md §15` recommends for `MediaAsset` referential
 *     integrity (ADR-0005) — a parallel, well-precedented pattern in this
 *     codebase, not a novel risk.
 *   - If this registry and the seed ever need to grow past "six slots that
 *     rarely change," collapsing them behind one shared, `tsx`-compatible
 *     module (e.g. moving the canonical list to a `.ts` file under `prisma/`
 *     that both import) would be the right refactor — but doing that NOW,
 *     for six entries, would be exactly the kind of speculative tooling the
 *     YAGNI guidance in this project warns against.
 *
 * ===========================================================================
 * Why no `value` field here (unlike the seed's `CMS_SLOTS`)
 * ===========================================================================
 * This registry answers "which `slotKey`s are valid, and what `format` does
 * each one use" — a STATIC, code-level fact the service checks writes
 * against. It deliberately does NOT carry an initial/default `value` —
 * that's a SEEDING concern (what does a freshly-migrated database contain?),
 * not a REGISTRY concern (what counts as a valid write target?). Conflating
 * the two would tempt a future reader into writing `getSlot` as "look it up
 * here, fall back to the database" — exactly the kind of dual-source-of-truth
 * confusion `getSlot`'s "registered-but-unpopulated -> safe empty default"
 * contract (see `cms.service.ts`) is designed to avoid by routing ALL reads
 * through the database, every time, with the registry used ONLY to validate
 * that a requested/written key is legitimate.
 */
import type { CMSFormat } from '@prisma/client';

/** A single registry entry: the slot's permanent identity (`slotKey`) and
 * the rich-text-vs-plain-text rendering/sanitization contract (`format`)
 * that governs how `CmsService.updateSlot` treats writes to it. */
export interface CmsSlotDefinition {
  slotKey: string;
  format: CMSFormat;
}

/**
 * THE fixed slot registry — exactly the six named slots the public About and
 * Contact pages render (architecture.md §7.2 / plan.md Phase 1 step 4 /
 * Phase 6 step 1's slot-to-page mapping). Order is presentation-irrelevant
 * (the registry is consulted by key, via `findRegisteredSlot`/`SLOT_KEYS`
 * below — never iterated for display order); listed here grouped by owning
 * page purely for human readability when reviewing/extending this list.
 *
 * Do not add, remove, or rename a slot here without ALSO updating
 * `prisma/seed.ts`'s `CMS_SLOTS` (and, ideally, in the same commit, running
 * the seed against every environment) — see the file-header "single source
 * of truth" note for the full reasoning and the test that catches drift.
 *
 * All six are currently `PLAIN_TEXT`. `RICH_TEXT` is a fully-supported format
 * in this registry's type and the service's sanitization branch — simply not
 * exercised by any of today's six slots. A future slot that needs bold/
 * italic/line-break formatting (architecture.md §9.5's "tiny" CMS rich-text
 * ceiling — see `CMS_RICH_TEXT_ALLOW_LIST` in `lib/sanitizeHtml.ts`) is a
 * one-line addition here plus a migration/seed entry — not a structural
 * change to this module.
 */
export const CMS_SLOTS: readonly CmsSlotDefinition[] = [
  // --- About page cards (architecture.md §2/§27 "hollowed-out" .card blocks) ---
  { slotKey: 'about.card.who-are-we', format: 'PLAIN_TEXT' },
  { slotKey: 'about.card.what-we-do', format: 'PLAIN_TEXT' },
  { slotKey: 'about.card.get-involved', format: 'PLAIN_TEXT' },

  // --- Location-contact cards (Cape Town / Durban) ---
  { slotKey: 'contact.capeTown.card', format: 'PLAIN_TEXT' },
  { slotKey: 'contact.durban.card', format: 'PLAIN_TEXT' },

  // --- Contact page "Reach Out" / page-details card ---
  { slotKey: 'contact.page.details', format: 'PLAIN_TEXT' },
] as const;

/** Flat set of valid `slotKey`s, derived from `CMS_SLOTS` — the O(1)
 * membership check `isRegisteredSlot`/`findRegisteredSlot` are built on.
 * Derived (not hand-duplicated) so this can never drift from `CMS_SLOTS`
 * itself — the one and only list a reviewer needs to edit to add/remove a
 * slot. */
const SLOT_KEY_SET: ReadonlySet<string> = new Set(CMS_SLOTS.map((slot) => slot.slotKey));

/** Returns the registry entry for `slotKey`, or `undefined` if it is not a
 * recognized slot. The single lookup primitive `CmsService` uses to answer
 * BOTH "is this key valid at all?" (presence) AND "what `format` governs
 * it?" (the entry's `format`) — one lookup serves both questions, so a
 * service method can never accidentally check one without the other. */
export function findRegisteredSlot(slotKey: string): CmsSlotDefinition | undefined {
  return CMS_SLOTS.find((slot) => slot.slotKey === slotKey);
}

/** `true` iff `slotKey` is a member of the fixed registry. A thin, named
 * predicate over `SLOT_KEY_SET` for call sites that only need a yes/no
 * answer (e.g. the batch-fetch endpoint's "is this requested key even worth
 * looking up?" decision — see `cms.service.ts`'s `getSlots` doc-comment for
 * the documented "out-of-registry batch key" handling decision). */
export function isRegisteredSlot(slotKey: string): boolean {
  return SLOT_KEY_SET.has(slotKey);
}
