# Rejuvenate

Rejuvenate is a church/community web application: a public site (Home, About, Cape
Town, Durban, Contact, Blog, Events) plus an authenticated admin backend for staff
(Admins, Bloggers, Event Managers) to manage blog posts, events, registrations, and
defined CMS content areas — without developer involvement for routine updates.

This repository is mid-rewrite from a static HTML/CSS/JS site (still at the repo
root — `index.html`, `about.html`, `cape-town.html`, `durban.html`, `contact.html`,
`styles.css`, `script.js`, `Reference/`) to a dynamic application:

- **`api/`** — Node + Express + TypeScript backend, a modular monolith (ADR-0001)
  organized into bounded modules (`auth`, `rbac`, `blog`, `events`, `registrations`,
  `cms`, `media`, `users`), backed by PostgreSQL 16 via Prisma.
- **`web/`** — React + TypeScript SPA (Vite), built to static assets and served by
  Nginx (ADR-0003). *(Scaffolded separately by the frontend specialist.)*

Authoritative documents (read these first, in order, before making architectural
changes): [`prd.md`](./prd.md), [`rejuvenate-architecture.md`](./rejuvenate-architecture.md),
[`plan.md`](./plan.md), and the ADRs in [`docs/architecture/adr/`](./docs/architecture/adr/).

> The legacy static site at the repo root remains in place as a branding/parity
> reference until the SPA is verified pixel-equivalent. **Do not delete it yet** — a
> later phase archives it under `legacy-static-site/` once the SPA supersedes it
> (see `plan.md` Phase 0).

## Repository layout

```
/
  api/                      Node + Express + TS backend (modular monolith)
  web/                      React + TS (Vite) SPA
  Reference/                Brand assets (logo, images) — design-system asset source
  docs/architecture/adr/    Architecture Decision Records (MADR format)
  deploy/                   Nginx templates, systemd unit, deploy/backup script skeletons
  docker-compose.yml        Local Postgres 16 for dev/test parity (architecture.md §11.3)
  index.html, about.html, ...   Legacy static site (kept for branding parity reference)
  architecture.md / rejuvenate-architecture.md / prd.md / plan.md   Authoritative docs
```

`api/` and `web/` are **independent projects with their own lockfiles** — there is no
root-level workspace tooling (npm/pnpm workspaces). This is a deliberate choice for a
solo-operator setup (see `plan.md` Phase 0, step 4): lower friction, no cross-project
hoisting surprises, and `npm ci` in each project is fully reproducible from its own
committed `package-lock.json`.

## Local development

### Prerequisites

- Node.js — see [`.nvmrc`](./.nvmrc) for the pinned version (`nvm use`). The same
  major version must be on the production VPS (Phase 10).
- Docker — for the local Postgres 16 instance. Or a locally-installed Postgres 16
  configured to match the credentials in `api/.env.example`.

### 1. Start the database

```sh
docker compose up -d
```

Starts a `postgres:16` container on `127.0.0.1:5432` with the credentials from
`api/.env.example`. Data persists in a named Docker volume across restarts;
`docker compose down -v` wipes it for a clean slate.

### 2. Start the API

```sh
cd api
cp .env.example .env          # fill in SESSION_SECRET at minimum; all other defaults work for local dev
npm install
npm run prisma:generate       # generate the Prisma client from schema.prisma
npm run prisma:deploy         # apply all migrations to the local DB
npm run prisma:seed           # create the bootstrap ADMIN account + CMS slot registry rows
npm run dev                   # tsx watch — reloads on every file change
```

The API listens at **`http://localhost:3000`**. Confirm it's healthy:

```
GET http://localhost:3000/api/v1/healthz  →  200 OK
```

> **Bootstrap admin credentials**: `prisma:seed` prints the ADMIN email and a
> randomly-generated temporary password to the console **once**. Note it before the
> output scrolls — you need it to log into `/admin`.

### 3. Start the SPA

```sh
cd web
cp .env.example .env          # VITE_API_BASE_URL defaults to http://localhost:3000 — correct for local dev
npm install
npm run dev                   # Vite dev server with HMR
```

The SPA is served at **`http://localhost:5173`**. The admin area is at `/admin`.

### Useful scripts

| Directory | Command | What it does |
|---|---|---|
| `api/` | `npm test` | Run the full Vitest suite |
| `api/` | `npm run typecheck` | TypeScript type-check (no emit) |
| `api/` | `npm run lint` | ESLint |
| `api/` | `npm run prisma:migrate` | Create a new migration interactively (dev only) |
| `api/` | `npm run prisma:seed` | Re-seed (idempotent — safe to re-run on existing data) |
| `web/` | `npm run typecheck` | TypeScript type-check |
| `web/` | `npm run lint` | ESLint |
| `web/` | `npm run build` | Production build into `web/dist/` |

## Configuration

Both `api/` (and eventually `web/`) use `.env` files that are **gitignored** —
copy the committed `.env.example` to `.env` and fill in real values locally. **Never
commit `.env` or any real secret to version control.**

`api/.env.example` documents: `NODE_ENV`, `PORT`, `DATABASE_URL`, `SESSION_SECRET`,
`SMTP_*` (outbound email), and `UPLOADS_DIR`.

## ⚠️ Uploads directory — read this before touching deploy tooling

**The production uploads directory must never live inside any path that `npm run
build` or `git pull` could clobber.** This is called out here, in `api/.gitignore`,
and in [`deploy/README.md`](./deploy/README.md) because it is a recurring,
entirely-avoidable real-world deploy bug: a build step (which clears/rewrites
`dist/`) or a `git pull` (which can reset tracked paths) silently wiping
user-uploaded media.

In any deployed environment, `UPLOADS_DIR` (see `api/.env.example`) **must be an
absolute path outside the `api/` checkout** — e.g. `/var/www/rejuvenate/uploads`,
a sibling of the app checkout, never nested inside it. Nginx's `/media/` location
block (see `deploy/nginx/`) must point at the exact same absolute path. This is
revisited and finalized against the real VPS in Phase 10 (`plan.md`).

## Architecture & decisions

- [`rejuvenate-architecture.md`](./rejuvenate-architecture.md) — authoritative
  architecture document (component view, data model, API design, auth/RBAC, security
  & POPIA, deployment).
- [`docs/architecture/adr/`](./docs/architecture/adr/) — individual ADRs (MADR
  format) for the seven major decisions: modular monolith, session-based auth,
  static-built SPA, local filesystem image storage, polymorphic `MediaAsset` table,
  dormant paid-ticketing fields, and named-slot CMS.
- [`plan.md`](./plan.md) — phased implementation plan.
