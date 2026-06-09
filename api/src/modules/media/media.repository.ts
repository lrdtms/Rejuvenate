/**
 * `MediaAsset` repository (plan.md Phase 4e) — the persistence layer in this
 * module's router -> service -> repository chain (architecture.md §6 "Clean
 * layering"). Owns ALL direct Prisma access for `MediaAsset`; the service
 * applies every domain rule on top (existence/ownership validation, file
 * writing, EXIF stripping). No business logic lives here — only typed, named
 * queries, mirroring `blog.repository.ts`'s/`cms.repository.ts`'s factory-
 * based shape (`createMediaRepository({ db })`).
 *
 * ADR-0005: `MediaAsset` has NO DB-level foreign key to `BlogPost` or `Event`
 * (polymorphic-by-convention — `ownerType`/`ownerId` pair; `ownerId` cannot
 * simultaneously be an FK to two different parent tables). Referential
 * integrity is enforced entirely in the service layer: the repository
 * faithfully reports whatever the database contains; it does NOT enforce
 * "does this owner actually exist?" — that is `MediaService`'s job (and it
 * checks BEFORE any file is written to disk).
 */
import type { MediaAsset, MediaOwnerType, PrismaClient } from '@prisma/client';

export interface MediaRepositoryOptions {
  db: PrismaClient;
}

export interface MediaRepository {
  /**
   * Persists a new `MediaAsset` row. The caller (service layer) is
   * responsible for ensuring:
   *   - The file has already been written to disk at the path corresponding
   *     to `url`'s filename.
   *   - The owning resource (`ownerType`/`ownerId`) has been existence- and
   *     ownership-checked (ADR-0005's application-layer integrity guarantee).
   * This method performs no validation of its own — it trusts the already-
   * validated inputs from the service, mirroring `blog.repository.ts`'s
   * "takes the already-sanitized body" convention.
   */
  create(input: {
    url: string;
    altText: string;
    ownerType: MediaOwnerType;
    ownerId: string;
    sortOrder: number;
  }): Promise<MediaAsset>;

  /**
   * Looks up a single `MediaAsset` by its `id`. Returns `null` if not found —
   * the "resource not found" case that `MediaService` translates to `notFound()`.
   */
  findById(id: string): Promise<MediaAsset | null>;

  /**
   * Lists all `MediaAsset` rows for a given `(ownerType, ownerId)` pair,
   * ordered by `sortOrder` ascending (the natural display order for a media
   * picker). Uses the `@@index([ownerType, ownerId])` index defined on the
   * model (see `prisma/schema.prisma`) for efficient lookup.
   *
   * Returns an empty array for an owner with no assets — never `null`.
   */
  listByOwner(ownerType: MediaOwnerType, ownerId: string): Promise<MediaAsset[]>;

  /** Updates the `displaySize` field for a single `MediaAsset` row. */
  updateDisplaySize(id: string, displaySize: string): Promise<MediaAsset>;

  /**
   * Hard-deletes a single `MediaAsset` row by `id`. The caller (service
   * layer) is responsible for unlinking the on-disk file BEFORE calling this
   * — if the row is deleted first and the unlink later fails, the file is an
   * orphan without a DB row, which is recoverable by a filesystem scan;
   * deleting the row first means a re-run of the cleanup can find the file.
   * This method does no file I/O — only the DB delete.
   */
  deleteById(id: string): Promise<void>;

  /**
   * Deletes ALL `MediaAsset` rows for a given `(ownerType, ownerId)` pair.
   * Returns the deleted rows (with their `url` fields) so the caller can
   * unlink each corresponding on-disk file. Used by `BlogService.deletePost`
   * and `EventService.deleteEvent` to implement the cascading-delete contract
   * required by ADR-0005 (no DB-level FK cascade exists).
   *
   * Returns the deleted rows so file paths can be derived from `url` by the
   * service — this avoids two round trips (a `findMany` followed by a
   * `deleteMany`) for the cascade case.
   */
  deleteByOwner(
    ownerType: MediaOwnerType,
    ownerId: string,
  ): Promise<Pick<MediaAsset, 'id' | 'url'>[]>;
}

export function createMediaRepository({ db }: MediaRepositoryOptions): MediaRepository {
  return {
    async create({ url, altText, ownerType, ownerId, sortOrder }) {
      return db.mediaAsset.create({
        data: { url, altText, ownerType, ownerId, sortOrder },
      });
    },

    async findById(id) {
      return db.mediaAsset.findUnique({ where: { id } });
    },

    async listByOwner(ownerType, ownerId) {
      return db.mediaAsset.findMany({
        where: { ownerType, ownerId },
        orderBy: { sortOrder: 'asc' },
      });
    },

    async updateDisplaySize(id, displaySize) {
      return db.mediaAsset.update({ where: { id }, data: { displaySize } });
    },

    async deleteById(id) {
      await db.mediaAsset.delete({ where: { id } });
    },

    async deleteByOwner(ownerType, ownerId) {
      // `$transaction` with a `findMany` + `deleteMany` pair is the safest
      // shape: `deleteMany` returns only a count (no rows), so we need the
      // `findMany` first to get the `url` fields for disk cleanup. Both run
      // in the same transaction so no row is deleted without being returned
      // (and no row is returned without being deleted — no partial-cleanup
      // state the service might misread as "nothing to clean up").
      const [deleted] = await db.$transaction([
        db.mediaAsset.findMany({
          where: { ownerType, ownerId },
          select: { id: true, url: true },
        }),
        db.mediaAsset.deleteMany({ where: { ownerType, ownerId } }),
      ]);

      return deleted as Pick<MediaAsset, 'id' | 'url'>[];
    },
  };
}
