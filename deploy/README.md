# Deployment Scaffolding

This directory holds deployment artifacts for the single-VPS deployment described in
`architecture.md` §11: Nginx (TLS via Certbot, reverse-proxying `/api/*`, serving the
SPA build and `/media/*`), Node bound to `127.0.0.1` and supervised by PM2/systemd,
PostgreSQL on localhost, `ufw` restricted to ports 22 (key-auth)/80/443, and automated
daily off-host backups (`pg_dump` + uploads).

**Status: Phase 0 skeleton only.** These are placeholder/stub files establishing the
expected layout and documenting intent. Full, tested content is written in **Phase 10
(Deployment & Go-Live)** of `plan.md`, against the real target VPS. Do not copy these
files to a server as-is — they contain `TODO` markers and example values that must be
replaced with real configuration for your environment.

## Layout

```
deploy/
  nginx/      — Nginx server-block templates (TLS, SPA static serving, /api/* proxy,
                /media/* with content-type allow-list & script-execution disabled,
                security headers per architecture.md §12)
  systemd/    — systemd unit file (or PM2 ecosystem config) supervising the Node API
                process, bound to 127.0.0.1
  scripts/    — deploy script (git pull -> npm ci -> npm run build ->
                prisma migrate deploy -> pm2 reload / systemctl restart) and the
                automated daily backup script (pg_dump + uploads tarball, shipped
                off-host)
```

## CRITICAL — uploads directory placement (carried over from Phase 0)

**This is flagged here, in `api/.gitignore`, and again in Phase 10 because it is a
recurring, entirely avoidable real-world deploy bug: a build step silently wiping
user-uploaded media.**

The production uploads directory (ADR-0004: local filesystem image storage) **must
live outside**:
- the `api/` git checkout (so `git pull` can never reset/remove it), and
- the `dist/` build output directory (so `npm run build`, which clears and rewrites
  `dist/`, can never touch it), and
- the SPA's static build output directory that Nginx serves (same reasoning).

Recommended production layout (to be finalized in Phase 10):

```
/var/www/rejuvenate/
  app/              <- git checkout (api/ + built SPA assets live under here)
  uploads/          <- MediaAsset files — siblings of, not nested inside, app/
```

The API reads the uploads path from the `UPLOADS_DIR` environment variable (see
`api/.env.example`) — **always set it to an absolute path outside the checkout** in
any deployed environment (e.g. `/var/www/rejuvenate/uploads`). Nginx's `/media/`
location block must point at the same absolute path.

## What's stubbed here vs. what Phase 10 must do

| File | Phase 0 status | Phase 10 must |
|---|---|---|
| `nginx/rejuvenate.conf.example` | Skeleton server-block structure with TODOs | Fill in real domain, TLS cert paths (Certbot), proxy/static/media blocks, security headers, test with `nginx -t` |
| `systemd/rejuvenate-api.service.example` | Skeleton unit file with TODOs | Fill in real paths/user, environment file location, enable + start, verify restart-on-crash |
| `scripts/deploy.sh` | Skeleton deploy sequence with TODOs | Fill in real paths, test end-to-end against the VPS, wire to a runbook |
| `scripts/backup.sh` | Skeleton pg_dump + uploads backup with TODOs | Fill in real off-host destination (e.g., rsync/rclone to remote storage), schedule via cron/systemd timer, test restore procedure |

## Provisioning checklist (reference only — executed in Phase 10)

- Ubuntu LTS VPS, Node version matching the root `.nvmrc` installed (via nvm or
  NodeSource), PostgreSQL 16 on localhost, Nginx, Certbot.
- `ufw`: allow only 22 (key-auth only — disable password auth), 80, 443; deny
  everything else.
- PM2 or systemd supervising the Node process bound to `127.0.0.1`.
- `/healthz` wired into uptime monitoring.
- Daily automated `pg_dump` + uploads backup, shipped off-host (not just to local
  disk on the same VPS — that defeats the purpose of a backup).
