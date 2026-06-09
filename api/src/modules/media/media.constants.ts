/**
 * Named constants for the Media module (plan.md Phase 4e).
 *
 * ===========================================================================
 * DECISION: File storage location
 * ===========================================================================
 * Uploaded files are stored to disk at the path configured by the
 * `UPLOADS_DIR` environment variable (see `src/config/env.ts`). The default
 * value is `./uploads` (relative to the process working directory, i.e.
 * `api/uploads/` in dev), but in production the Nginx-backed deployment at
 * `/var/www/rejuvenate/uploads` (architecture.md §11) is the intended path —
 * set via the `UPLOADS_DIR` env var, never hardcoded.
 *
 * IMPORTANT: this path must be OUTSIDE `api/dist/` — a TypeScript build step
 * (`npm run build`) must never clobber uploaded user files. The default
 * `./uploads` satisfies this because `tsconfig.build.json`'s `outDir` is
 * `dist/`, which never overlaps with a sibling `uploads/` directory.
 *
 * The upload directory is created at application startup if it does not
 * already exist (see `ensureUploadDir()` called from `media.service.ts`) so
 * a first-run deployment does not fail with ENOENT before the first upload.
 *
 * ===========================================================================
 * DECISION: URL scheme for stored assets
 * ===========================================================================
 * `MediaAsset.url` stores a RELATIVE URL in the form `/media/<filename>`,
 * e.g. `/media/a3f2...d1.jpg`. This is intentionally relative — no
 * `https://host` prefix — so the same stored value works across every
 * environment (local dev, staging, production) without needing a DB migration
 * or env-var substitution when the hostname changes.
 *
 * The `MEDIA_URL_PREFIX` constant below is the single source of truth for
 * this prefix. Phase 10's Nginx configuration must configure a matching
 * location block:
 *
 *   location /media/ {
 *     alias /var/www/rejuvenate/uploads/;
 *     expires 30d;
 *     add_header Cache-Control "public, immutable";
 *   }
 *
 * so that Nginx serves uploaded files directly from `UPLOADS_DIR` at the
 * `/media/*` path, without proxying to Node. The frontend constructs
 * absolute URLs from the relative `url` field using its own base URL —
 * e.g. `new URL(asset.url, window.location.origin).href`.
 *
 * ===========================================================================
 * DECISION: EXIF stripping via sharp
 * ===========================================================================
 * All uploaded images are passed through `sharp` with `{ withMetadata: false }`
 * (the default) before being written to disk. This strips EXIF metadata —
 * including GPS coordinates that phone cameras embed — before storage. GPS
 * coordinates in phone photos are personal data under POPIA (the location of
 * a worshipper's home, for example) and must not be stored. This is a
 * deliberate, POPIA-motivated control. No aggressive resizing or compression
 * is performed — YAGNI; just stripping metadata is the minimum correct action.
 *
 * ===========================================================================
 * DECISION: Filename sanitization / randomization
 * ===========================================================================
 * Files are stored as `<uuid>.<normalizedExtension>` (e.g. `a3f2...d1.jpg`).
 * The client-supplied filename is NEVER used for the on-disk name for two
 * reasons:
 *   1. Path traversal prevention: a filename like `../../etc/passwd` or
 *      `../config.json` would be dangerous if used directly. A UUID has no
 *      path components.
 *   2. Collision avoidance: UUIDs are unique; concurrent uploads of a file
 *      named `photo.jpg` by different users never overwrite each other.
 * The human-readable label the uploader intends is stored in
 * `MediaAsset.altText`, not the filename.
 */

/** The URL path prefix for all served media files. MUST match the Nginx
 * `location` block that serves the upload directory in Phase 10. See the
 * file-header decision record for the full URL-scheme rationale. */
export const MEDIA_URL_PREFIX = '/media';

/** Maximum file size accepted per upload, in bytes (5 MB). Enforced at BOTH
 * the multer layer (via `limits.fileSize`) and in the service's content
 * validation (belt-and-suspenders: multer's limit error is caught and
 * translated to a `badRequest`). Architecture.md §11 also requires setting
 * `client_max_body_size 6m` in Nginx (slightly above the 5 MB limit to
 * absorb multipart framing overhead) so Nginx never rejects a valid upload
 * with a generic 413 before Express can give a structured error. */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/** MIME types accepted for upload — checked against the file's actual magic
 * bytes (content-sniffed via `file-type`), NOT just the declared
 * `Content-Type` or file extension (both of which a client can lie about).
 * Limited to image formats a small content site realistically needs; other
 * formats (PDF, video, audio) are out of scope for v1. */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Canonical extension for each accepted MIME type — used when constructing
 * the on-disk filename (`<uuid>.<ext>`). Must stay in sync with
 * `ALLOWED_MIME_TYPES`. */
export const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
