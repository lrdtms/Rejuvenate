# ADR-0005: Polymorphic-by-Convention MediaAsset Table

## Status

Accepted

## Context

Both `BlogPost` and `Event` need to support attached images: ordered, alt-texted,
uploaded image assets associated with a parent content entity. Two schema approaches
were considered:

1. **Separate tables per owner type** — e.g., `BlogImage` (FK to `BlogPost`) and
   `EventImage` (FK to `Event`), each enforcing referential integrity at the database
   level via a real foreign key.
2. **One shared, polymorphic-by-convention table** — a single `MediaAsset` table with
   `ownerType` (an enum/discriminator: `BLOG_POST`, `EVENT`, ...) and `ownerId`
   columns, with no database-level foreign key (since a single column cannot validly
   reference rows across two different parent tables in PostgreSQL/Prisma).

The two owner types share an identical set of concerns (file metadata, ordering,
alt text, upload pipeline, validation rules, storage adapter) — duplicating an
entire table, repository, and upload code path for each owner type would violate
DRY at both the schema and code level for no functional gain.

## Decision

Use **one** `MediaAsset` table with `ownerType`/`ownerId` discriminator columns,
shared by `BlogPost` and `Event` (and extensible to future owner types), rather than
separate `BlogImage`/`EventImage` tables with real foreign keys.

## Consequences

**Positive:**
- One upload pipeline, one validation rule set, one storage adapter, one repository —
  the Media module stays small and uniform regardless of how many owner types exist.
- Adding a third owner type (e.g., CMS-slot images, user avatars) requires no new
  migration shape — just a new `ownerType` enum value and the corresponding
  application-layer wiring.

**Negative / tradeoffs:**
- **The database cannot enforce referential integrity on the polymorphic relation.**
  PostgreSQL (and Prisma) cannot express "this `ownerId` must reference a row in
  whichever table `ownerType` names" as a real foreign-key constraint. This means:
  - Integrity (no `MediaAsset` row pointing at a non-existent `BlogPost`/`Event`,
    and no `ownerType` mismatch) **must be enforced entirely in the application/
    service layer** — every write path that creates or reassigns a `MediaAsset` must
    verify the owner exists and matches `ownerType` inside the same transaction.
  - This must be **tested accordingly**: a fitness-function-style integration test
    asserting that no `MediaAsset` row can ever reference a non-existent
    `BlogPost`/`Event` is a required guardrail (see architecture.md §15, testing
    notes), not an optional nicety — it is the only thing standing in for a database
    constraint that cannot exist here.
  - Cascade-delete semantics (e.g., "delete all media when a post is deleted") must
    also be implemented in the service layer (e.g., inside the same transaction as
    the parent delete), since the database cannot cascade across a polymorphic
    relation.

**Neutral / future-facing:**
- If a third `ownerType` (e.g., CMS-slot images) emerges, this table absorbs it
  without a new migration shape — only a new enum value and render-path wiring.
