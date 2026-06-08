/**
 * `CmsService` (plan.md Phase 4d step 2) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly: registry-membership enforcement
 * (`unknownSlot` rejection — ADR-0007), format-aware sanitization
 * (`richText` -> `sanitizeCmsRichText`; `plainText` -> stored as-is, escaped
 * on render by the SPA), the "registered-but-unpopulated -> safe empty
 * default" read contract (both single and batch), and `lastEditedById`
 * stamping.
 *
 * Constructed via a factory (`createCmsService({ repository })`) — the same
 * dependency-injection convention as `createBlogService`/
 * `createRegistrationService`.
 *
 * ===========================================================================
 * DECISION RECORD — `getSlot`'s contract for a registered-but-unpopulated slot
 * ===========================================================================
 * plan.md Phase 4d step 2 names this as an open decision and recommends:
 * "the registry and the seed are committed together... AND `getSlot` returns
 * a safe empty-string default for a registered-but-unpopulated slot (never a
 * hard error on the public read path)." This service implements EXACTLY
 * that — for BOTH `getSlot` (single) and `getSlots` (batch):
 *
 *   - "Registered-but-unpopulated" means: `slotKey` IS in `CMS_SLOTS` (so it
 *     is a legitimate, known slot the frontend is entitled to ask about) but
 *     NO `CMSContent` row exists for it yet (e.g. immediately post-migration
 *     before the seed runs, or a new slot was added to the registry but its
 *     seed/migration hasn't shipped to this environment yet).
 *   - For that case, `getSlot`/`getSlots` synthesize a SAFE EMPTY default:
 *     `{ format: <from the registry>, value: '', updatedAt: null }` — never
 *     `null`, never a 404, never a thrown error. The public About/Contact
 *     pages (Phase 6) render this as "no copy yet" (an empty card body),
 *     which is a perfectly normal, non-broken state for a freshly-deployed
 *     site — NOT a bug to surface as an error.
 *   - `format` is sourced from the REGISTRY (not guessed/defaulted) — the
 *     registry is the authoritative source for "what kind of content does
 *     this slot hold," independent of whether a row happens to exist yet.
 *     This also means a `richText` slot's safe-empty default correctly
 *     reports `format: 'RICH_TEXT'` (an empty string sanitizes to an empty
 *     string either way, but reporting the wrong format would mislead a
 *     renderer/editor about how to TREAT a future non-empty value).
 *   - `updatedAt: null` (rather than, say, `new Date(0)` or "now") is the
 *     honest signal "this slot has never been written" — a renderer that
 *     cares about staleness (the admin `SlotEditor`'s "last edited X ago"
 *     display, perhaps) gets a clean, unambiguous "never" rather than a
 *     fabricated timestamp it would have to special-case anyway.
 *   - For "`slotKey` is NOT in the registry at all," `getSlot` throws
 *     `unknownSlot()` — there is no "safe empty default" for a key the
 *     system doesn't recognize; that is categorically a different situation
 *     (a caller asking about something that structurally cannot exist) from
 *     "a real, recognized slot simply hasn't been written to yet." This
 *     mirrors `getSlots`' "unrecognized batch key" handling (see that
 *     method's doc-comment) in spirit, but the SINGLE-slot admin path
 *     (`GET /admin/cms/:slotKey`) has a natural, named error to throw where
 *     the BATCH path's "never omit, never crash the renderer" contract does
 *     not.
 *
 * ===========================================================================
 * Why no in-memory TTL response cache (the plan's "consider caching" note)
 * ===========================================================================
 * plan.md Phase 4d step 3 explicitly flags response caching as a
 * "consider... but use your judgment" item, and names the YAGNI tension
 * directly: "don't over-engineer a caching layer for a six-slot table that
 * Postgres will serve in <1ms anyway." DECISION: skip it for v1, for three
 * concrete reasons specific to THIS table's actual shape:
 *
 *   1. The entire `cms_content` table is six rows, each holding at most
 *      `MAX_SLOT_VALUE_LENGTH` (10,000) characters of `@db.Text` — Postgres
 *      serves `findMany({ where: { slotKey: { in: [...] } } })` against a
 *      `@unique`-indexed column over a table this size in well under a
 *      millisecond on the local-loopback Postgres this app runs against
 *      (architecture.md §11's single-VPS topology — no network hop to a
 *      remote DB). There is no latency problem here for a cache to solve.
 *   2. A cache is not a free correctness no-op — it is a NEW invalidation
 *      contract (`updateSlot` must remember to invalidate; a missed/buggy
 *      invalidation path produces the exact "I edited the card and the
 *      public page still shows the old copy" support ticket that would
 *      erode trust in the admin UI's WYSIWYG promise architecture.md §9.5
 *      explicitly cares about), a new piece of in-process state to reason
 *      about in tests, and — on a system that may eventually run more than
 *      one Node process (PM2 cluster mode is mentioned as an option in
 *      architecture.md §11, even if not the current default) — a
 *      cross-process staleness hazard an in-memory cache cannot solve
 *      without a second piece of infrastructure (pub/sub invalidation, a
 *      shared cache store) that this app explicitly has no other need for.
 *   3. CMS content changes are RARE and ADMIN-INITIATED (not high-frequency
 *      public writes) — exactly the profile where Postgres's own shared
 *      buffer cache already does this job for free, correctly, with zero
 *      additional code, and with automatic, instant consistency on write.
 *
 * If a future profiling pass on the deployed VPS ever shows `/cms` requests
 * as a measurable load contributor (which, per point 1, would itself be a
 * surprising finding), the RIGHT fast-follow is `Cache-Control` response
 * headers (the plan's other named option) — a stateless, infrastructure-
 * level solution (Nginx can even serve from cache directly, per
 * architecture.md §11's reverse-proxy role) that sidesteps EVERY concern in
 * point 2 above. That is a clearly-scoped, easy-to-add-later change; building
 * an in-memory TTL cache now, for a table this small, would be solving a
 * problem this deployment doesn't have at the cost of a new correctness
 * surface it would definitely have.
 */
import type { CMSContent, CMSFormat } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.service';
import { unknownSlot } from '../../lib/errors';
import { sanitizeCmsRichText } from '../../lib/sanitizeHtml';
import type { CmsRepository } from './cms.repository';
import { findRegisteredSlot, isRegisteredSlot, type CmsSlotDefinition } from './cms.slots';

export interface CmsServiceOptions {
  repository: CmsRepository;
}

/**
 * The shape every read path returns for a single slot — whether backed by a
 * real `CMSContent` row or synthesized as a "registered-but-unpopulated"
 * safe-empty default (see this file's decision-record header). Deliberately
 * matches the Frontend Review Note's documented per-key shape verbatim
 * (`{ format, value, updatedAt }`) — `getSlot` and `getSlots` both return
 * THIS shape (a single slot, and a map of these, respectively) so the SPA's
 * `useCmsSlots` hook and `CmsSlot` component have exactly ONE per-slot shape
 * to render, regardless of which endpoint produced it (public batch, or the
 * admin single-slot `GET`/`PUT` — see `cms.router.ts`'s "one shape, three
 * routes" framing).
 */
export interface CmsSlotView {
  slotKey: string;
  format: CMSFormat;
  value: string;
  /** `null` for a registered-but-unpopulated slot that has never been
   * written (see decision-record header for why `null`, not a fabricated
   * timestamp, is the honest signal here); an ISO-serializable `Date`
   * otherwise — `Date`, not a pre-formatted string, mirrors every other
   * service-layer return shape in this codebase (`BlogPost.publishedAt`,
   * `Registration.registeredAt`, etc.) and lets the router's `res.json(...)`
   * perform the one, consistent ISO-8601 serialization Express's JSON body
   * writer already does for every `Date` in a response. */
  updatedAt: Date | null;
}

/** Batch-fetch result: a map keyed by `slotKey`, with EVERY requested
 * (registry-recognized) key present — see `getSlots`'s doc-comment for the
 * full "every requested key present, never omitted" contract this type
 * exists to make structurally visible at the type level. */
export type CmsSlotMap = Record<string, CmsSlotView>;

export interface CmsService {
  /**
   * Single-slot lookup for the admin `SlotEditor` (`GET /admin/cms/:slotKey`).
   * Throws `unknownSlot()` for a `slotKey` outside the registry (there is no
   * "safe empty default" for a key the system does not recognize — see the
   * file-header decision record's "categorically different" framing); returns
   * a synthesized safe-empty `CmsSlotView` for a registered-but-unpopulated
   * slot; returns the real row's view otherwise. NEVER 404s for a registered
   * key — that would contradict the very "never crash on a missing slot"
   * contract this method exists to provide for the editor that will,
   * immediately after load, offer to WRITE that slot's first-ever value.
   */
  getSlot(slotKey: string): Promise<CmsSlotView>;

  /**
   * Batched public read (`GET /cms?keys=a,b,c`) — see this method's
   * implementation-site doc-comment for the full "every requested key
   * present; out-of-registry keys omitted" contract and rationale. Also the
   * read path the admin `SlotEditor` reuses for its single-key fetch (the
   * Frontend Review Note's "one hook, one contract, two consumers" framing —
   * see `cms.router.ts` for where the admin `GET` route delegates here vs.
   * to `getSlot`).
   */
  getSlots(slotKeys: readonly string[]): Promise<CmsSlotMap>;

  /**
   * The single write path (`PUT /admin/cms/:slotKey`, Admin-only — see
   * `cms.router.ts`'s RBAC gating note). Rejects unknown `slotKey`s via
   * `unknownSlot()` — re-validated HERE, not merely trusted from the router
   * (defense in depth: a future caller of this service that bypasses the
   * router must not be able to write an out-of-registry row, exactly the
   * "never trust that the router's validation is the only gate" posture
   * `BlogService.setSlug`'s doc-comment names explicitly).
   *
   * Sanitizes by FORMAT — the one rule this entire module exists to enforce
   * correctly (architecture.md §9.5 / §12.1.9):
   *   - `RICH_TEXT`: passed through `sanitizeCmsRichText` (the shared,
   *     CMS-specific allow-list from `lib/sanitizeHtml.ts` — "bold, italic,
   *     line breaks only," per that file's header) BEFORE persistence.
   *   - `PLAIN_TEXT`: stored EXACTLY as received (after Zod's `.max()`
   *     bound — no trimming, no escaping, no HTML stripping). Escaping
   *     happens ON RENDER, by the SPA (React's default JSX text-node
   *     escaping per the task brief) — sanitizing plain text at WRITE time
   *     would be both redundant (there is no markup to strip — plain text
   *     has none by definition) AND actively harmful: it would silently
   *     mangle entirely legitimate literal content like `Tom & Jerry's
   *     Café`, `"quoted"`, or a `<3` emoticon into HTML-entity soup that
   *     then displays WRONG (double-escaped) once the renderer ALSO escapes
   *     it. "Sanitize on write, escape on render" and "store as-is, escape
   *     on render" are two DIFFERENT, format-appropriate controls — applying
   *     the rich-text control to plain text would be a bug, not extra safety.
   *
   * `format` is sourced from the REGISTRY — never from client input (see
   * `updateSlotSchema`'s doc-comment for why the body schema doesn't even
   * accept a `format` field) — so a slot's rendering/sanitization contract
   * can only ever change via a reviewed code change to `cms.slots.ts`, never
   * a runtime API call.
   *
   * Stamps `lastEditedById = editor.id` on every write — architecture.md §7
   * names this attribution explicitly, and `CMSContent.lastEditedBy`'s
   * `onDelete: SetNull` relation exists precisely so this attribution can be
   * recorded without creating an un-removable dependency on the editor's
   * account persisting forever (see the schema's inline doc-comment on that
   * relation for the full "site copy, not authored content" reasoning).
   */
  updateSlot(editor: AuthenticatedUser, slotKey: string, value: string): Promise<CmsSlotView>;
}

/**
 * Synthesizes the "registered-but-unpopulated" safe-empty `CmsSlotView` for
 * a known registry entry that has no `CMSContent` row yet. Named, shared
 * helper — used by BOTH `getSlot` and `getSlots` so the exact shape of "an
 * empty default" (empty string, `null` timestamp, registry-sourced format)
 * can never drift between the single and batch read paths; see the
 * file-header decision record for why each field has the value it does.
 */
function emptyDefaultFor(slot: CmsSlotDefinition): CmsSlotView {
  return {
    slotKey: slot.slotKey,
    format: slot.format,
    value: '',
    updatedAt: null,
  };
}

/** Projects a real `CMSContent` row into the shared `CmsSlotView` shape —
 * the "real row" counterpart to `emptyDefaultFor`'s synthesized default.
 * Keeping both behind small, named functions makes the read paths below
 * read as "resolve a row-or-default, then project" rather than interleaving
 * shape-construction logic with lookup/branching logic. */
function viewFromRow(row: CMSContent): CmsSlotView {
  return {
    slotKey: row.slotKey,
    format: row.format,
    value: row.value,
    updatedAt: row.updatedAt,
  };
}

export function createCmsService({ repository }: CmsServiceOptions): CmsService {
  return {
    async getSlot(slotKey) {
      const registered = findRegisteredSlot(slotKey);
      if (!registered) {
        // Categorically different from "registered but empty" — see the
        // file-header decision record. There is no safe-empty default for a
        // key the system does not recognize at all.
        throw unknownSlot(slotKey);
      }

      const row = await repository.findBySlotKey(slotKey);
      return row ? viewFromRow(row) : emptyDefaultFor(registered);
    },

    async getSlots(slotKeys) {
      // -----------------------------------------------------------------
      // Out-of-registry batch keys — DOCUMENTED DECISION: silently OMIT.
      // -----------------------------------------------------------------
      // The plan explicitly leaves this open ("the plan doesn't spell this
      // out explicitly for the batch endpoint... pick the option that best
      // serves 'the renderer never crashes/special-cases'"). Three options
      // were on the table:
      //
      //   (a) 400 the whole request — REJECTED. A single typo'd/stale key
      //       in an otherwise-valid batch (e.g. a frontend deploy ships a
      //       `useCmsSlots([...])` call referencing a slot that was since
      //       renamed/removed from the registry) would take down the ENTIRE
      //       page's CMS content with a hard error — exactly the kind of
      //       brittle coupling the batch endpoint exists to avoid. A public
      //       page should degrade gracefully, not 400, because of a stale
      //       reference to content metadata.
      //   (b) include it with some "unknown" marker — REJECTED. This would
      //       force EVERY consumer of the map (the very thing the Frontend
      //       Review Note's batch contract is designed to avoid) to learn
      //       and special-case a THIRD state ("present, registered-but-
      //       empty" vs. "present, populated" vs. "present-but-actually-
      //       unknown-please-don't-render-this") — directly contradicting
      //       "the renderer never has to special-case." It would also leak
      //       an internal implementation fact (the registry's exact
      //       membership) to any client that cares to probe `?keys=` with
      //       guesses — a mild information-disclosure surface for zero
      //       benefit.
      //   (c) silently OMIT the key from the response map — CHOSEN. ✓
      //
      // Why (c) is correct, not merely "the path of least resistance":
      //   - It keeps the map's contract crisp and uniform: "every key in
      //     this map is a real, recognized slot, with a real-or-safe-empty
      //     value" — exactly ONE state space for consumers to handle, the
      //     state space the Frontend Review Note's `CmsSlot` component is
      //     designed around (`slots[key]` is either a valid `CmsSlotView`
      //     or genuinely absent — never a third "present but poisoned"
      //     value).
      //   - "Genuinely absent from the map" is ALSO the exact shape a
      //     `CmsSlot fallbackHeading="..."` component is already built to
      //     handle gracefully (Phase 6 step 1 describes it rendering a
      //     `fallbackHeading` when its slot has no usable content) — so
      //     this decision requires ZERO new client-side branching; an
      //     out-of-registry key degrades EXACTLY like a registered-but-
      //     not-yet-populated one would look to a naive lookup, and the
      //     existing fallback path covers it for free.
      //   - It fails QUIETLY rather than LOUDLY for a condition that is
      //     fundamentally a developer/deploy-coordination issue (a stale
      //     slot reference), not a runtime data problem a site visitor
      //     should ever be able to trigger or notice — the visitor simply
      //     sees the page's other, valid slots render normally and the
      //     stale one fall back to its heading, which is the least
      //     disruptive possible outcome for an end user.
      //   - It does NOT silently hide the issue from the people who should
      //     fix it: this is exactly the kind of drift `cms.slots.test.ts`'s
      //     registry/seed-parity assertions and ordinary manual QA on a
      //     freshly-deployed page would catch immediately — "the card is
      //     blank/showing its fallback heading" is a visible, debuggable
      //     symptom, not a silent data-corruption risk.
      //
      // Mechanically: filter to registry-recognized keys FIRST (cheap,
      // in-memory `isRegisteredSlot` checks against the small `Set`), THEN
      // do exactly ONE batched DB round trip for the remainder — an
      // out-of-registry key never reaches the repository at all.
      const registeredKeys = slotKeys.filter((key) => isRegisteredSlot(key));

      const rows = await repository.findBySlotKeys(registeredKeys);
      const rowsByKey = new Map(rows.map((row) => [row.slotKey, row]));

      const result: CmsSlotMap = {};
      for (const key of registeredKeys) {
        const row = rowsByKey.get(key);
        if (row) {
          result[key] = viewFromRow(row);
        } else {
          // `registeredKeys` is, by construction, a subset of `CMS_SLOTS` —
          // `findRegisteredSlot` cannot return `undefined` here. The
          // non-null assertion documents that invariant rather than
          // re-deriving a runtime check `isRegisteredSlot` already performed
          // (mirrors `blog.router.ts`'s `req.user!` "the gate already
          // proved this" convention).
          result[key] = emptyDefaultFor(findRegisteredSlot(key)!);
        }
      }

      return result;
    },

    async updateSlot(editor, slotKey, value) {
      const registered = findRegisteredSlot(slotKey);
      if (!registered) {
        throw unknownSlot(slotKey);
      }

      // Format-aware sanitization — see this method's interface doc-comment
      // for the full "why these two branches, and why neither is optional/
      // interchangeable with the other" rationale.
      const valueToStore =
        registered.format === 'RICH_TEXT' ? sanitizeCmsRichText(value) : value;

      const row = await repository.upsertValue({
        slotKey: registered.slotKey,
        format: registered.format,
        value: valueToStore,
        lastEditedById: editor.id,
      });

      return viewFromRow(row);
    },
  };
}
