#!/usr/bin/env bash
#
# Deploy script skeleton for Rejuvenate (architecture.md §11 deploy sequence):
#   git pull -> npm ci -> npm run build -> prisma migrate deploy -> pm2 reload / systemctl restart
#
# STATUS: Phase 0 placeholder — NOT production-ready. Real paths, error handling,
# rollback strategy, and supervisor choice (PM2 vs systemd — see ../systemd/) are
# finalized and tested against the real VPS in Phase 10.
#
# CRITICAL: this script must NEVER touch the uploads directory. The uploads dir
# lives outside this checkout entirely (see ../README.md and ADR-0004) specifically
# so that nothing in this sequence — `npm ci`, `npm run build`, `git pull` — can ever
# delete or overwrite user-uploaded media. Do not "helpfully" add a step that copies,
# moves, or cleans the uploads directory here.

set -euo pipefail

# TODO (Phase 10): replace with the real checkout path on the VPS.
APP_DIR="/var/www/rejuvenate/app"
API_DIR="$APP_DIR/api"
WEB_DIR="$APP_DIR/web"

echo "==> [1/5] Pulling latest code"
cd "$APP_DIR"
git pull --ff-only

echo "==> [2/5] Installing API dependencies (reproducible install via lockfile)"
cd "$API_DIR"
npm ci

echo "==> [3/5] Building API"
npm run build

echo "==> [4/5] Running database migrations (deploy mode — no prompts, no dev-only behavior)"
npx prisma migrate deploy

echo "==> [4.5/5] Building SPA"
# TODO (Phase 10): confirm web/ build command and output directory once the
# frontend agent has scaffolded it; wire VITE_API_BASE_URL appropriately for prod.
cd "$WEB_DIR"
npm ci
npm run build

echo "==> [5/5] Reloading the API process"
# TODO (Phase 10): pick ONE supervisor and remove the other line.
# Option A — PM2:
#   pm2 reload rejuvenate-api
# Option B — systemd (see ../systemd/rejuvenate-api.service.example):
#   sudo systemctl restart rejuvenate-api
echo "TODO: invoke the chosen process supervisor's reload/restart command here"

echo "==> Verifying health"
# TODO (Phase 10): curl the real /healthz URL and fail the deploy (non-zero exit) if
# it does not report db: up within a reasonable timeout.
echo "TODO: curl https://TODO_REPLACE_WITH_REAL_DOMAIN/api/v1/healthz and assert status"

echo "==> Deploy complete"
