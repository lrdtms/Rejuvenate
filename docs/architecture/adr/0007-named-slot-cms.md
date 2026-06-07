# ADR-0007: Named-Slot CMS over Generic Page Builder

## Status

Accepted

## Decision drivers reference

PRD §6.5 explicitly mandates a *scoped* CMS — "not a generic 'edit anything' system"
— covering specific, enumerated content areas (About page cards, Cape Town/Durban
location-contact cards, Contact page details). PRD §6.5 and §12 require that layout,
navigation, and branding remain code-controlled (i.e., not editable by content staff
through the CMS), and that edits achieve WYSIWYG-like fidelity — what an Admin sees
in the editor must match exactly what renders live (PRD §9.5 / §6.5 user journey).

## Context

Two broad CMS architectures were considered for the editable-content requirement:

1. **Generic page-builder / block-based CMS** — content staff can compose arbitrary
   layouts from reusable blocks (rich text, images, columns, custom components),
   typically stored as a flexible/JSON document tree, rendered generically at
   request/build time.
2. **Named-slot CMS** — a fixed, developer-defined registry of content "slots"
   (`slotKey`), each with a known rendering location and format, where editors can
   change only the *value* of an existing slot — never create, remove, relocate, or
   restructure slots.

A generic page-builder is dramatically more flexible but also dramatically larger in
scope: it requires a rendering engine capable of safely interpreting arbitrary
editor-composed structures, far more surface area for content staff to inadvertently
break layout/branding consistency, and a much harder WYSIWYG-fidelity guarantee
(the rendering surface is no longer fixed and known at build time). None of this
matches the PRD's explicit, scoped requirement.

## Decision

Model `CMSContent` as a **fixed, developer-defined set of named slots** identified by
a unique `slotKey`. Each slot has a known render location (wired into specific SPA
components/pages at build time), a declared format (e.g., plain text vs. sanitized
rich text), and a `value`. Editors can change only the *value* of an existing,
known slot. **Writes to unknown `slotKey` values are rejected** at the API boundary.
This is **not** a generic block/page-builder CMS — building one is an explicit
non-goal (architecture.md §15).

## Consequences

**Positive:**
- Editors cannot break layout, cannot introduce inconsistent branding, and cannot
  create orphaned/unused content — there is no mechanism by which they could, since
  the set of editable surfaces is fixed and enumerated.
- The WYSIWYG-fidelity guarantee (PRD §9.5) is *achievable* — and only achievable —
  *because* the rendering surface per slot is known and fixed at build time. A
  generic page builder cannot make this guarantee without a much larger investment
  in a faithful live-preview rendering engine.
- Small, well-defined attack surface for the mandatory server-side rich-text
  sanitization (architecture.md §12): a known, finite set of slots with known
  formats is far easier to sanitize and test exhaustively than an open-ended
  document tree.
- Directly satisfies the explicit PRD requirement (§6.5) and avoids building
  something larger and riskier than what was asked for (YAGNI).

**Negative / tradeoffs:**
- Adding a new editable region (e.g., a future "Durban service times" card) requires
  a small developer change: a new slot key registered in the fixed slot registry, a
  migration/seed update, and render-slot wiring in the SPA. **This is treated as a
  feature, not a bug** — it keeps "what is editable" a deliberate, reviewed decision
  rather than an emergent, uncontrolled one, directly serving the PRD's
  layout/branding-integrity requirement.

**Neutral / future-facing:**
- If Admins find the v1 slot set limiting (which PRD §14 anticipates as a likely
  follow-up request), expanding the slot set is cheap and incremental — add rows to
  the slot registry, no architecture change required. This is the intended escape
  valve, deliberately chosen over building a heavyweight generic system speculatively.
