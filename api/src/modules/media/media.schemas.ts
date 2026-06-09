/**
 * Zod request-validation schemas for the Media module (plan.md Phase 4e),
 * consumed via `validate({ body?, params?, query? })` — see
 * `middleware/validate.ts` for the project-wide convention.
 *
 * NOTE: the file itself is validated out-of-band by multer (size limit) and
 * by the service (content-sniffed MIME type via `file-type`) — Zod does not
 * validate binary file payloads, only the non-file fields in a multipart
 * request. The `uploadBodySchema` below covers only the JSON-ish fields that
 * multer places on `req.body` after parsing the multipart request.
 */
import { z } from 'zod';

import { type MediaOwnerType } from '@prisma/client';

/** `:id` route param — shared by `DELETE /admin/media/:id`. A non-empty
 * string; actual UUID format is validated implicitly (Prisma returns 404 for
 * a non-UUID lookup, and `notFound()` is the correct response in either case
 * — see `blog.schemas.ts`'s `idParamSchema` note for the same reasoning). */
export const mediaIdParamSchema = z.object({
  id: z.string().trim().min(1, 'id is required'),
});
export type MediaIdParam = z.infer<typeof mediaIdParamSchema>;

/**
 * Non-file body fields for `POST /admin/media` (multipart upload).
 *
 * `ownerType` and `ownerId` together identify which `BlogPost` or `Event`
 * this asset belongs to — the polymorphic-by-convention ADR-0005 pair. The
 * service validates that the referenced owner exists AND that the acting user
 * may edit it before writing any file to disk (see `media.service.ts`).
 *
 * `altText` is the human-readable label for the asset — stored in
 * `MediaAsset.altText`, distinct from the on-disk filename (which is a UUID;
 * see `media.constants.ts` file-header on filename sanitization).
 *
 * `sortOrder` is optional (defaults to 0 in the schema — matches the Prisma
 * default on the column) — allows callers to specify ordering within an
 * owner's asset list without a separate update round trip.
 */
export const uploadBodySchema = z.object({
  ownerType: z.enum(['BLOG_POST', 'EVENT'] satisfies [MediaOwnerType, MediaOwnerType], {
    message: 'ownerType must be BLOG_POST or EVENT',
  }),
  ownerId: z.string().trim().min(1, 'ownerId is required'),
  altText: z.string().trim().min(1, 'altText is required').max(300, 'altText must be at most 300 characters'),
  sortOrder: z.coerce.number().int().min(0).optional().default(0),
});
export type UploadBody = z.infer<typeof uploadBodySchema>;

/**
 * Query params for `GET /admin/media?ownerType=...&ownerId=...`.
 *
 * Both fields are required — listing all media assets across all owners is
 * not a supported use case (the endpoint exists for the admin media picker,
 * which always operates in the context of a specific post or event). The
 * service's ownership check (same logic as upload) ensures the caller may
 * only list assets for owners they can edit.
 */
export const listQuerySchema = z.object({
  ownerType: z.enum(['BLOG_POST', 'EVENT'] satisfies [MediaOwnerType, MediaOwnerType], {
    message: 'ownerType must be BLOG_POST or EVENT',
  }),
  ownerId: z.string().trim().min(1, 'ownerId is required'),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
