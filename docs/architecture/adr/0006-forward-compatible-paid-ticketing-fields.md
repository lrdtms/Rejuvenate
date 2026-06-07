# ADR-0006: Forward-Compatible (but Dormant) Paid-Ticketing Fields on Event

## Status

Accepted

## Context

All v1 events are free — no payment processing, checkout, or ticketing gateway is in
scope (PRD §6.3). However, the stakeholder has explicitly anticipated that paid
events may be introduced in a future version (PRD §9, §14). A previously-present
Quicket integration exists in the legacy codebase as a placeholder that was never
used for a real event, and is not part of v1 scope (recommended for removal —
architecture.md §15).

Adding new non-nullable columns (or columns that change the meaning of existing rows)
to a table that already has live production rows is a meaningfully riskier migration
than adding nullable/defaulted columns to an empty table before launch. Right now,
before any `Event` rows exist, adding two small, dormant, well-understood columns
costs essentially nothing. Deferring them until paid ticketing is greenlit would mean
performing that migration against a live table with real registrations and events —
strictly worse.

## Decision

Add two columns to `Event` **now**, before any rows exist:
- `isPaid` — boolean, default `false`
- `price` — nullable integer, **stored as ZAR cents** (not floating-point currency,
  to avoid the well-known class of floating-point rounding bugs in monetary values;
  named to make the unit unambiguous in code, e.g. `priceCents`)

Build **zero** payment logic, checkout flow, gateway integration, `Order`/`Payment`
models, or related routes/services in v1. These columns are *accepted by the schema
and validation layer* but **never produced or acted upon** by any v1 application
logic — the public registration flow ignores `price` entirely, and `isPaid` is always
`false` in v1.

## Consequences

**Positive:**
- When paid ticketing is eventually greenlit, the `Event` schema requires **no
  destructive change** — only new tables (e.g., `Order`, `Payment`) and new
  service/route modules layered alongside the existing `Event` module. This is the
  Open/Closed Principle in action at the architecture level: open for extension
  (new modules), closed for modification (no migration touching existing `Event`
  rows' shape).
- Avoids the strictly-worse alternative of retrofitting these columns onto a live
  table with real rows later.

**Negative / tradeoffs:**
- Two inert columns exist in the schema for a feature that may never ship. This is a
  small, deliberate, well-understood cost — explicitly judged cheaper than the
  alternative.
- Care must be taken that `isPaid`/`price` genuinely remain inert in v1: Zod
  validation may *accept* them at the API boundary (so the schema/contract is
  future-proof and so an Admin/Event Manager can in principle set them without a
  schema change later), but **no v1 service-layer code branches on `isPaid` or acts
  on `price`** — no payment prompts, no gating of registration, nothing. This
  invariant should be covered by a test asserting v1 registration logic is wholly
  unaffected by `isPaid`/`price` values.

**Neutral / future-facing:**
- The actual payment gateway choice (reactivating Quicket vs. an alternative such as
  Paystack/PayFast — both more POPIA/ZAR-native than international defaults) is
  **explicitly deferred**. Do not pre-integrate any gateway "just in case" — that
  would be speculative work against an unconfirmed requirement and an unconfirmed
  vendor choice.
- Recommend **removing** the dormant Quicket placeholder from the codebase during
  the rewrite (it is unused and the future gateway choice is not locked to it),
  rather than carrying it forward as dead code.
