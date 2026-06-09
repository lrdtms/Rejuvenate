/**
 * `MediaService` (plan.md Phase 4e step 1-2) — the use-case / business-rules
 * layer in this module's router -> service -> repository chain
 * (architecture.md §6 "Clean layering"). Owns every domain decision the
 * router must never make directly:
 *
 *   - EXIF stripping via `sharp` (POPIA control — phone photos embed GPS
 *     coordinates; see below)
 *   - Content-sniffed MIME validation via `file-type` (not extension/header-
 *     trusting — see below)
 *   - Size cap (belt-and-suspenders in addition to multer's limit)
 *   - Randomized UUID filename generation (path traversal + collision prevention)
 *   - `ownerId` existence AND ownership check BEFORE any file is written to disk
 *   - Upload directory creation at startup
 *
 * Constructed via a factory (`createMediaService(options)`) — same DI
 * convention as every other module.
 *
 * ===========================================================================
 * DECISION: EXIF stripping via sharp
 * ===========================================================================
 * All uploaded images are passed through `sharp` with `{ withMetadata: false }`
 * (the default) before being written to disk. This strips EXIF metadata,
 * including GPS coordinates embedded by phone cameras — GPS coordinates in
 * phone photos are personal data under POPIA (they can reveal where a
 * worshipper lives, worships, etc.) and must NOT be stored. Sharp also
 * normalizes the file format, re-encoding the image through its own pipeline,
 * which has the side effect of stripping any other embedded metadata
 * (thumbnail images, camera model, creation timestamps, etc.).
 *
 * No aggressive resizing or compression is performed — YAGNI; stripping EXIF
 * is the minimum correct action, and resizing/compression are a VPS CPU cost
 * that requires stakeholder decisions (target dimensions, quality settings)
 * the architecture brief does not specify.
 *
 * ===========================================================================
 * DECISION: Content-sniffed MIME validation
 * ===========================================================================
 * File type is validated against the file's actual magic bytes via the
 * `file-type` package, NOT against the declared `Content-Type` header or the
 * client-supplied filename/extension. A client can trivially lie about both —
 * renaming `malware.exe` to `photo.jpg` and setting `Content-Type: image/jpeg`
 * costs nothing. Reading the first few bytes of the file and comparing against
 * known magic-byte signatures (JPEG: `FF D8 FF`, PNG: `89 50 4E 47`, etc.)
 * cannot be faked without actually encoding a valid image file.
 *
 * `file-type@18` is used (pinned to the last CommonJS-compatible release)
 * because this project uses `"type": "commonjs"` in `package.json` — versions
 * 19+ are pure ESM and would require a dynamic `import()` dance that
 * TypeScript's CommonJS target does not handle cleanly.
 *
 * ===========================================================================
 * DECISION: Validation ordering (check ownership BEFORE writing to disk)
 * ===========================================================================
 * The service validates `ownerId` existence and ownership BEFORE writing any
 * file to disk. Writing first, then discovering the owner doesn't exist or the
 * user can't edit it, leaves an orphaned file on disk. The correct order is:
 *   1. Validate MIME type and size (cheap, in-memory — no I/O)
 *   2. Validate owner exists and user owns it (one DB round trip)
 *   3. Strip EXIF via sharp and write to disk
 *   4. Create the `MediaAsset` row
 * If step 4 fails after step 3, the file is an orphan — this is recoverable
 * (a cleanup scan can find files without DB rows); the inverse (DB row without
 * file, from writing-after-validating-DB) is not discoverable without
 * cross-referencing both systems.
 *
 * ===========================================================================
 * DECISION: Cross-module repository injection
 * ===========================================================================
 * `MediaService` receives `blogRepository` and `eventRepository` in its
 * options for the `ownerId` existence + ownership check. This is the
 * established DI pattern for cross-module reads in this codebase (see
 * `registrations.service.ts`'s injection of `eventService`). The
 * repositories, not the services, are injected here to keep the dependency
 * minimal — only `findById`-shaped methods are needed, not the full service
 * API.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import type { MediaAsset, MediaOwnerType } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.service';
import { canEditPost } from '../auth/ownership';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { env } from '../../config/env';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MEDIA_URL_PREFIX,
  MIME_TO_EXTENSION,
} from './media.constants';
import type { MediaRepository } from './media.repository';
import type { BlogRepository } from '../blog/blog.repository';
import type { EventRepository } from '../events/events.repository';

export interface MediaServiceOptions {
  repository: MediaRepository;
  blogRepository: BlogRepository;
  eventRepository: EventRepository;
  /** Absolute path to the upload directory. Defaults to `env.UPLOADS_DIR`
   * (resolved relative to cwd). Tests should override with a temp dir so they
   * never write into `api/uploads/` and leave no artifacts. */
  uploadDir?: string;
}

/** The view shape returned for a single `MediaAsset` — the same shape every
 * route in this module returns, directly from the Prisma row (no projection
 * needed; the full `MediaAsset` is the public contract). */
export type MediaAssetView = MediaAsset;

export interface MediaService {
  /**
   * Ensures the upload directory exists, creating it (and any necessary parent
   * directories) if it does not. Called once at application startup (from
   * `app.ts`) so a first-run deployment does not fail on the first upload with
   * ENOENT. Safe to call repeatedly — idempotent via `fs.mkdirSync` with
   * `{ recursive: true }`.
   */
  ensureUploadDir(): Promise<void>;

  /**
   * Uploads a file, creating a `MediaAsset` row.
   *
   * Validation order (see file-header decision record):
   *   1. File size check (belt-and-suspenders — multer already enforced
   *      `MAX_FILE_SIZE_BYTES` at the network layer, but multer errors are
   *      caught by a dedicated error handler in the router; this check covers
   *      any future code path that bypasses multer).
   *   2. Content-sniffed MIME type check via `file-type`.
   *   3. Owner existence + ownership check (DB round trip).
   *   4. EXIF stripping via sharp + file write to disk.
   *   5. `MediaAsset` row creation.
   *
   * Returns the created `MediaAsset` row.
   */
  upload(
    actor: AuthenticatedUser,
    file: {
      buffer: Buffer;
      originalname: string;
    },
    input: {
      ownerType: MediaOwnerType;
      ownerId: string;
      altText: string;
      sortOrder: number;
    },
  ): Promise<MediaAssetView>;

  /**
   * Deletes a `MediaAsset` row and unlinks the corresponding file from disk.
   *
   * Ownership check: same predicate as `upload` — a Blogger may only delete
   * media assets attached to posts they can edit; an Event Manager may only
   * delete assets for events; an Admin may delete anything.
   *
   * File-not-found on disk (ENOENT) is silently ignored — the DB row is
   * deleted regardless, so a partially-cleaned state never blocks further
   * cleanup attempts. Missing files are recoverable by re-running the delete;
   * orphaned DB rows pointing at gone files are not.
   *
   * Throws `notFound()` if the `MediaAsset` row does not exist.
   * Throws `forbidden()` if the actor cannot edit the owning resource.
   */
  deleteAsset(actor: AuthenticatedUser, id: string): Promise<void>;

  /**
   * Lists all `MediaAsset` rows for a given `(ownerType, ownerId)` pair,
   * ordered by `sortOrder` ascending. Ownership-checked (same predicate as
   * upload/delete) — a Blogger may only list assets for posts they can edit;
   * an Event Manager may only list event assets; an Admin may list anything.
   *
   * Returns `{ items: MediaAsset[] }`. No pagination — an individual post or
   * event realistically has fewer than 20 images.
   */
  listByOwner(
    actor: AuthenticatedUser,
    ownerType: MediaOwnerType,
    ownerId: string,
  ): Promise<{ items: MediaAssetView[] }>;

  /**
   * Deletes ALL `MediaAsset` rows for a given `(ownerType, ownerId)` pair and
   * unlinks each corresponding file from disk. Called by `BlogService.
   * deletePost` and `EventService.deleteEvent` to implement the ADR-0005
   * cascading-delete contract (no DB-level FK cascade exists).
   *
   * ENOENT on unlink is silently ignored — a missing file is not an error
   * during cascade cleanup (the file may already be gone from a previous
   * partial cleanup attempt; the DB row is the authoritative record).
   *
   * NOT ownership-checked — this is an internal cascade operation invoked
   * directly by sibling services (Blog/Events) that have already checked
   * ownership before calling their own `deletePost`/`deleteEvent`.
   */
  cascadeDeleteForOwner(ownerType: MediaOwnerType, ownerId: string): Promise<void>;

  /**
   * Updates the `displaySize` field for a single `MediaAsset`.
   * Ownership-checked — same predicate as `upload`/`deleteAsset`.
   */
  updateDisplaySize(actor: AuthenticatedUser, id: string, displaySize: string): Promise<void>;
}

/** Derives the absolute on-disk path for a stored file given its `url` field
 * (e.g. `/media/a3f2...d1.jpg` -> `<uploadDir>/a3f2...d1.jpg`). Named helper
 * so the same extraction logic is used identically by `deleteAsset` and
 * `cascadeDeleteForOwner` — never duplicating the string-manipulation inline. */
function urlToFilePath(url: string, uploadDir: string): string {
  // `url` is `/media/<filename>` — strip the prefix to get just the filename.
  const filename = path.basename(url);
  return path.join(uploadDir, filename);
}

export function createMediaService(options: MediaServiceOptions): MediaService {
  const uploadDir = options.uploadDir ?? path.resolve(env.UPLOADS_DIR);

  /** Checks owner existence AND the actor's permission to edit it. Returns
   * the result of the existence check so the upload code can verify the
   * owner was found, throwing `notFound()` if not and `forbidden()` if the
   * user lacks permission. MUST be called BEFORE any file is written to disk. */
  async function checkOwnerAccess(
    actor: AuthenticatedUser,
    ownerType: MediaOwnerType,
    ownerId: string,
  ): Promise<void> {
    if (ownerType === 'BLOG_POST') {
      const post = await options.blogRepository.findById(ownerId);
      if (!post) {
        throw notFound('Blog post not found');
      }
      if (!canEditPost(actor, post)) {
        throw forbidden('You may only attach media to your own posts');
      }
    } else {
      // ownerType === 'EVENT'
      // Per the Phase 4b "any Event Manager may manage any event" decision
      // (events.service.ts file-header "EVENT-MANAGER OWNERSHIP" section):
      // no per-resource ownership predicate exists for events — any
      // EVENT_MANAGER or ADMIN may attach media to any event.
      const event = await options.eventRepository.findById(ownerId);
      if (!event) {
        throw notFound('Event not found');
      }
      // Role check: ADMIN or EVENT_MANAGER only (BLOGGER must not reach
      // here for events — the router's requireRole gate allows BLOGGER for
      // the route, but only for BLOG_POST ownerType; this enforces the
      // per-content-area scoping the brief requires without a router-level
      // ownerType gate that would duplicate service logic).
      if (actor.role !== 'ADMIN' && actor.role !== 'EVENT_MANAGER') {
        throw forbidden('Only admins and event managers may attach media to events');
      }
    }
  }

  return {
    async ensureUploadDir() {
      await fsPromises.mkdir(uploadDir, { recursive: true });
    },

    async upload(actor, file, input) {
      // Step 1 — size cap (belt-and-suspenders; multer enforces this at the
      // network layer, but an explicit in-service check guards any future
      // caller that bypasses multer, or a misconfigured multer limit).
      if (file.buffer.length > MAX_FILE_SIZE_BYTES) {
        throw badRequest(
          `File too large — maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB`,
        );
      }

      // Step 2 — content-sniffed MIME type check. `file-type@18`'s
      // `fromBuffer` reads the file's magic bytes (not the declared Content-
      // Type or extension) and returns the MIME type, or `undefined` for
      // unknown/non-matching signatures. See file-header decision record for
      // why content sniffing, not header trusting, is the security requirement.
      const detected = await fileTypeFromBuffer(file.buffer);
      if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
        throw badRequest(
          `Unsupported file type${detected ? ` (${detected.mime})` : ''}. ` +
            `Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
        );
      }

      // Step 3 — owner existence + ownership check. BEFORE any disk I/O —
      // see file-header "validation ordering" decision record.
      await checkOwnerAccess(actor, input.ownerType, input.ownerId);

      // Step 4 — EXIF stripping + file write.
      // Pass through sharp with { withMetadata: false } (the default) to
      // strip ALL EXIF metadata before writing to disk — POPIA control; GPS
      // coordinates in phone photos are personal data. We re-encode to the
      // same detected format to normalize the file.
      const ext = MIME_TO_EXTENSION[detected.mime] ?? 'bin';
      const filename = `${randomUUID()}.${ext}`;
      const filePath = path.join(uploadDir, filename);

      // Ensure the upload directory exists (defensive — `ensureUploadDir`
      // should have been called at startup, but concurrent first-boot races
      // and test scenarios where uploadDir is a freshly-created temp dir
      // both benefit from this idempotent guard).
      await fsPromises.mkdir(uploadDir, { recursive: true });

      // sharp strips EXIF by default (withMetadata defaults to false).
      // toFile writes the processed image to disk.
      await sharp(file.buffer).toFile(filePath);

      // Step 5 — create the DB row.
      const url = `${MEDIA_URL_PREFIX}/${filename}`;
      return options.repository.create({
        url,
        altText: input.altText,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        sortOrder: input.sortOrder,
      });
    },

    async deleteAsset(actor, id) {
      const asset = await options.repository.findById(id);
      if (!asset) {
        throw notFound('Media asset not found');
      }

      // Ownership check — same predicate as upload.
      await checkOwnerAccess(actor, asset.ownerType, asset.ownerId);

      // Delete the DB row first (if unlink fails, the file is a recoverable
      // orphan; if the DB delete fails after a successful unlink, the file is
      // gone but the DB row still exists and the next delete attempt will
      // succeed on the DB — a worse, harder-to-debug state). Actually: the
      // plan says "unlink the file AND delete the row" — if unlink fails with
      // anything other than ENOENT, we should not delete the row (the file is
      // still on disk and we'd orphan it). If unlink succeeds (or ENOENT),
      // delete the row. This is the safer ordering.
      const filePath = urlToFilePath(asset.url, uploadDir);
      try {
        await fsPromises.unlink(filePath);
      } catch (err: unknown) {
        // ENOENT = file already gone — ignore; any other error is re-thrown
        // because an unexpected filesystem error should not silently succeed.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }

      await options.repository.deleteById(id);
    },

    async listByOwner(actor, ownerType, ownerId) {
      // Ownership check — a Blogger can only list media for posts they own.
      await checkOwnerAccess(actor, ownerType, ownerId);

      const items = await options.repository.listByOwner(ownerType, ownerId);
      return { items };
    },

    async updateDisplaySize(actor, id, displaySize) {
      const asset = await options.repository.findById(id);
      if (!asset) throw notFound('Media asset not found');
      await checkOwnerAccess(actor, asset.ownerType, asset.ownerId);
      await options.repository.updateDisplaySize(id, displaySize);
    },

    async cascadeDeleteForOwner(ownerType, ownerId) {
      // Fetch + delete DB rows in a single transaction (see
      // `media.repository.ts`'s `deleteByOwner` doc-comment for why both
      // steps run together — no partial-cleanup state).
      const deleted = await options.repository.deleteByOwner(ownerType, ownerId);

      // Unlink each file from disk. ENOENT is silently ignored — a missing
      // file is not an error during cascade cleanup; the DB row is the
      // authoritative record and it is now gone.
      await Promise.all(
        deleted.map(async (asset) => {
          const filePath = urlToFilePath(asset.url, uploadDir);
          try {
            await fsPromises.unlink(filePath);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw err;
            }
          }
        }),
      );
    },
  };
}

/** Checks whether the error thrown by multer when the file size limit is
 * exceeded is in fact a multer limit error. Used by the router's error handler
 * to translate multer's `LIMIT_FILE_SIZE` code into a `badRequest` with the
 * project's standard error shape. */
export function isMulterFileSizeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'LIMIT_FILE_SIZE'
  );
}

/** Synchronously ensures the upload directory exists at startup. Called from
 * `server.ts` (not `app.ts`) because it must run before the first request, not
 * when the app factory is called. Uses `fs.mkdirSync` (sync is fine at startup
 * before the event loop is serving requests). */
export function ensureUploadDirSync(uploadDir?: string): void {
  const dir = uploadDir ?? path.resolve(env.UPLOADS_DIR);
  fs.mkdirSync(dir, { recursive: true });
}
