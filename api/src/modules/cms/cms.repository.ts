/**
 * `CMSContent` repository (plan.md Phase 4d) — the persistence layer in this
 * module's router -> service -> repository chain (architecture.md §6 "Clean
 * layering"). Owns ALL direct Prisma access for `CMSContent`; the service
 * composes these primitives and applies every domain rule on top (registry
 * membership / `unknownSlot` rejection, sanitization-by-format, the
 * "registered-but-unpopulated -> safe empty default" read contract,
 * `lastEditedById` stamping). No business logic lives here — only typed,
 * named queries, mirroring `blog.repository.ts`'s/`registrations.repository.ts`'s
 * factory-based shape (`createCmsRepository({ db })`).
 *
 * This is a deliberately TINY repository — the entire table has exactly six
 * rows (the fixed slot registry — see `cms.slots.ts`), there is no pagination,
 * no filtering, no ownership-scoped listing, nothing resembling Blog/Events'
 * query surface. Two read shapes (single, batch-by-keys) and one write
 * (upsert-by-`slotKey`) cover the entire module's persistence needs.
 */
import type { CMSContent, Prisma, PrismaClient } from '@prisma/client';

export interface CmsRepositoryOptions {
  db: PrismaClient;
}

export interface CmsRepository {
  /**
   * Single-slot lookup by `slotKey`. Returns `null` if no row exists yet —
   * the "registered-but-unpopulated" case `CmsService.getSlot` is
   * specifically contracted to handle with a safe empty default (see that
   * method's doc-comment; this repository method does NOT itself decide
   * what "missing" means — it simply reports the database's true state,
   * `null` included, and lets the service apply the documented policy).
   */
  findBySlotKey(slotKey: string): Promise<CMSContent | null>;

  /**
   * Batch lookup for the public `GET /cms?keys=a,b,c` endpoint — a single
   * `findMany({ where: { slotKey: { in: keys } } })` round trip rather than
   * N sequential `findBySlotKey` calls (the exact "avoid request/query
   * waterfalls" discipline the plan's batch-endpoint rationale names for the
   * HTTP layer applies equally to the DB layer underneath it — no reason to
   * solve the waterfall problem at the API boundary while reintroducing it
   * one layer down).
   *
   * Returns ONLY the rows that actually exist — it is the SERVICE's job
   * (`getSlots`) to reconcile this partial result against the full
   * requested-keys list and fill in safe-empty defaults for any
   * registered-but-unpopulated key, exactly mirroring `getSlot`'s contract
   * (see that method's doc-comment for why "every requested key present,
   * even if unpopulated" is enforced at the service layer, not here — the
   * repository's job is to report the database's true state truthfully).
   */
  findBySlotKeys(slotKeys: readonly string[]): Promise<CMSContent[]>;

  /**
   * Creates-or-updates the row for `slotKey` in one atomic operation —
   * `upsert` rather than a `findFirst` + `create`/`update` pair, which would
   * be both an unnecessary extra round trip AND a (mild) TOCTOU race between
   * the existence check and the write (two concurrent admin saves to the
   * same slot could otherwise both see "no row" and both attempt `create`,
   * one failing on the `@unique` constraint with a confusing low-level
   * Postgres error instead of a clean upsert). `slotKey`'s `@unique`
   * constraint is exactly what makes `upsert` the correct, race-safe
   * primitive here — mirroring `prisma/seed.ts`'s own `upsert`-keyed-on-
   * `slotKey` idempotency pattern.
   *
   * Takes the ALREADY-VALIDATED, ALREADY-SANITIZED `value` and the
   * REGISTRY-DERIVED `format` (the repository never makes either decision —
   * see `cms.service.ts`'s `updateSlot` for where both happen, mirroring
   * `blog.repository.ts`'s `create`/`update` "takes the already-sanitized
   * body" convention). `format` is supplied on every write (not merely
   * preserved from an existing row) because the `create` branch of the
   * upsert needs SOME value to satisfy the non-nullable column — and because
   * the registry is the single source of truth for a slot's format, sourcing
   * it fresh from there on every write (rather than trusting whatever the
   * existing row happens to already say) is strictly more correct, not
   * merely "good enough."
   */
  upsertValue(input: {
    slotKey: string;
    format: CMSContent['format'];
    value: string;
    lastEditedById: string | null;
  }): Promise<CMSContent>;
}

export function createCmsRepository({ db }: CmsRepositoryOptions): CmsRepository {
  return {
    async findBySlotKey(slotKey) {
      return db.cMSContent.findUnique({ where: { slotKey } });
    },

    async findBySlotKeys(slotKeys) {
      if (slotKeys.length === 0) {
        // Defensive short-circuit: an empty `IN ()` is valid SQL but a
        // wasted round trip for an input shape the service should never
        // actually produce (the schema's `cmsBatchQuerySchema` guarantees
        // `keys.length >= 1`) — named here so a future caller that DOES
        // pass `[]` (e.g. a refactor that forgets the schema's guarantee)
        // gets a fast, correct `[]` rather than an unnecessary query.
        return [];
      }

      const where: Prisma.CMSContentWhereInput = { slotKey: { in: [...slotKeys] } };
      return db.cMSContent.findMany({ where });
    },

    async upsertValue({ slotKey, format, value, lastEditedById }) {
      return db.cMSContent.upsert({
        where: { slotKey },
        create: { slotKey, format, value, lastEditedById },
        update: { value, lastEditedById },
      });
    },
  };
}
