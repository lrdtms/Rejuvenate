# ADR-0001: Modular Monolith over Microservices

## Status

Accepted

## Context

Rejuvenate's backend needs to support several bounded sub-domains — authentication,
RBAC, blog, events, registrations, CMS, media, and users. The team is small/solo
(Conway's Law implications: a one-person or tiny team naturally produces — and can
only sustainably operate — a small number of deployable units). Expected traffic is
low (a small-to-mid-size community organization with two physical branches), there is
no requirement to scale sub-domains independently, and the deployment target is a
single self-managed Linode VPS (cost/operability constraints rule out a fleet of
services, an orchestrator, message brokers, etc.).

We must decide how to structure the backend: as a set of independently deployable
microservices (one per bounded context), or as a single application internally
organized into bounded modules.

## Decision

Build **one** Express application, internally organized into bounded sub-domain
modules (`auth`, `rbac`, `blog`, `events`, `registrations`, `cms`, `media`, `users`),
backed by a **single** PostgreSQL database — a *modular monolith*, not microservices.
Each module follows a consistent internal layering: router (interface adapter) ->
service (use-case / business rules) -> repository (Prisma persistence), with domain
rules living in the service layer.

## Consequences

**Positive:**
- One deployable unit — a single `git pull` / `npm ci` / `npm run build` /
  `pm2 reload` cycle deploys the entire backend (architecture.md §11).
- One database to back up, secure, and operate (simpler ops, simpler backups, simpler
  POPIA compliance surface).
- Trivial transactional consistency across modules — e.g., creating an `Event` and a
  related `MediaAsset` row, or checking `Registration` capacity and inserting a row,
  can happen inside a single Postgres transaction. This is materially harder (often
  requiring sagas/eventual consistency) across service boundaries.
- Lower operational complexity overall: no service discovery, no inter-service auth,
  no distributed tracing, no message broker to run/secure/monitor.

**Negative / tradeoffs:**
- Modules cannot be independently scaled, deployed, or owned. This is an explicit,
  accepted tradeoff — no current driver (traffic, team size, or organizational
  structure) demands independent scaling or deployment.
- A bug or resource exhaustion in one module can in principle affect the whole
  process (mitigated by careful coding, the layered architecture, and process
  supervision via PM2/systemd with restart policies).

**Neutral / future-facing:**
- If the organization grows dramatically (e.g., multiple branches each needing
  localized teams and independent deployment cadences), the bounded-context seams are
  already drawn at the module level. Extracting a module into its own service later is
  *possible* without a full rewrite — the module boundaries (router/service/repository,
  no cross-module reach-into-internals) are deliberately chosen to keep that option
  open, even though it is explicitly out of scope for v1.
