#!/usr/bin/env bash
#
# Automated daily off-host backup skeleton (architecture.md §11.2):
#   pg_dump (database) + uploads directory tarball, shipped OFF this host.
#
# STATUS: Phase 0 placeholder — NOT production-ready. Real paths, retention policy,
# off-host destination (e.g., rsync/rclone to remote object storage or another host),
# and a TESTED restore procedure are finalized in Phase 10. A backup that has never
# been restored from is not a backup — Phase 10 must include a documented, rehearsed
# restore drill.
#
# Schedule via cron or a systemd timer (decide and document the choice in Phase 10).
# Example cron line (NOT installed by this script):
#   0 3 * * *  /var/www/rejuvenate/app/deploy/scripts/backup.sh >> /var/log/rejuvenate-backup.log 2>&1

set -euo pipefail

# TODO (Phase 10): replace with real values for the target VPS.
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="/var/backups/rejuvenate"
DB_NAME="rejuvenate"
DB_USER="rejuvenate"
UPLOADS_DIR="/var/www/rejuvenate/uploads"   # MUST match api/.env's UPLOADS_DIR
OFFHOST_DEST="TODO_REPLACE_WITH_OFFHOST_DESTINATION"  # e.g. rclone remote, rsync target

WORKDIR="$BACKUP_ROOT/$TIMESTAMP"
mkdir -p "$WORKDIR"

echo "==> [1/3] Dumping database ($DB_NAME)"
pg_dump -U "$DB_USER" -F c -f "$WORKDIR/db.dump" "$DB_NAME"

echo "==> [2/3] Archiving uploads directory"
tar -czf "$WORKDIR/uploads.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"

echo "==> [3/3] Shipping backup off-host"
# TODO (Phase 10): replace with a real off-host transfer, e.g.:
#   rclone copy "$WORKDIR" "$OFFHOST_DEST/$TIMESTAMP"
# or:
#   rsync -avz "$WORKDIR/" "user@remote-host:/path/to/backups/$TIMESTAMP/"
echo "TODO: ship $WORKDIR to $OFFHOST_DEST"

# TODO (Phase 10): prune local copies older than the retention window (decide a
# sensible local-retention policy — off-host is the durable copy, local is a
# convenience cache for fast restores).
echo "TODO: prune backups in $BACKUP_ROOT older than the retention window"

echo "==> Backup complete: $WORKDIR"
