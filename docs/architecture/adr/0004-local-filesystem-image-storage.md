# ADR-0004: Local Filesystem for Image Storage over Object Storage

## Status

Accepted

## Context

Blog posts and events support uploaded images (event recap photos, event promo
images). The PRD explicitly leaves the storage backend choice open/TBD (PRD §10,
§13). Two realistic options exist for a single-VPS deployment:

1. **Local filesystem storage** — store uploaded files on the VPS's local disk,
   outside the SPA's static build output, served via a dedicated Nginx `location`
   block with content-type allow-listing and script-execution disabled in that
   directory.
2. **Object storage** — use an S3-compatible service (e.g., Linode Object Storage,
   AWS S3) to store and serve uploaded files, typically via a CDN.

Object storage adds a recurring cost line item and integration complexity (SDKs,
credentials, signed URLs, an additional external dependency to monitor and secure).
The organization is small-to-mid-size; its image volume (event recap photos, a
modest number of events per year) is very unlikely to stress local disk capacity for
years. The stack philosophy throughout (architecture.md §3, §11) favors
self-managed, no-additional-licensing-cost infrastructure on a single VPS.

## Decision

Store uploaded images on the **VPS's local disk**, in a directory **outside** the
SPA's web/build root, served through a dedicated Nginx `location /media/ { ... }`
block enforcing content-type allow-lists and disabling script execution in that
directory — **not** Linode Object Storage or any S3-compatible service.

## Consequences

**Positive:**
- Zero added recurring cost (no object storage billing line item).
- Zero added integration complexity — no SDKs, no signed-URL generation, no extra
  credentials to manage and rotate.
- Fully consistent with the "self-managed, no licensing cost" stack philosophy that
  governs the rest of the architecture (single VPS, single Postgres instance, no
  managed services).

**Negative / tradeoffs:**
- Local disk must be backed up alongside the database (already planned as part of
  the daily off-host backup routine — architecture.md §11.2) — this is additional
  backup-script surface area, not additional infrastructure.
- Disk space must be actively monitored as the blog/event media library grows over
  time (an operational task, not an architectural one).
- Horizontal scaling of the API tier — were it ever needed — would require shared
  storage (e.g., a network filesystem or a migration to object storage), since local
  disk is not shared between hosts. Not a concern for the single-VPS deployment
  target.
- **Operational hazard to actively guard against**: the uploads directory must live
  *outside* any path that `npm run build` (which clears/rewrites the SPA's `dist`)
  or `git pull` (which can reset tracked paths) could ever touch. This is flagged
  explicitly in `api/.gitignore`, the root `README.md`, and will be re-verified
  during deployment setup (Phase 10) — a build step silently wiping user-uploaded
  media is a well-known, entirely avoidable real-world deploy bug.

**Neutral / future-facing:**
- If image volume or redundancy requirements grow materially (e.g., disk pressure,
  desire for geographic redundancy, or a future need to horizontally scale the API),
  migrating to S3-compatible object storage is a contained change: swap the Media
  module's storage adapter behind its existing interface. URLs can remain stable if
  a CDN/redirect layer is introduced at the same time. The polymorphic `MediaAsset`
  model (ADR-0005) does not need to change for this migration.
