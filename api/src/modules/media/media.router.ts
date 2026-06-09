/**
 * Media module router (plan.md Phase 4e step 3).
 *
 * Routes (all admin-gated — mounted on the `/api/v1` router in `app.ts`):
 *   POST   /api/v1/admin/media                        — multipart upload
 *   GET    /api/v1/admin/media?ownerType=...&ownerId=... — list assets for owner
 *   DELETE /api/v1/admin/media/:id                    — delete a single asset
 *
 * All three routes are gated by `requireRole(authService, 'ADMIN', 'BLOGGER',
 * 'EVENT_MANAGER')` at the route level (all content-area staff pass the gate).
 * Per-content-area scoping is enforced in the SERVICE layer via the
 * `ownerId` ownership check:
 *   - A BLOGGER reaching POST/DELETE for an EVENT-owned asset is rejected
 *     with `forbidden()` by `checkOwnerAccess` in `media.service.ts`.
 *   - An EVENT_MANAGER reaching POST/DELETE for a BLOG_POST-owned asset is
 *     similarly rejected.
 *   - An ADMIN may access either.
 * This is the correct layering per the brief — the router proves "the caller
 * is some content-area staff"; the service proves "the caller may act on THIS
 * specific owner." Adding a parallel role→ownerType check at the router layer
 * would duplicate logic that can drift.
 *
 * ===========================================================================
 * Multer configuration
 * ===========================================================================
 * Multer is configured with `storage: multer.memoryStorage()` — the file is
 * held in memory as a `Buffer`, then passed to the service for EXIF stripping
 * via `sharp` before being written to disk. This avoids writing the raw,
 * unstripped file to disk even temporarily (a POPIA concern — the stripped
 * copy is the only one that should ever touch persistent storage).
 *
 * `limits.fileSize` is set to `MAX_FILE_SIZE_BYTES` at the multer layer.
 * Multer throws a `MulterError` with `code === 'LIMIT_FILE_SIZE'` when this
 * limit is exceeded; the router's error handler catches it via
 * `isMulterFileSizeError` and translates it to the standard `badRequest`
 * shape instead of letting it propagate as an unhandled 500.
 *
 * ===========================================================================
 * File field name convention
 * ===========================================================================
 * The multipart field carrying the file is named `file`. The SPA's upload
 * form must use `formData.append('file', fileBlob, filename)` to match.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/rbac';
import { badRequest } from '../../lib/errors';
import type { AuthService } from '../auth/auth.service';
import { isMulterFileSizeError, type MediaService } from './media.service';
import {
  listQuerySchema,
  mediaIdParamSchema,
  uploadBodySchema,
  type ListQuery,
  type MediaIdParam,
  type UploadBody,
} from './media.schemas';
import { MAX_FILE_SIZE_BYTES } from './media.constants';
import type { MediaOwnerType } from '@prisma/client';

export interface CreateMediaRouterOptions {
  authService: AuthService;
  mediaService: MediaService;
}

export function createMediaRouter(options: CreateMediaRouterOptions): Router {
  const { authService, mediaService } = options;
  const router = Router();

  // All three routes share the same role gate — see file-header rationale.
  const requireMediaStaff = requireRole(authService, 'ADMIN', 'BLOGGER', 'EVENT_MANAGER');

  // Multer configured with memory storage so the raw bytes reach the service
  // for EXIF stripping before any file touches disk. `limits.fileSize` is the
  // first line of defense; the service re-checks (belt-and-suspenders).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
  });

  // ---------------------------------------------------------------------------
  // POST /admin/media — multipart upload
  //
  // multer's `upload.single('file')` middleware runs BEFORE `validate()` for
  // the non-file fields. multer populates `req.file` (the uploaded buffer) and
  // `req.body` (the non-file multipart fields, as raw strings). `validate()`
  // then parses/coerces `req.body` through `uploadBodySchema` (which coerces
  // `sortOrder` from string to number, etc.).
  //
  // Error handling: multer's `LIMIT_FILE_SIZE` error is caught in the inline
  // error handler passed to `upload.single(...)` as a fallback — multer does
  // NOT call `next(err)` automatically for limit errors; we must call it
  // ourselves in the callback.
  // ---------------------------------------------------------------------------
  router.post(
    '/admin/media',
    requireMediaStaff,
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          if (isMulterFileSizeError(err)) {
            next(
              badRequest(
                `File too large — maximum size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB`,
              ),
            );
            return;
          }
          next(err);
          return;
        }
        next();
      });
    },
    validate({ body: uploadBodySchema }),
    (req: Request<Record<string, string>, unknown, UploadBody>, res: Response, next: NextFunction) => {
      if (!req.file) {
        next(badRequest('No file provided — include a file in the "file" multipart field'));
        return;
      }

      const { ownerType, ownerId, altText, sortOrder } = req.body;

      mediaService
        .upload(
          req.user!,
          { buffer: req.file.buffer, originalname: req.file.originalname },
          { ownerType: ownerType as MediaOwnerType, ownerId, altText, sortOrder },
        )
        .then((asset) => {
          res.status(201).json({ asset });
        })
        .catch(next);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /admin/media?ownerType=...&ownerId=... — list assets for an owner
  //
  // Returns `{ items: MediaAsset[] }` — no pagination (an individual post/
  // event realistically has <20 images; see media.service.ts for the
  // "listByOwner returns all" contract).
  // ---------------------------------------------------------------------------
  router.get(
    '/admin/media',
    requireMediaStaff,
    validate({ query: listQuerySchema }),
    (req: Request, res: Response, next: NextFunction) => {
      const query = req.query as unknown as ListQuery;

      mediaService
        .listByOwner(req.user!, query.ownerType as MediaOwnerType, query.ownerId)
        .then((result) => {
          res.status(200).json(result);
        })
        .catch(next);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /admin/media/:id — delete a single asset
  //
  // Unlinks the file from disk AND deletes the DB row. ENOENT on disk is
  // silently ignored (the DB row is deleted regardless). Ownership-checked
  // in the service (same predicate as upload).
  // ---------------------------------------------------------------------------
  router.delete(
    '/admin/media/:id',
    requireMediaStaff,
    validate({ params: mediaIdParamSchema }),
    (req: Request<MediaIdParam>, res: Response, next: NextFunction) => {
      mediaService
        .deleteAsset(req.user!, req.params.id)
        .then(() => {
          res.status(204).send();
        })
        .catch(next);
    },
  );

  return router;
}
