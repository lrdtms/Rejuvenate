# Rejuvenate — Implementation Plan

> Companion to `prd.md` and `architecture.md` · Status: In Progress · Last updated: 2026-06-09
> Author: Planning Agent · Audience: implementation team (stack-specialist agent / contracted developer)
>
> **Progress snapshot (2026-06-09)**: Phases 0–6 complete on `feature/dynamic-rewrite` — all backend modules done and public site fully wired to live data. Backend: 397/397 tests passing. Frontend: Phases 5 (design-system) and 6 (public pages + RSVP) done; Phases 7–8 (admin area) pending. Infrastructure/POPIA/launch: Phases 9–11 pending.

## Guiding Principles for Sequencing

1. **Backend-before-frontend-integration**: the SPA's public pages can be scaffolded early (porting branding) in parallel with backend work, but anything that *fetches data* (Blog, Events, CMS slots, RSVP, Admin) is blocked on the corresponding API module + Prisma model existing and being migrated.
2. **Schema-first**: Prisma schema/migrations gate almost everything — auth needs `User`+session store, blog needs `BlogPost`+`User`, events need `Event`, registrations need `Event`+`Registration`, CMS needs `CMSContent`, media needs `MediaAsset`. Get the full schema right in one pass (per ADR-0006, add dormant `isPaid`/`price` now — cheap before rows exist).
3. **Auth/RBAC before any protected route**: every admin module (blog admin, events admin, registrations view, CMS editor, users) depends on `requireAuth()`/`requireRole()` existing and on the SPA's `RequireAuth`/`RoleGuard` + session-aware API client.
4. **Resolve open questions at the *latest responsible moment*, not "eventually"**: some (POPIA retention) are hard go-live blockers for specific phases; others (Blogger cross-author edit) are one-line service changes that can ship with a safe default and be flipped later.
5. **Branding port is a parallel, low-risk early task**: the design-system layer has no backend dependency — it's a pure CSS/markup transcription exercise and should start as soon as the Vite scaffold exists.

---

## Phase 0 — Project Scaffolding & Repo Structure ✅ COMPLETED (2026-06-07)

> Done on `feature/dynamic-rewrite`: top-level layout (`api/`, `web/`, `docs/architecture/adr/`, `deploy/`), `api/` Express+TS skeleton with pinned deps and a passing healthz/error-shape smoke test, `web/` Vite+React+TS skeleton with the §10.1 directory structure and pinned deps, `docker-compose.yml` (postgres:16), `.nvmrc` (Node 22 LTS), root `README.md`, and all 7 ADRs written in `docs/architecture/adr/`. Lint/typecheck/build verified clean on both `api/` and `web/`. Not yet committed to git.

**Goal**: Establish the monorepo layout, tooling, and CI-less local dev loop before any feature code.

Steps:
1. Decide and create top-level layout. Recommended (keeps the existing static HTML as historical reference, doesn't mix concerns):
   ```
   /
     api/                  — Node + Express + TS backend (modular monolith)
     web/                  — React + TS (Vite) SPA
     Reference/            — existing brand assets (logo, images) — keep, becomes design-system asset source
     docs/architecture/adr/ — write the 7 ADRs as individual MADR files (architecture.md §13 says "should be written")
     deploy/               — Nginx config templates, PM2/systemd unit files, backup scripts, deploy script
     architecture.md, prd.md  — keep at root (already authoritative)
   ```
   (The existing `index.html` etc. at root can be archived under e.g. `legacy-static-site/` once the SPA supersedes them — don't delete immediately; keep as a reference for branding parity checks until the SPA is verified pixel-equivalent.)
2. **`api/`**: `npm init`, TypeScript config, ESLint/Prettier, `tsx`/`ts-node-dev` for dev reload, `.env.example` (DATABASE_URL, SESSION_SECRET, SMTP_*, NODE_ENV, PORT), `.gitignore` covering `.env`, `node_modules`, `dist`, `uploads/`.
3. **`web/`**: `npm create vite@latest` with React+TS template, ESLint/Prettier aligned with `api/`, `.env.example` for `VITE_API_BASE_URL`.
4. Root-level `package.json` workspaces (npm/pnpm workspaces) OR keep them fully independent — pick based on whether a single `npm install` at root is wanted. Given solo-developer simplicity (Conway's Law driver in architecture.md §3), independent folders with their own lockfiles is the lower-friction default; document the dev startup commands in a root `README.md`.
5. Local dev database: Docker Compose file for Postgres 16 (architecture.md §11.3 recommends Dockerized Postgres for dev parity) — `docker-compose.yml` at root with a `postgres:16` service, named volume, exposed on localhost. Pin the image to `postgres:16` (not `:latest`) so dev matches the production major version exactly.
6. Write `docs/architecture/adr/0001-modular-monolith.md` ... `0007-named-slot-cms.md` — transcribe the 7 ADR summaries from architecture.md §13 into individual MADR documents now (it's pure documentation work, fast, and "should be written as the project repo is set up" per the doc).
7. **Pin core dependency versions explicitly now** (don't let `npm init`/Vite scaffolds drift): `express`, `prisma`/`@prisma/client`, `zod`, `argon2`, `express-session`, `connect-pg-simple`, `helmet`, `express-rate-limit`. Lock-files (`package-lock.json`) must be committed for both `api/` and `web/` — reproducible installs matter for a solo-operator deploy pipeline (`npm ci` in Phase 10 step 6 depends on a committed lockfile existing).
8. Confirm Node.js LTS version to target (e.g., 20.x or 22.x) and record it in an `.nvmrc`/`engines` field in both `package.json`s — the VPS provisioning step (Phase 10) must install the same major version.

**Critical files**: `api/package.json`, `api/tsconfig.json`, `web/package.json`, `web/vite.config.ts`, `docker-compose.yml`, `.gitignore`, `.nvmrc`, `README.md`

**Dependency note**: Nothing downstream is blocked by the ADR docs — do them opportunistically, e.g., interleaved with Phase 1.

**Backend Review Note**: The plan correctly defers root-level workspace tooling to taste, but be careful that `api/.gitignore` excludes `uploads/` (local dev media) AND that the *production* uploads directory is never inside `api/dist` or any path `npm run build`/`git pull` could clobber — this is a recurring real-world deploy bug (a build step wiping user-uploaded media). Call this out explicitly in the `README.md`/deploy docs, and again in Phase 10.

---

## Phase 1 — Database Schema & Prisma Setup ✅ COMPLETED (2026-06-07)

> Done on `feature/dynamic-rewrite`: full `schema.prisma` (6 models, 6 enums, indexes, FK `onDelete` behaviors, documented session-store decision — `connect-pg-simple` owns its table outside Prisma's migration history), initial migration applied to local dev Postgres, idempotent `seed.ts` (bootstrap ADMIN with one-time-printed random password + the 6 fixed CMS slot registry rows), and `db.ts` rewritten from the Phase-0 lazy-require shim into a properly typed `PrismaClient` singleton with the `globalThis` hot-reload guard (with `/healthz` updated to a real `SELECT 1` check). All work reviewed for spec compliance and code quality, lint/typecheck/build verified clean. Commits: `35677b9`, `e19c6d6`, `1d0895e`, `24a020a`, `8fee71f`.

**Goal**: One complete, reviewed Prisma schema capturing the full data model from architecture.md §7 — migrated once, correctly, before any module depends on it.

Steps:
1. `api/prisma/schema.prisma`: define all six models — `User`, `BlogPost`, `Event`, `Registration`, `CMSContent`, `MediaAsset` — plus enums (`Role`, `BlogStatus`, `Branch`, `EventStatus`, `MediaOwnerType`, `CMSFormat`).
   - Encode every field/constraint from architecture.md §7.2 exactly: `User.passwordHash` (argon2id), `User.isActive`; `BlogPost.slug` unique, `status`/`publishedAt`; `Event.isPaid`/`price` (dormant, default false/null, **store price as integer ZAR cents** — name the column `priceCents` or similar to make the unit unambiguous in code); `Registration` — **no FK to User**, `firstName`/`surname`/`age` (Int)/`email`/`phone`/`consentVersion`/`retainUntil` (nullable DateTime); `CMSContent.slotKey` unique, `format` enum, `value` text, `lastEditedById`; `MediaAsset.ownerType`/`ownerId` (no DB-level polymorphic FK — see ADR-0005, integrity is app-layer).
   - **Note the architecture.md ER diagram names the Registration columns `firstName`/`surname`** (not `name`/`surname` as the PRD §9 loosely states) — follow architecture.md (it is authoritative per this team's brief); just flagging so nobody "fixes" the schema to match the looser PRD wording.
   - Add explicit `@@index` definitions now (not as an afterthought): `BlogPost(status, publishedAt)` for the public list query, `Event(status, startsAt, branch)` for the public/filtered list, `Registration(eventId)` (heavily queried for headcount/attendee-list/capacity-check), `MediaAsset(ownerType, ownerId)`. Cheap to add pre-launch, painful to add as an online migration once tables have rows and the site is live.
   - Decide and record `onDelete` behavior for every FK now (e.g., `BlogPost.authorId → User`, `Event.createdById → User`, `CMSContent.lastEditedById → User`): given `User.isActive` soft-delete is the documented pattern (no hard deletes of staff accounts), `Restrict` or `SetNull` is likely correct — `Cascade` would silently destroy authored content if a user row is ever removed. Get this right in the initial migration; changing FK delete behavior later on a live table is disruptive.
   - Use `Decimal`/`Int` (not floating point) for `Event.price` — confirm the Prisma column type maps to an integer (`Int` for cents, as the architecture specifies "nullable integer ZAR cents") rather than `Decimal`, which the ER diagram's pseudocode loosely calls `decimal` but architecture.md §7.2 clarifies should be "stored as integer cents."
2. Add a session-store table (e.g., via `connect-pg-simple`'s expected `session` table schema, or a Prisma-modeled `Session` table) — required for ADR-0002 (server-side sessions backed by Postgres). **Decision needed**: if using `connect-pg-simple`, its `session` table is created/managed by the library's own SQL script, NOT by Prisma migrations — decide now whether to (a) let `connect-pg-simple` manage its table outside Prisma's migration history (simplest, but means `prisma migrate deploy` won't show you that table), or (b) hand-write a Prisma model that matches the expected `session` table shape and let Prisma own it. Document the choice in the schema file as a comment — this is a common source of confusion six months later.
3. Write the **initial migration**: `npx prisma migrate dev --name init`.
4. Write a **seed script** (`api/prisma/seed.ts`) that creates:
   - One initial `ADMIN` user (so there's a way into the system — bootstrap problem; document the seed credentials and force a password change on first login). **Never commit a real password or hash to the repo** — generate a random password at seed-time, print it once to the console/log, and require a change on first login (or read the bootstrap password from an environment variable that is itself gitignored).
   - The **fixed CMS slot registry** rows: `about.card.who-are-we`, `about.card.what-we-do`, `about.card.get-involved`, `contact.capeTown.card`, `contact.durban.card`, `contact.page.details` (and confirm/adjust slot keys after walking the real `cape-town.html`/`durban.html` markup — this is **fitness-function item #3 from architecture.md §15**, do it now while writing the seed, since it directly determines slot key names).
   - Make the seed **idempotent** (`upsert` on unique keys, not `create`) — it will be run more than once (fresh dev DBs, CI, possibly production bootstrap) and must not error or duplicate rows on a second run.
5. Set up Prisma Client generation in the build pipeline; add a typed `db.ts` singleton client module. Confirm the singleton pattern guards against the well-known Prisma-Client-in-dev-hot-reload issue (multiple client instances exhausting DB connections) — store the client on `globalThis` in non-production environments.

**Open question to resolve here**: none of the §14 open questions block schema creation — the schema as specified already accounts for all of them (dormant `isPaid`/`price`, `consentVersion`/`retainUntil` present regardless of the retention-period decision). **Do not block on POPIA retention period to write the schema** — `retainUntil` is just a nullable `DateTime`; the *value-setting policy* (how far in the future) is what's blocked, and that's a Phase 7/8 concern (purge job — actually Phase 9, see below; the original cross-reference to "Phase 7/8" here is off by a phase number, corrected).

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\api\prisma\schema.prisma`
- `C:\Users\Admin\Projects\Rejuvenate\api\prisma\seed.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\prisma\migrations\<timestamp>_init\migration.sql`

**Backend Review Note**: This phase says "migrated once, correctly" — in practice expect at least one early follow-up migration once Phase 4 module-building surfaces gaps (e.g., a missing index, a forgotten `@@unique([eventId, email])` consideration for the soft duplicate-guard — see Phase 4c note). That's normal and fine; the goal is to get the *shape* right, not to achieve a literal zero-migration-after-init outcome. Don't let "get it right in one pass" become a reason to over-analyze before writing code — Prisma migrations on a pre-launch schema (no real user rows yet) are cheap.

---

## Phase 2 — Backend Application Skeleton, Validation & Error Conventions

**Goal**: The Express app shell, shared conventions, and cross-cutting concerns that every module will use — built once, reused everywhere.

Steps:
1. `api/src/app.ts` (Express app factory) + `api/src/server.ts` (listen, bound to `127.0.0.1` per architecture.md §11.2).
2. Global middleware: JSON body parsing, cookie parsing, CORS (same-origin in prod; permissive for local dev against Vite on a different port — but be precise: `credentials: true` + an explicit allow-listed origin from env, never `origin: '*'`, since cookies require credentialed CORS), security headers (helmet), request logging (e.g., `pino`/`morgan` — pick one now; ensure it does NOT log request bodies wholesale, since RSVP/login bodies contain personal data and credentials — log request method/path/status/duration only, never the body).
3. **Error-shape convention**: a shared `AppError` class hierarchy and an error-handling middleware producing `{ error: { code, message, fields? } }` (architecture.md §8) — every module's router/service should throw typed errors that funnel into this. Also define the **HTTP status code mapping** explicitly here (e.g., `ValidationError → 400`, `AuthError/Unauthenticated → 401`, `ForbiddenError → 403`, `NotFoundError → 404`, `ConflictError/CapacityExceededError → 409`, `UnknownSlotError → 400`) — get this taxonomy agreed before modules start throwing ad-hoc errors that don't fit cleanly.
4. **Validation layer**: Zod schema conventions — a `validate(schema)` middleware factory that parses `req.body`/`req.params`/`req.query` and forwards Zod errors into the `fields` shape. Establish the convention that **shared Zod schemas live in a location both the service layer and (conceptually) the frontend can reference** (e.g., `api/src/modules/<module>/<module>.schemas.ts`, exported and potentially published/copied for the SPA's mirrored client-side validation per Phase 5 step 6) — decide now whether schemas are duplicated (simplest, but can drift) or shared via a small published package/copy-step (more correct, more setup). Either is acceptable; just decide explicitly rather than let it happen by accident per-module.
5. `/healthz` endpoint checking DB connectivity (architecture.md §11.2 — needed for the external uptime monitor later). Make it a true dependency check (e.g., `SELECT 1` via Prisma) with a short timeout, returning 200 only when the DB responds — a `/healthz` that always returns 200 regardless of DB state is worse than no health check (false confidence). Mount it *before* the auth/session middleware so an external monitor doesn't need credentials and a DB outage doesn't also break session-store lookups for the health check itself.
6. API versioning: mount everything under `/api/v1`.
7. Rate-limiting middleware setup (e.g., `express-rate-limit`) — generic factory to be applied per-route later (login, RSVP). **Decide the store now**: the default in-memory store resets on every `pm2 reload`/restart and won't work correctly if the process is ever run with multiple instances — for a single-instance Node process behind Nginx this is probably acceptable (YAGNI on a Redis-backed store), but document the limitation explicitly so a future "why did rate limiting reset" question has a documented answer. Also confirm Nginx is configured to pass the real client IP (`X-Forwarded-For`/`trust proxy` setting in Express) — rate-limiting by IP is meaningless if every request appears to come from `127.0.0.1` (the Nginx proxy).

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\api\src\app.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\middleware\errorHandler.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\middleware\validate.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\lib\db.ts`

**Dependency**: blocks every feature module below (they all mount onto this app and use these conventions).

**Shared-Zod-schema-location decision (step 4) — recorded**: schemas are **duplicated per
module**, not published/shared via a copy-step — `api/src/modules/<module>/<module>.schemas.ts`
on the backend, hand-mirrored in `web/src/shared/schemas/*.schema.ts` on the frontend (per
Phase 6's `rsvp.schema.ts` critical file). Rationale (small solo-operator codebase, independent
`api`/`web` lockfiles with no workspace boundary to slot a shared package into, server is the
actual validation boundary so drift risk is low and one-line-fixable) is written out in full in
the doc-comment at the top of `api/src/middleware/validate.ts` — Phase 4 module authors should
read that comment before creating their first `.schemas.ts` file so this isn't reinvented
per-module.

**Backend Review Note**: Add `app.set('trust proxy', 1)` (or the appropriate value) as an explicit step here — it's easy to forget, and without it, `express-rate-limit`, `express-session`'s `secure` cookie detection, and any IP-based logic will all silently misbehave behind Nginx. This single line is a recurring source of "rate limiting doesn't work in production but works locally" bugs.

## Phase 2 — Backend Application Skeleton, Validation & Error Conventions ✅ COMPLETED (2026-06-07)

> Done on `feature/dynamic-rewrite`: global middleware (`trust proxy 1`, `pino`/`pino-http` structured request logging mounted first so even body-parse-error requests are logged with cookies/auth headers redacted, credentialed CORS via an env-sourced `CORS_ALLOWED_ORIGIN` allow-list, `cookie-parser`, `express.json()`); the error taxonomy in `lib/errors.ts` extended with `validationError`/`capacityExceeded`/`unknownSlot`/`tooManyRequests` factories plus a single reference-table doc-comment documenting the full agreed status-code/`code`/factory contract for every module to throw into; a `validate({ body?, params?, query? })` Zod middleware factory (`middleware/validate.ts`) that aggregates issues from all three request parts into one `fields` map and forwards through the existing `AppError`/central-error-handler pipeline (the shared-Zod-schema-location decision is recorded just above and in that file's doc-comment); a generic, unmounted `rateLimiter({ windowMs, max })` factory (`middleware/rateLimit.ts`) using the default in-memory store with its single-instance/restart-reset limitation documented inline, shaping `429`s as `{ error: { code: 'RATE_LIMITED', message } }`; and `/healthz` hardened with a 2.5s `Promise.race` timeout (with proper timer cleanup) so a hung DB connection degrades to `503` rather than hanging the probe. All four tasks reviewed for spec compliance and code quality (one real defect found and fixed in each of the logging-order and timer-cleanup areas — see commit messages), lint/typecheck/test/build verified clean (38 tests passing). Commits: `5cbdb8e`, `4b0fce8`, `089ce2f`, `e86dd9f`, `275de55`, `a1c770f`.

---

## Phase 3 — Auth Module + RBAC Middleware ✅ COMPLETED (2026-06-08)

> **Progress on `feature/dynamic-rewrite`** — all six steps (session store, password hashing, `AuthService`, routes, RBAC middleware, ownership helpers) done, tested (108/108 passing, including 59 new tests), and verified clean against `typecheck`/`lint`/`test`/`build`.
>
> - ✅ **Step 1 (Session store)**: `modules/auth/session.ts` — `express-session` + `connect-pg-simple` against the Postgres `session` table (per the schema.prisma decision-record / `createTableIfMissing: true`), custom cookie name `rejuvenate.sid`, `cookie.secure` derived explicitly from `NODE_ENV === 'production'` (deliberately not `'auto'` — see file's doc-comment for the proxy-misconfiguration safety argument), `httpOnly`/`sameSite: 'lax'`, rolling idle timeout (`IDLE_TIMEOUT_MS` = 2h) bridged with a custom absolute-max-age ceiling (`ABSOLUTE_MAX_AGE_MS` = 12h via `enforceAbsoluteSessionMaxAge()`, since `express-session` has no native concept of one). Mounted as `router.use(...)` on the `/api/v1` router *after* `/healthz` is registered on the same router — resolving the "`/healthz` must stay reachable without touching the session store" tension via Express's same-router registration-order dispatch (documented inline in `app.ts` at the mount site) rather than any special-casing.
> - ✅ **Step 2 (Password hashing)**: `modules/auth/password.ts` — `hashPassword`/`verifyPassword` wrapping `argon2`, with EXPLICIT pinned argon2id parameters (`memoryCost: 12_288` / `timeCost: 3` / `parallelism: 1` — OWASP's "much less memory available" profile, sized to a small shared-RAM Linode VPS per architecture.md §11, with the DoS-via-memory-hard-hashing trade-off reasoned through in the file header) rather than library defaults (which can silently change between `argon2` major versions).
> - ✅ **Step 3 (`AuthService`)**: `modules/auth/auth.service.ts` — `createAuthService({ db, mailService, logger })` factory exposing `login`/`logout`/`getCurrentUser`/`requestPasswordReset`/`confirmPasswordReset`.
>   - **`PasswordResetToken` decision (resolved — Option "additive migration", as recommended in the step-3 note below)**: added a first-class `PasswordResetToken` model (`prisma/schema.prisma`, migration `20260608074846_add_password_reset_token`) rather than an in-memory map, for the same durability/single-system-of-record/referential-integrity reasons the `session` table exists — tokens must survive PM2 reloads and be queryable for cleanup. Modeled with a SHA-256 `tokenHash` (not the raw token — mirrors "never store the secret, store a one-way derivation of it," same posture as password hashing but using a fast hash since the token itself is high-entropy random, not low-entropy user input) plus a nullable `usedAt` tombstone (not a delete — preserves an audit trail of redemption/supersession and avoids a race between "check-not-used" and "delete"). The migration was generated via `prisma migrate diff --from-url ... --to-schema-datamodel ... --script` (because `prisma migrate dev` refuses to run non-interactively) and then HAND-EDITED to remove a spurious `DROP TABLE "session"` statement the diff incorrectly proposed — `session` is owned by `connect-pg-simple` outside Prisma's migration history, and the false positive is now documented inline in the migration file so nobody "fixes" it back in.
>   - `login`: generic `unauthorized('Invalid email or password')` for every failure mode (no such user / wrong password / `isActive: false`) — collapsed to one message/status so the response can't be used to enumerate accounts. Runs `verifyPassword(DUMMY_ARGON2_HASH, password)` even when no user is found, so a nonexistent-email attempt costs the same wall-clock time as a real password check (timing-attack defense — `DUMMY_ARGON2_HASH` is a REAL argon2id hash generated with the pinned parameters against a fixed throwaway plaintext, verified to return `false` for arbitrary input).
>   - `getCurrentUser(userId)`: a fresh `findUnique` on every call, returning `null` for "not found" OR "`isActive: false`" — this is the SINGLE SHARED PRIMITIVE that `GET /me`, `requireAuth`, and `requireRole` all delegate to, which is what makes "deactivation takes effect immediately for already-logged-in sessions" actually true rather than aspirational (no caching, no session-snapshot of role/active-state — verified by a dedicated "re-reads the user fresh on every call" test plus a router-level "mid-session deactivation" integration test).
>   - `logout(sessionId)`: deletes the row from the `session` table directly (`DELETE FROM "session" WHERE "sid" = ...`).
>   - `requestPasswordReset(email)` / `confirmPasswordReset(token, newPassword)`: enumeration-safe by construction — `requestPasswordReset` ALWAYS returns the identical `{ message: PASSWORD_RESET_REQUEST_ACK_MESSAGE }` regardless of whether the account exists, is active, or the email send succeeds (verified by a dedicated test asserting byte-identical status/body/shape for an existing vs. nonexistent account — the exact test the brief required); old unused tokens are superseded (`usedAt` stamped) whenever a new one is issued; `confirmPasswordReset` collapses "unknown token" / "expired" / "already used" / "account deactivated since issuance" into one generic `unauthorized(...)`, and atomically marks-used + supersedes-siblings + updates the password hash inside a single `db.$transaction([...])`.
>   - `modules/auth/mail.service.ts`: minimal `MailService` interface + `ConsoleMailService` (logs via the shared `pino` logger) — the stub the step-3 open question recommended; `env.SMTP_*` exist but are deliberately unused pending a provider decision (flagged inline).
> - ✅ **Step 4 (Routes)**: `modules/auth/auth.router.ts` (`createAuthRouter({ authService })`) + `modules/auth/auth.schemas.ts` (Zod schemas, incl. `MIN_PASSWORD_LENGTH = 12`). All five routes wired and mounted in `app.ts` on the `/api/v1` router immediately after sessions: `POST /auth/login` (regenerates the session — fixation defense — then stamps `userId`; rate-limited per IP+email via a custom `keyGenerator`, `max: 10` / 15 min), `POST /auth/logout` (idempotent — 204 even with no session), `GET /me` (returns `{ user: null }` for anonymous callers — 200, deliberately NOT 401, since "am I logged in" is a routine UI query, not an authorization failure), `POST /auth/password-reset/request` (rate-limited, `max: 5` / 15 min, always 200 with the generic ack message), `POST /auth/password-reset/confirm` (deliberately NOT rate-limited — the token's 256-bit entropy is the actual defense; rate-limiting it would mostly inconvenience legitimate users retrying a copy-paste).
> - ✅ **Step 5 (RBAC middleware)**: `middleware/rbac.ts` — `requireAuth(authService)` (401 `unauthorized()` if no session, no `userId` on the session, or `getCurrentUser` resolves to `null` — which by design covers BOTH "user deleted" and "user deactivated") and `requireRole(authService, ...roles)` (same 401 checks PLUS 403 `forbidden()` on role mismatch — performs its own full authentication check rather than assuming `requireAuth` ran first, so it's safe to use standalone). Both attach `req.user: AuthenticatedUser` on success (Express namespace augmentation). Deliberately shaped both factories as `fn(authService, ...)` for call-site consistency (reshaped `requireRole` from an initially-curried `(...roles) => (authService) => ...` design). Unit-tested against hand-rolled mock `req`/`res`/`next` and a fake `AuthService` — see `middleware/rbac.test.ts`'s decision-matrix table covering every combination of (no session / ghost session / wrong role / right role) × (`requireAuth` / `requireRole`).
>   - Note: not yet applied globally to an `/api/v1/admin/*` prefix as step 5's text suggests — no admin routes exist yet (Phase 4+). The middlewares are built, exported, and unit-tested as the "building blocks Phase 4 will apply globally," per the brief's framing; wiring them onto real route prefixes happens as those prefixes are built.
> - ✅ **Step 6 (Ownership helpers)**: `modules/auth/ownership.ts` — `canEditPost(user, post): boolean` → `post.authorId === user.id || user.role === 'ADMIN'`, taking a minimal `OwnedPost = { authorId: string }` projection (callers don't need a full `BlogPost` row for an authorization pre-check). Decision-matrix-tested in `ownership.test.ts` (author-edits-own / non-author-denied / Admin-override / Admin-editing-own / Event-Manager-denied-elsewhere). Doc-comments document the SYMMETRIC pattern Phase 4e's `MediaService.upload` must follow: validate the client-supplied `ownerId` against the actual owning resource (don't trust it blindly) and run an analogous ownership predicate before persisting — flagged as a likely-to-be-missed gap since the architecture brief's ownership language focuses on blog posts.
>
> **Deviations from the plan / decisions made along the way** (flagged for review, none blocking):
> - The `PasswordResetToken` model was added as a genuine schema migration rather than left as an open question — this seemed clearly preferable to an in-memory map (which would not survive a `pm2 reload`, breaking any in-flight reset for users mid-flow during a deploy) and mirrors the project's existing "durable, Postgres-backed, single system of record" posture (ADR-0002's session-store precedent). Flagged here in case a reviewer wants to revisit the TTL (`PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000`, i.e. 30 minutes) or token byte-length (`RESET_TOKEN_BYTES = 32`, 256 bits).
> - `requireRole`'s argument order (`requireRole(authService, ...roles)`, not `requireRole(...roles)(authService)`) is a small ergonomic call I made for consistency with `requireAuth(authService)` — documented inline in `rbac.ts`.
> - Global `requireAuth()` mounting on `/api/v1/admin/*` (per step 5's literal text) is deferred to Phase 4, since no such prefix/router exists yet; the middleware itself is complete and unit-tested.

**Goal**: The authentication/authorization spine — nothing protected can be built without it, and it's the first thing the frontend admin area needs to integrate against.

Steps:
1. **Session store**: wire `express-session` + `connect-pg-simple` (or Prisma-backed equivalent) against the Postgres `session` table from Phase 1. Configure HttpOnly, Secure (prod — gate on `NODE_ENV`/`trust proxy`, not hardcode, so local dev over HTTP still works), SameSite=Lax cookies, sensible TTL (e.g., a rolling session with a defined idle timeout AND an absolute max age — define both explicitly; "sensible TTL" alone invites an indefinitely-renewing session for a compromised cookie). Also set `session.name` to something other than the default `connect.sid` (trivial hardening — avoids advertising the framework).
2. **Password hashing**: argon2id via the `argon2` package — hash on user creation/password reset, verify on login. Pin explicit argon2id parameters (memory cost, time cost, parallelism) rather than library defaults — defaults can change between versions and you want a documented, reviewed choice appropriate for the VPS's available RAM (a memory-hard hash with too-high memory cost can itself become a DoS vector on a small VPS under concurrent login attempts — size it to the box).
3. **`AuthService`**: `login(email, password)`, `logout(sessionId)`, `getCurrentUser(sessionId)`. Invariant: rate-limit per IP+email combo (architecture.md §14 contract). **Also enforce `User.isActive` at login** — a deactivated account must be rejected at the auth boundary (not just hidden in UI), and an existing active session for a just-deactivated user should be invalidated promptly (e.g., check `isActive` on every authenticated request via `requireAuth()`, not only at login — otherwise "deactivation takes effect immediately," promised in ADR-0002's rationale, isn't actually true for already-logged-in sessions).
4. Routes: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/me`, `POST /api/v1/auth/password-reset/request` + `/confirm` (the reset flow needs the email integration — see Phase 3a note below; can be stubbed/logged-to-console in dev until the provider is chosen). **Note**: `password-reset/request` must respond identically (same status, same generic message, same approximate latency) whether or not the email exists — a classic account-enumeration leak if the response differs. Bake that into the service from the start, not as a later hardening pass.
5. **RBAC middleware** (`api/src/middleware/rbac.ts`): `requireAuth()` (401 if no session/user, and — per point 3 above — also checks `isActive`) and `requireRole(...roles)` (403 if role mismatch) — composable, applied per-route. Apply `requireAuth()` globally to the entire `/api/v1/admin/*` prefix (defense in depth) rather than relying on every router remembering to add it per-route — then layer `requireRole()` per-route on top.
6. Service-layer ownership-check helper: `canEditPost(user, post)` → `post.authorId === user.id || user.role === 'ADMIN'` — encode the **default** "Bloggers manage own posts only" rule here as a single named function so flipping it later (per the open question) is a one-line change in one place, not scattered checks. **Apply the same ownership-helper pattern symmetrically to Media uploads** (a Blogger should only attach media to their *own* posts, not arbitrary `ownerId`s) — this is an easy gap to miss since the architecture brief focuses ownership-checking language on blog posts, but the same "don't trust the client-supplied `ownerId`" rule applies directly to `MediaService.upload` (Phase 4e) and should be designed for here, even if implemented there.

**Open question to flag/resolve here**: 
- *Confirm Blogger cross-author edit permissions* — ship with the documented default (own-only), but make sure `canEditPost` is the single source of truth so the eventual stakeholder answer is a one-line change.
- *Confirm Admin-only staff account creation* — this gates Phase 4f (Users module — corrected from an earlier draft of this note that mis-cited "Phase 9," which is actually the POPIA-completion phase); the architecture already presumes yes, build accordingly, but flag as a confirm-before-go-live item.
- *Confirm transactional email provider* — needed for password-reset emails (and later RSVP confirmations in Phase 6). It does not block building the auth module's *mechanism* (token generation, expiry, single-use), only the actual sending. Recommend: stub a `MailService` interface now with a console/log-based dev implementation, swap in the real provider adapter once chosen (data-residency consideration per architecture.md §14 — prefer SA-friendly/regional providers).

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\auth\auth.service.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\auth\auth.router.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\middleware\rbac.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\auth\session.ts`

**Frontend dependency unlocked**: once this module's routes exist, the SPA's `RequireAuth`/`RoleGuard` + login page + typed API client's session-cookie handling can be built and tested end-to-end (Phase 8).

---

## Phase 4 — Backend Feature Modules (in dependency order)

Build in this order because each has increasing dependency depth (Blog needs only User; Events needs User; Registrations need Event; CMS needs User for `lastEditedBy`; Media needs Blog/Event as owners).

### 4a. Blog Module ✅ COMPLETED (2026-06-08)

> **Done on `feature/dynamic-rewrite`** — repository, service, router, and shared
> cross-module helpers (pagination, sanitizer) all built, wired into `app.ts`,
> and verified clean against `typecheck`/`lint`/`test`/`build` (165/165 tests
> passing, including 57 new Blog-module tests across `slug.test.ts` (10),
> `blog.service.test.ts` (24), and `blog.router.test.ts` (23)).
>
> - ✅ **Shared helpers carved out for Events (4b) to reuse verbatim** —
>   the plan's own "pagination convention established here — reuse for
>   Events" instruction (step 5) is honored literally:
>   - `api/src/lib/pagination.ts` — `paginationQuerySchema` (`{ page, limit }`,
>     `z.coerce`-based, `MAX_PAGE_LIMIT = 100` enforced as a REJECTED-not-
>     clamped Zod `.max()` bound — a `?limit=100000` gets a 400
>     `VALIDATION_ERROR` naming the bound, not a silent clamp), `toSkipTake`,
>     `toPaginatedResult` (the `{ items, page, limit, total, pageCount }`
>     envelope every paginated list endpoint returns), and the constants
>     `DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT`. Events should `import` and
>     `.extend(...)` `paginationQuerySchema` for its `branch`/`upcoming`
>     filters rather than reinventing page/limit parsing — see that file's
>     extensive header for the page/limit-vs-cursor rationale.
>   - `api/src/lib/sanitizeHtml.ts` — THE single source of truth for "what
>     HTML is allowed anywhere on this site" (per the plan's own "share the
>     sanitizer config/allow-list between modules" instruction in step 2).
>     Exports `sanitizeBlogPostBody` (bound to `RICH_TEXT_ALLOW_LIST` — the
>     heavier Blog-post-body allow-list: `h2`-`h4`/`p`/`br`/`strong`/`em`/
>     lists/`blockquote`/`a`/`img`, forced `rel="noopener noreferrer"` +
>     `target="_blank"` on links, `http(s)`/`mailto`-only URL schemes) and
>     `sanitizeCmsRichText` (bound to the deliberately tiny
>     `CMS_RICH_TEXT_ALLOW_LIST` — `p`/`br`/`strong`/`em` only, per
>     architecture.md §9.5's "bold, italic, line breaks only" CMS ceiling).
>     Both share one `BASE_OPTIONS` baseline (no `style`/`class`/`on*`
>     attributes ever, `disallowedTagsMode: 'discard'`,
>     `allowProtocolRelative: false`) via one `buildSanitizer(allowList)`
>     factory — Phase 4d (CMS) MUST import `sanitizeCmsRichText`/
>     `CMS_RICH_TEXT_ALLOW_LIST` from here, never define a parallel config.
>
> - ✅ **Slug-policy reconciliation — generate-once-at-CREATION (not "first
>   publish")**: documented in full in `blog.service.ts`'s file-header
>   doc-comment (search "SLUG POLICY" there for the complete reasoning — the
>   summary below is necessarily abbreviated). The plan's literal step-2
>   wording ("generate once on first publish, keep stable thereafter") is
>   STRUCTURALLY INCOMPATIBLE with the schema this team committed to in
>   Phase 1: `BlogPost.slug` is `String @unique` — non-nullable — so
>   `db.blogPost.create(...)` cannot persist a "no slug yet" `DRAFT` row at
>   all; "first publish" would require either a schema change nobody asked
>   for or a "generate twice, discard the first" anti-pattern that
>   contradicts the policy's own name. Generating at CREATION instead is not
>   a deviation but the correct DERIVED reading: it satisfies the plan's
>   actual underlying goal (link stability for shared/public URLs) at least
>   as well — creation always precedes first-publish, so any link stable
>   under a first-publish freeze is trivially stable under a creation-time
>   freeze too — and arguably more completely, since it also stabilizes
>   internally-shared draft-review links (which this app has no other
>   mechanism for) from the moment the post exists in any form. Every other
>   promise in the plan's policy is preserved exactly as specified: `update`/
>   `publish`/`unpublish` never touch `slug` (verified by
>   `blog.service.test.ts`'s "keeps the slug stable across publish/unpublish/
>   title-update" test), and `setSlug` is the dedicated, narrowly-scoped,
>   ADMIN-ONLY manual-edit escape hatch the plan asked for — gated at the
>   router by `requireRole(authService, 'ADMIN')` ALONE (deliberately NOT
>   `canEditPost`, which would be too PERMISSIVE here: an author rewriting
>   their own post's public URL unsupervised is exactly the link-breakage
>   hazard the policy exists to prevent — see `BlogService.setSlug`'s
>   doc-comment for the full "why `canEditPost` is the wrong check for this
>   one method" argument). Collision resolution follows the documented
>   `-2`/`-3`/... policy (`slug.ts`'s `slugCandidate`, probed sequentially by
>   `BlogService.generateUniqueSlug` up to `MAX_SLUG_COLLISION_ATTEMPTS = 50`
>   before failing loudly with `conflict()`).
>
> - ✅ **Sanitization-on-save**: both `createPost` and `updatePost` (only
>   when a new `body` is actually supplied — `undefined` is never coerced
>   into a sanitized empty string, preserving the repository's "leave this
>   field alone" partial-update contract) route every body through
>   `sanitizeBlogPostBody` BEFORE the repository ever sees it — "sanitize
>   before persisting, never persist-then-sanitize." Verified end-to-end
>   (script tags, `onclick`/`onerror` handlers, and `javascript:` URLs all
>   stripped while allowed structure survives) at both the service layer
>   (`blog.service.test.ts`) and through real HTTP requests at the router
>   layer (`blog.router.test.ts`'s `POST /admin/blog/posts` "sanitized body"
>   assertion).
>
> - ✅ **Ownership enforcement** (`canEditPost` from Phase 3, applied via the
>   shared `requireOwnedOrNotFound` helper inside `BlogService` — existence
>   check before ownership check, so a non-owner gets the SAME 404 a
>   nonexistent-id caller would for "not found," and a real 403 only for
>   "exists, but not yours"): every single-post mutation route
>   (`PATCH`/`DELETE`/`publish`/`unpublish`) is covered by a dedicated
>   "Blogger cannot mutate another author's post by id" router-level test
>   that asserts BOTH the 403 response AND that the underlying row is
>   provably untouched — exactly the brief's required test, run through real
>   HTTP + real sessions, not a service-layer shortcut.
>
> - ✅ **Public-visibility invariant** (`status = PUBLISHED AND publishedAt
>   <= now()`, architecture.md §7.3 invariant #3): encoded ONCE, in the
>   repository's `publicVisibilityWhere()` predicate, shared verbatim by both
>   `listPublished` and `findPublishedBySlug` — making "list and detail
>   disagree about what's public" structurally impossible rather than merely
>   remembered. The brief's required "scheduled-but-not-yet-live post 404s on
>   direct slug access" test exists at BOTH layers (`blog.service.test.ts`
>   and `blog.router.test.ts`), asserting the 404 is BYTE-IDENTICAL to a
>   genuinely-nonexistent slug's 404 (collapsed-outcome anti-enumeration
>   guarantee — a distinguishing response would itself leak "this slug
>   exists, just not for you yet").
>
> - ✅ **Pagination convention**: `{ items, page, limit, total, pageCount }`
>   envelope, `page`/`limit` query params (1-indexed, `DEFAULT_PAGE_LIMIT =
>   20`, `MAX_PAGE_LIMIT = 100` REJECTED not clamped) — see the shared-helpers
>   note above; this is the literal shape Events (4b) should produce too.
>
> **Deviations from the plan / decisions made along the way** (flagged for
> review, none blocking):
> - The slug-generation MOMENT differs from the plan's literal "on first
>   publish" phrasing — see the dedicated reconciliation note above and the
>   extensive doc-comment in `blog.service.ts`. The link-stability GUARANTEE
>   the plan was protecting is fully delivered, via the only mechanism the
>   already-committed schema can support.
> - `setSlug` does not use `canEditPost` (deliberately) — flagged inline at
>   length in both `BlogService.setSlug` and `blog.router.ts` so a future
>   reader doesn't "simplify" it into the module's general ownership pattern
>   and reopen the exact hazard the dedicated path exists to close.
>
> **Critical files**:
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.repository.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.service.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.router.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.schemas.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.constants.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\slug.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\lib\pagination.ts` (shared — Events reuses)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\lib\sanitizeHtml.ts` (shared — CMS reuses)

1. Repository (Prisma-backed `BlogPost` queries: list published, get-by-slug, list-by-author, CRUD).
2. Service: `createPost`, `updatePost` (enforces `canEditPost`), `publish`/`unpublish` (status transitions; only Admin or author), slug generation + uniqueness.
   - **Sanitize the rich-text body server-side on every create/update** (architecture.md §12.1.9 — strict allow-list, e.g., `sanitize-html`) — this is a Blog-module responsibility, not a CMS-only concern; the plan's CMS section (4d) explicitly calls out sanitization but the Blog module needs the identical control for post bodies and it's easy to build CMS sanitization carefully and then forget the symmetric Blog requirement. Share the sanitizer config/allow-list between modules (one source of truth for "what HTML is allowed anywhere on this site").
   - Slug generation: handle the collision case explicitly (e.g., append `-2`, `-3`...) and define what happens if an Admin/Blogger edits the title of a *published* post — does the slug change (breaking existing shared links/SEO) or stay fixed once published? Recommend: generate once on first publish, keep stable thereafter; allow explicit manual slug edits by Admin only. Decide and document — this is the kind of small thing that becomes an awkward retrofit once posts have been shared publicly.
3. Public routes: `GET /blog/posts` (paginated, published-only, `publishedAt <= now()`), `GET /blog/posts/:slug`.
   - **`GET /blog/posts/:slug` must also enforce `publishedAt <= now()`**, not just `status = PUBLISHED` — a post can be marked `PUBLISHED` with a future `publishedAt` (scheduled publishing) and must not be visible to the public before that timestamp, even if someone guesses/shares the direct slug URL. This is invariant §7.3.3 and is easy to satisfy on the list endpoint but forget on the detail endpoint.
4. Admin routes: `GET/POST/PATCH/DELETE /admin/blog/posts`, `POST /admin/blog/posts/:id/publish|unpublish` — gated `requireAuth() + requireRole('ADMIN','BLOGGER')`. **The list/get/update/delete handlers must additionally call `canEditPost`/scope the query** — `requireRole('ADMIN','BLOGGER')` only proves the caller is *some* blogger, not that they own *this* post; without the ownership check a Blogger could `PATCH`/`DELETE` another author's post by guessing its id. Make this explicit in the router/service contract so it isn't assumed-but-unwritten.
5. Pagination convention established here (page/limit or cursor) — reuse for Events. Cap the maximum `limit` server-side (e.g., 100) regardless of what the client requests — an unbounded `?limit=100000` is a cheap denial-of-service vector on a single small VPS.

### 4b. Events Module ✅ COMPLETED (2026-06-08)

> **Done on `feature/dynamic-rewrite`** — repository, service, router, and
> schemas/constants all built, wired into `app.ts`, and verified clean against
> `typecheck`/`lint`/`test`/`build` (246/246 tests passing, including 81 new
> Events-module tests across `events.repository.test.ts` (5),
> `events.service.test.ts` (40), and `events.router.test.ts` (36)).
>
> - ✅ **Status-transition graph** (step 4's "define the allowed graph
>   explicitly" — the plan's named open question): encoded as a single
>   explicit lookup table, `ALLOWED_TRANSITIONS` in `events.service.ts`
>   (search "STATUS TRANSITION GRAPH" for the full per-cell reasoning record —
>   summary below is necessarily abbreviated):
>
>   | From \ To | DRAFT | PUBLISHED | CANCELLED |
>   |-----------|-------|-----------|-----------|
>   | DRAFT     |  —    |   YES     |   YES     |
>   | PUBLISHED | YES   |   —       |   YES     |
>   | CANCELLED | YES   |   YES     |   —       |
>
>   - `PUBLISHED -> DRAFT` ("unpublish") is allowed REGARDLESS of existing
>     registrations — mirrors Blog's `unpublish` exactly; registrations stay
>     attached (the FK is `Restrict`, not `Cascade`) and become visible again
>     on re-publish.
>   - `CANCELLED -> {DRAFT, PUBLISHED}` ("reopen") IS allowed — the plan asked
>     this explicitly; hard-forbidding it would make a fat-fingered cancel
>     permanently unrecoverable (deletion is impossible once an event has
>     registrations — `onDelete: Restrict`).
>   - `DRAFT -> CANCELLED` is allowed directly (no forced publish-then-cancel
>     detour for an idea that should never have gone public).
>   - Same-state "transitions" (`DRAFT -> DRAFT`, etc.) are REJECTED with
>     `conflict()`, not silently accepted as a no-op — unlike Blog's
>     `publish` (which has a meaningful `publishedAt`-restamping side effect
>     to re-trigger), `Event` has no per-transition side effect a same-state
>     transition could meaningfully repeat.
>   - The table is exhaustively asserted against in
>     `events.service.test.ts`'s "exhaustively covers every (from, to) cell"
>     test — all 9 combinations, not a sample — guarding against the table
>     silently drifting from this documented graph.
>
> - ✅ **Registration-count-awareness hook** (step 4's "the admin UI should
>   warn 'this event has N registrations' before a destructive change"): NOT
>   a notification mechanism (none exists, none was built — the plan
>   explicitly warned against over-building one). Instead, `transitionStatus`
>   and `updateEvent` (for `startsAt`/`endsAt` changes) ALWAYS return
>   `{ event, registrationCount }` (`EventWithRegistrationCount`) — zero extra
>   endpoints, zero round trips, the SPA renders "this will affect N
>   registration(s)" directly from the response it already needed. Today
>   (pre-4c) the count is structurally always `0`; the hook is wired correctly
>   now so 4c's first registration makes it immediately meaningful.
>   `deleteEvent` applies the SAME principle to the `Restrict`-FK rejection —
>   a raw `P2003` becomes "cannot delete — N people are registered; export or
>   handle their data first."
>
> - ✅ **Slug policy — CONFIRMED identical to Blog** (generate-once-at-
>   CREATION; `Event.slug` is `String @unique`, byte-for-byte the same schema
>   shape as `BlogPost.slug` — see `events.service.ts`'s "SLUG POLICY" note
>   for the full "confirmation, not fresh derivation" record). Reuses Blog's
>   `slugify`/`slugCandidate` helpers from `modules/blog/slug.ts` verbatim;
>   `-2`/`-3`/... collision policy up to `MAX_SLUG_COLLISION_ATTEMPTS = 50`;
>   `setSlug` is the dedicated, Admin-only (NOT `requireEventStaff`) manual
>   override — gated identically to `BlogService.setSlug` and for the same
>   "an author rewriting their own public URL unsupervised is the exact
>   link-breakage hazard the policy exists to prevent" reason.
>
> - ✅ **Upcoming/past semantics — `endsAt`-based, NOT `startsAt`-based**
>   (step 3's named open question): `temporalWhere` in `events.repository.ts`
>   slices `'upcoming'` as `endsAt >= now()` and `'past'` as `endsAt < now()`.
>   Reasoning: an event that has STARTED but not yet ENDED is still
>   meaningfully "upcoming" from a registration/attendance standpoint (you can
>   still show up) — an `startsAt`-based cutoff would wrongly classify an
>   in-progress event as "past" the instant it begins. `events.service.test.ts`
>   asserts this directly ("classifies a not-yet-concluded event ... as
>   'upcoming', even if it has already started"). Both `'upcoming'` and
>   `'past'` are exposed as filters (plus an unfiltered `'all'`) — honoring
>   the plan's "past published events should remain browsable" blog-recap
>   discovery note; ordering is soonest-first for upcoming, most-recent-first
>   for past (the natural reading direction for each).
>
> - ✅ **No `publishedAt`-equivalent scheduling gap — CONFIRMED**: `Event` has
>   no `publishedAt`-shaped column (contrast `BlogPost`). `status = PUBLISHED`
>   is therefore the COMPLETE public-visibility predicate — verified in both
>   `events.service.test.ts` and `events.router.test.ts` ("no scheduling-gap
>   limbo (unlike Blog)": a `PUBLISHED` event with a `startsAt` 30 days out is
>   immediately publicly visible, unlike a `BlogPost` with a future
>   `publishedAt`).
>
> - ✅ **EVENT-MANAGER OWNERSHIP — DECIDED: any Event Manager may manage any
>   event** (no `canEditPost`-equivalent per-resource ownership boundary
>   exists or was built — see `events.service.ts`'s "EVENT-MANAGER OWNERSHIP"
>   note for the full reasoning: architecture.md §9.2's RBAC matrix names a
>   flat `requireRole('ADMIN','EVENT_MANAGER')` with no "and only their own"
>   qualifier, unlike Blog's explicitly-named-and-flagged Blogger-ownership
>   rule; a small org realistically has one or two Event Managers sharing one
>   calendar, and per-manager silos would actively hurt that workflow).
>   `Event.createdById` is attribution/audit metadata only.
>   `requireEventStaff` (`requireRole('ADMIN','EVENT_MANAGER')`) is therefore
>   BOTH NECESSARY AND SUFFICIENT for every `/admin/events/:id*` route — there
>   is no second, service-layer ownership gate to layer on top (contrast
>   Blog's extensive "necessary but not sufficient" router note). Verified
>   directly: `events.service.test.ts`'s "lets a DIFFERENT Event Manager
>   update/transition/view" and `events.router.test.ts`'s matching
>   "no per-resource ownership boundary — by design" router-level test.
>   **Flagged exactly like Blog's Blogger-default**: a one-line service change
>   (add a `canManageEvent` predicate mirroring `canEditPost`'s shape) if a
>   stakeholder later asks for per-manager scoping.
>
> - ✅ **THE CAPACITY INVARIANT — race-safe, transactional, GENUINELY
>   concurrency-tested** (step 2 / architecture.md §7.3 invariant #6 — the
>   single most consequential piece of groundwork in this module, because
>   Phase 4c's `RegistrationService.registerAttendee` depends on it directly):
>
>   **Algorithm chosen — explicit row-level locking, NOT
>   `INSERT ... SELECT ... WHERE count < capacity`:**
>   ```
>   BEGIN;
>     SELECT "capacity" FROM "events" WHERE "id" = $1 FOR UPDATE;  -- (1) LOCK
>     SELECT count(*) FROM "registrations" WHERE "eventId" = $1;   -- (2) COUNT
>     INSERT INTO "registrations" (...) VALUES (...);              -- (3) INSERT
>   COMMIT;
>   ```
>   executed via `db.$transaction(async (tx) => {...})` (Prisma's interactive
>   form) at default `READ COMMITTED` isolation. `SELECT ... FOR UPDATE`
>   takes an exclusive ROW-LEVEL LOCK on the `events` row — THAT lock is the
>   actual source of atomicity: any concurrent attempt for the SAME `eventId`
>   blocks at ITS OWN step (1) until this transaction commits/rolls back, so
>   steps (2)/(3) are provably never interleaved across attempts. Simpler to
>   reason about than `SERIALIZABLE` + retry-on-`40001` — no retry loop, no
>   serialization-failure handling, because nothing is left to serialize
>   against once the row lock is held.
>
>   **A genuinely-broken first attempt — preserved in full in
>   `events.repository.ts`'s doc-comment as the cautionary record this task's
>   own brief asked for**: the FIRST implementation used the plan's
>   second-named option, a single `INSERT ... SELECT ... WHERE capacity IS
>   NULL OR (SELECT count(*) ...) < capacity` statement, on the (incorrect)
>   theory that it is "atomic against a single MVCC snapshot." It is NOT, at
>   `READ COMMITTED`: ten concurrent sessions each see the same pre-insert
>   count (none of their own uncommitted inserts are visible to one another)
>   and each independently concludes "there's room" — overselling by exactly
>   the margin the primitive exists to prevent. **This was caught — not
>   theorized about, ACTUALLY CAUGHT — by the genuine `Promise.all`
>   concurrency test**: the capacity-2 variant left 9 persisted rows where at
>   most 2 may ever exist. A SEQUENTIAL test of the same broken
>   implementation would have passed cleanly (proving nothing about the
>   concurrent behaviour that actually matters) — the textbook "test most
>   likely to be written wrong in a way that still goes green" this task's
>   brief (and plan.md Phase 11 item 2) names. The corrected row-lock version
>   is what ships.
>
>   **The `maxWait`/`timeout` tuning decision** (a real production concern
>   this episode surfaced, not merely a test-environment workaround): firing
>   N=10 concurrent attempts at the SAME event row means all 10 genuinely
>   serialize on the `FOR UPDATE` lock — an instrumented measurement of this
>   exact scenario found each fully-serialized lock-acquire→commit cycle takes
>   ~210ms, with the LAST of 10 finishing at ~2.14 SECONDS — comfortably
>   exceeding Prisma's DEFAULT `maxWait: 2000ms`, surfacing as
>   `P2028 "Unable to start a transaction in the given time"` even though
>   every attempt is making real, correct progress (just queued on a lock that
>   WILL release soon). This is NOT pool exhaustion (this machine's default
>   `connection_limit = 2*cpus+1 = 17` comfortably covers 10 concurrent
>   transactions) and NOT a broken lock (the lock is doing exactly what it
>   should). `tryRegisterAtomically` now passes EXPLICIT, measurement-backed
>   options — `REGISTRATION_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout:
>   20_000 }` (named constant, documented in full in `events.repository.ts`,
>   right above the primitive) — sized at roughly 10x the measured worst case
>   for THIS module's realistic load profile (a "small, low-traffic,
>   single-VPS" org per architecture.md §3/§11; ~70-deep same-event
>   contention would be the ceiling these values absorb, an order of
>   magnitude beyond any plausible burst). Fixed at the PRIMITIVE — not just
>   the test — because a real registration-opening burst against a popular
>   event would hit the identical ceiling in production.
>
>   **Verification — genuinely, not by weakening the test**: both concurrency
>   tests in `events.repository.test.ts` still fire the full N=10 concurrent
>   `Promise.all` attempts (capacity-1: exactly 1 success / 9 rejections;
>   capacity-2: exactly 2 successes / 8 rejections — both verified against
>   ground-truth `db.registration.count`, not merely the primitive's
>   self-reported results) and now pass consistently across repeated runs.
>
> - ✅ **Where the reusable `tryRegisterAtomically` primitive lives — for
>   Phase 4c**: `EventRepository.tryRegisterAtomically` in
>   `api/src/modules/events/events.repository.ts`, wrapped by
>   `EventService.tryRegisterWithCapacityCheck` in `events.service.ts` (the
>   two-layer "fast advisory pre-check, then the atomic guarantee" shape —
>   search "CAPACITY-CHECK ALGORITHM"/"two-layer" in that file). Phase 4c's
>   `RegistrationService.registerAttendee` should call
>   `eventService.tryRegisterWithCapacityCheck(eventId, registration)`
>   directly — it returns `{ registrationId }` on success or throws
>   `capacityExceeded()` (409) on failure; it does NOT check
>   `status === PUBLISHED && !started` or the soft duplicate-`(eventId,
>   email)` guard (4c's job, layered on top, BEFORE calling this — see that
>   method's "what this does NOT do" doc-comment list for the full boundary
>   record).
>
> - ✅ **Dormant `isPaid`/`priceCents` (ADR-0006)**: the schema REJECTS (400
>   `VALIDATION_ERROR`, not silent coercion) any non-default value — `isPaid:
>   true` or a non-null `priceCents` get a loud, field-named 400 explaining
>   v1 has zero payment logic. `EventService.createEvent`'s/`updateEvent`'s
>   input types don't even carry the fields (a second, structural guarantee on
>   top of the schema rejection — no code path through which a non-default
>   value could reach the repository). Verified at BOTH layers:
>   `events.service.test.ts` ("structurally always persisted at v1-safe
>   defaults") and `events.router.test.ts` ("the actual VALIDATION BOUNDARY" —
>   `isPaid: true`/`priceCents: 5000` each get a 400 naming the field;
>   `isPaid: false`/`priceCents: null` are explicitly accepted as the only
>   legal non-omitted shapes).
>
> **Deviations from the plan / decisions made along the way** (flagged for
> review, none blocking):
> - The plan's step 2 offered two algorithm options and asked to "decide and
>   document which is used" — the SECOND-named option (`INSERT ... SELECT ...
>   WHERE count < capacity`) was tried FIRST and found genuinely broken under
>   `READ COMMITTED` (see the capacity-invariant note above); the row-lock
>   approach (closer to, but more precise than, the first-named "Serializable
>   + retry" option — it needs no retry loop at all) is what ships. This
>   "wrong-then-corrected" arc is preserved in full in
>   `events.repository.ts`'s doc-comment specifically so a future reader does
>   not "simplify" the primitive back toward the plausible-but-broken shape.
> - `maxWait`/`timeout` were NOT part of the plan's explicit scope — they
>   surfaced as a genuine production-relevant consequence of the chosen
>   (correct) row-lock algorithm under deep same-event contention, and were
>   fixed at the primitive layer (not patched around in the test) per the
>   "the test caught a real thing; fix the real thing" discipline.
>
> **Critical files**:
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.repository.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.service.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.router.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.schemas.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.constants.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.repository.test.ts` (the GENUINE `Promise.all` concurrency proof — Phase 4c should read this file's header before writing its own registration tests)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.service.test.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.router.test.ts`

1. Repository + service: CRUD, branch scoping, `status` transitions (`DRAFT|PUBLISHED|CANCELLED`).
2. **Capacity invariant** (architecture.md §7.3.6): enforce transactionally — this is foundational groundwork for the Registration module's `registerAttendee` (build the capacity-check primitive here, e.g., a serializable transaction or a DB-level check constraint + retry, so Registrations can call into it).
   - **Concretely**: the race-safe pattern in Postgres/Prisma is to perform the count-and-insert inside a single `prisma.$transaction` using `Serializable` isolation (and retry on serialization-failure error code `40001`), OR use a single SQL statement that does `INSERT ... SELECT ... WHERE (SELECT count(*) ...) < capacity` so the check-and-insert is atomic at the database level — the latter is more robust under load than an application-level "count, then insert" which has a TOCTOU race even inside a transaction at default (`ReadCommitted`) isolation. Decide and document which pattern is used; write the concurrency test (Phase 11 item 2) against the *real* implementation, not a simplified version.
3. Public routes: `GET /events` (paginated, published, filterable by branch/upcoming), `GET /events/:slug`.
   - Decide the "upcoming" filter semantics now (`startsAt >= now()` vs. `endsAt >= now()`) and whether past/completed published events remain publicly browsable (the PRD's blog-recap use case suggests members may want to find "what event was that post about" — consider whether `GET /events` should support a `past=true` filter rather than only ever showing upcoming).
4. Admin routes: full CRUD gated `requireRole('ADMIN','EVENT_MANAGER')`.
   - Define the allowed `status` transition graph explicitly (e.g., `DRAFT → PUBLISHED → CANCELLED`, can a `CANCELLED` event be reopened? can a `PUBLISHED` event revert to `DRAFT` if it already has registrations?) — and decide what happens to **existing registrations** when an event is cancelled or its `startsAt` is moved to the past/changed materially (notify registrants? no mechanism exists for that without the email integration — at minimum, the admin UI should warn "this event has N registrations" before a destructive status change or date change). This is an edge case the architecture doesn't spell out and is exactly the kind of thing that surprises an Event Manager in production.

### 4c. Registration Module ✅ COMPLETED (2026-06-08)

> **Done on `feature/dynamic-rewrite`** — repository, service, router, schemas,
> and constants all built, wired into `app.ts`, and verified clean against
> `typecheck`/`lint`/`test`/`build` (285/285 tests passing across the whole
> suite, including 39 new Registrations-module tests across
> `registrations.service.test.ts` (20) and `registrations.router.test.ts` (19)).
>
> - ✅ **`registerAttendee` eligibility + two-layer capacity check** (steps 3
>   and 4's "capacity-check ordering matters" note): `RegistrationService.
>   registerAttendee` confirms the event is `PUBLISHED` and not yet started via
>   `EventService.getPublishedBySlug` (collapsing not-found/not-published per
>   the established anti-enumeration convention), THEN delegates to
>   `EventService.tryRegisterWithCapacityCheck` — which itself performs the
>   documented "fast pre-check, then atomic `tryRegisterAtomically` guarantee"
>   two-layer sequence built in Phase 4b specifically for this call site.
>   `{ inserted: false }` is translated to `capacityExceeded()` at the
>   `EventService` boundary (not re-derived here) — exactly ONE place owns the
>   capacity guarantee, end to end.
> - ✅ **The soft `(eventId, email, firstName, surname)` duplicate-guard, with
>   a CONCRETE named window** (step 3's "don't leave 'short window' as an
>   undefined magic constant" instruction): `DUPLICATE_GUARD_WINDOW_MINUTES =
>   5` in `registrations.constants.ts`, with an extensive doc-comment recording
>   BOTH the match-key reasoning (the full 4-field tuple, NOT email-alone — an
>   email may legitimately register a companion under a different name, per
>   the Backend Review Note immediately below the plan's step list) and the
>   window-length reasoning (long enough to catch a double-click/back-button
>   resubmit, short enough that it can never block a genuine same-household
>   second registration). A plain advisory `findFirst` (NOT a transactional
>   guarantee — a deliberate choice, since this is a soft UX guard, not an
>   invariant; see `registrations.repository.ts`'s "DUPLICATE-GUARD" doc-comment
>   for why a TOCTOU race here is acceptable, unlike capacity).
> - ✅ **`age` validated as an integer 0–120, surfaced via `{ fields: { age:
>   [...] } }`** (step 3's named POPIA control #8 requirement):
>   `createRegistrationSchema` in `registrations.schemas.ts` —
>   `z.number().int().min(MIN_AGE).max(MAX_AGE)` with `MIN_AGE = 0`/
>   `MAX_AGE = 120` named constants; verified at the actual VALIDATION BOUNDARY
>   in `registrations.router.test.ts` (0 and 120 accepted; -1, 121, and 30.5
>   each rejected with a 400 naming the `age` field specifically).
> - ✅ **POPIA placeholder wiring — `consentVersion` + `retainUntil`**
>   (step 1's "go-live blocker, but doesn't block building the submission
>   flow" guidance): `CONSENT_VERSION_PLACEHOLDER =
>   'consent-notice-DRAFT-v0-PENDING-LEGAL-SIGNOFF'` and
>   `retainUntilPlaceholder()` (returns `null`, not a guessed default — see
>   that function's doc-comment for why guessing would be WORSE than an honest
>   `null`: a wrong guess silently bakes an unconfirmed retention period into
>   real personal-data rows, while `null` makes "this still needs a stakeholder
>   decision" structurally visible in the data itself). Both are named, single-
>   sourced constants in `registrations.constants.ts`, each documented as
>   "PLACEHOLDER — pending stakeholder/legal sign-off," so the Phase 9 retention
>   work is purely a content/config change, never a re-architecture — exactly
>   the shape step 1 asked for.
> - ✅ **Honeypot bot-defense — silently accept-and-discard, documented choice**
>   (step 4's "honeypot/bot-defended" requirement, and architecture.md §12's
>   "lightweight bot defense on RSVP"): `createRegistrationSchema`'s optional
>   `honeypot` field is checked FIRST in `registerAttendee`, before any DB
>   read — a filled honeypot short-circuits to `{ registered: true }` (the
>   IDENTICAL success shape a genuine submission gets) without persisting
>   anything or consuming a capacity slot. Chosen over a loud rejection
>   specifically so a bot never learns WHICH field tripped the trap (a 400
>   naming `honeypot` would be a free signal to iterate against); see
>   `createRegistrationSchema`'s doc-comment for the full reasoning record.
>   Verified in `registrations.service.test.ts` (discarded silently, doesn't
>   consume capacity) and `registrations.router.test.ts` (200-shaped response,
>   nothing persisted).
> - ✅ **Rate-limiting** (architecture.md §12's "rate-limit the public RSVP and
>   login endpoints"): `RSVP_RATE_LIMIT = { windowMs: 10 * 60_000, max: 20 }`
>   in `registrations.router.ts` — deliberately LOOSER than `auth.router.ts`'s
>   `LOGIN_RATE_LIMIT`, with an extensive doc-comment recording WHY (RSVP's
>   legitimate-traffic shape is genuinely burstier — shared-household/shared-
>   IP group sign-ups after an event announcement — and login's tight,
>   credential-stuffing-tuned budget would actively lock out exactly the
>   legitimate burst this feature exists to handle).
> - ✅ **Staff routes gated `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')`**
>   (step 5 + architecture.md §12's "restrict registration data reads/exports
>   to Admin + Event Manager"): `requireRegistrationStaff` is the SINGLE shared
>   gate for both `GET /admin/events/:id/registrations` and the CSV export —
>   no per-resource ownership check on top (mirrors the Phase 4b "EVENT-MANAGER
>   OWNERSHIP — any Event Manager may manage any event" decision; existence/
>   visibility is delegated to `EventService.getForAdmin`, which performs no
>   ownership gate of its own). Verified via the full RBAC decision-matrix
>   (anonymous → 401, Blogger → 403, Event Manager → 200, Admin → 200).
> - ✅ **CSV export — a REAL CSV-writing library, correct headers, RFC 4180
>   escaping** (step 5's "use a real CSV-writing library, not string-templating
>   rows" instruction): added `csv-stringify@^6` as a dependency (confirmed
>   absent beforehand) and used `csv-stringify/sync`'s `stringify(rows,
>   { columns: [{ key, header }, ...], header: true })` form — the correct API
>   (an initial attempt at a `columns_header_record` option was tried, found to
>   not exist, and corrected after empirically verifying the real shape via a
>   throwaway `node -e` probe). `Content-Type: text/csv; charset=utf-8` and
>   `Content-Disposition: attachment; filename="registrations-<slugified-title>-
>   <date>.csv"` are both set explicitly. Verified in `registrations.router.
>   test.ts` with adversarial real-shaped personal-name inputs — `Sam "Sammy"`
>   (embedded quote) and `Smith, Jr.` (embedded comma) — proving the file opens
>   correctly rather than corrupting column boundaries the way naive
>   `row.join(',')` string-templating would.
> - ✅ **Per-export structured audit log entry** (step 5's "the audit-log entry
>   is not optional-nice-to-have, treat it as a v1 requirement" instruction —
>   see the flagged open AuditLog-table question below): `RegistrationService.
>   exportForEvent` logs `{ event: 'registration_export', actorId, actorEmail,
>   actorRole, eventId, eventTitle, registrationCount, exportedAt }` via the
>   shared `pino` logger injected through the same `{ db, ..., logger }`
>   factory-options shape `AuthService` already established — capturing every
>   field architecture.md §12.1.6 names ("who exported, when, which event").
>
> **Open decision flagged for stakeholder/cross-module confirmation — the
> `AuditLog` table question** (cross-cutting with Phase 4f, NOT solved
> unilaterally here): plan.md's own step 5 and the Phase 4f note (line 598-599)
> both raise "does this need a structured `AuditLog` DB table, or does
> structured logging suffice?" `exportForEvent` ships with the LATTER —
> structured `pino` log entries carrying every field §12.1.6 names — for three
> reasons recorded in full in that method's doc-comment: (1) it satisfies the
> literal requirement ("audited") without a schema change on a pre-launch
> database; (2) a real `AuditLog` table is explicitly flagged in the plan as
> better decided ONCE, centrally (line 599's "Recommend deciding this in Phase
> 1... A minimal generic shape... could serve both the role-change [4f] and
> CSV-export [4c] use cases with one table" — building a 4c-only ad-hoc version
> now would risk exactly the kind of drift that note warns against); (3) it
> keeps this phase's migration footprint at zero, consistent with "don't hand-
> edit / don't add speculative schema." If the team decides a queryable,
> retained, structured `AuditLog` table IS wanted, `exportForEvent`'s logging
> call is a narrow, isolated, additive change to swap — the log-statement shape
> already mirrors the exact field set such a table's rows would need.
>
> **Critical files**:
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.repository.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.service.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.router.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.schemas.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.constants.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.service.test.ts` (incl. the GENUINE `Promise.all` concurrency proof through the full service stack — see file header for why re-proving Phase 4b's guarantee here is not redundant)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.router.test.ts`

(depends on 4b)
1. **Open question to resolve before/while building this**: *POPIA retention period and consent-notice wording* — flagged as a **go-live blocker**, but it does NOT block building the *submission* flow (the `consentVersion` field just needs *a* version string and *a* notice to display — even a placeholder draft can be wired now and swapped when the organization confirms wording). It DOES block:
   - Setting a real `retainUntil` value on creation (use a placeholder/null until the period is confirmed, OR pick a conservative default and document it as provisional).
   - Building the purge job (defer that piece to **Phase 9** explicitly — the original draft of this note said "Phase 7," which is the frontend admin-shell phase and clearly wrong; corrected to Phase 9, the dedicated POPIA-completion phase).
   Recommend: build the submission flow with consent capture wired to a *draft* notice now, clearly marked "PLACEHOLDER — pending stakeholder/legal sign-off," so the only remaining work once the answer arrives is a content/config change, not a re-architecture.
2. **Open question**: *event capacity/waitlisting* — build the hard-reject-at-capacity behavior (the documented default); it's a one-line service change to add waitlisting later if confirmed needed.
3. `EventService.registerAttendee(eventId, input)`: validates event is `PUBLISHED` and not yet started, checks capacity transactionally, soft-guards duplicate `(eventId, email)` within a window, persists with `consentVersion` + provisional `retainUntil`.
   - **Validate `age` as an integer 0–120 in the Zod schema** (architecture.md §7.3.7) — be precise about *where* this lives: it must be enforced server-side in the Zod schema regardless of any client-side check (POPIA control #8), and the error must surface through the standard `{ error: { fields: { age: [...] } } }` shape so the form can show a field-level message.
   - Define `retainUntil`'s computation precisely once the policy lands: is it `now() + N` (registration date) or `event.startsAt + N` (event date)? These differ meaningfully for events booked far in advance. Architecture.md doesn't specify — flag it as part of the same retention-period stakeholder conversation (Phase 9), but note the ambiguity *here* so whoever asks the question asks the right one.
   - The soft `(eventId, email)` duplicate-guard is described as a "short window" — define what "short" means concretely (e.g., reject an identical `(eventId, email, firstName, surname)` submitted within N minutes, to catch double-click/resubmits, while still allowing the same email to register a second attendee under a different name later). Don't leave "short window" as an undefined magic constant in the code.
4. Public route: `POST /events/:slug/registrations` — rate-limited, honeypot/bot-defended, Zod-validated (`age` 0–120 integer).
   - **Capacity-check ordering matters under load**: if the event is at/near capacity, prefer to fail fast (check current count before attempting the heavier validated insert) AND re-check atomically inside the transaction (per 4b's note) — the first check is a UX nicety (fast, friendly "this event is full" response), the second is the actual race-safe guarantee. Don't rely on the fast check alone.
5. Staff routes: `GET /admin/events/:id/registrations` (attendee list/headcount), `GET /admin/events/:id/registrations.csv` (export — gated `ADMIN`/`EVENT_MANAGER`; consider an audit-log entry per export per architecture.md §12.1.6).
   - **CSV export**: escape/quote fields correctly (names, phone numbers, emails can contain characters that break naive CSV — commas, quotes) — use a real CSV-writing library, not string-templating rows. Also set the response `Content-Disposition`/`Content-Type` headers correctly and consider that this endpoint returns a bundle of personal data in one response — it is the single highest-value target for credential theft in this system; the audit-log entry (who exported, when, which event) is not optional-nice-to-have, treat it as a v1 requirement given POPIA §12.1.6 explicitly names CSV export as "the most likely vector for personal data to leave the system's control."

**Backend Review Note (cross-cutting for 4b/4c)**: Add a `@@unique([eventId, email])`-style constraint to the schema **only if** the duplicate-guard is meant to be a hard rule — the architecture explicitly says it's a *soft* guard (the same email may legitimately register a companion under a different name), so do NOT add a DB-level unique constraint on `(eventId, email)` alone. This is worth saying explicitly in the plan so nobody "helpfully" adds a unique index during Phase 1 schema review that then has to be migrated away after it breaks a legitimate multi-registration.

### 4d. CMS Module ✅ COMPLETED (2026-06-08)

> **Done on `feature/dynamic-rewrite`** — slot registry, repository, service,
> router, schemas, and constants all built, wired into `app.ts`, and verified
> clean against `typecheck`/`lint`/`test`/`build` (322/322 tests passing
> across the whole suite, including 37 new CMS-module tests across
> `cms.slots.test.ts` (8), `cms.service.test.ts` (15), and
> `cms.router.test.ts` (14)).
>
> - ✅ **Slot registry — the "single most important file for ADR-0007
>   compliance"** (step 1): `cms.slots.ts` exports a fixed, `readonly`
>   `CMS_SLOTS` const array containing exactly the six seeded slots
>   (`about.card.who-are-we`, `about.card.what-we-do`,
>   `about.card.get-involved`, `contact.capeTown.card`,
>   `contact.durban.card`, `contact.page.details` — all currently
>   `PLAIN_TEXT`), plus `findRegisteredSlot`/`isRegisteredSlot` lookup
>   helpers — the single source of truth `CmsService.updateSlot` checks
>   every write against, with unknown keys rejected via the existing
>   `unknownSlot()` factory from `lib/errors.ts` (no hand-rolled error
>   type). **Flagged, accepted-risk decision**: this registry and
>   `prisma/seed.ts`'s parallel `CMS_SLOTS` list remain two separate,
>   human-maintained lists rather than one importing the other — the file's
>   header explains in full why a runtime import in either direction would
>   be a layering inversion (the seed runs via `tsx` outside compiled
>   output and is typed against `@prisma/client` enums; reaching from
>   `src/` into `prisma/` or vice versa recreates the exact cross-layer
>   edge ADR-0001's module boundaries exist to prevent). The mitigation is
>   a dedicated **registry/seed parity test** in `cms.slots.test.ts` that
>   reads `prisma/seed.ts`'s SOURCE TEXT (not a runtime import) and
>   regex-extracts its `CMS_SLOTS` entries, then asserts both lists
>   describe the identical `slotKey` set with identical `format`s — so any
>   future edit to one list without the other fails loudly in `npm test`.
> - ✅ **`getSlot`/`getSlots`/`updateSlot`** (step 2): `CmsService` rejects
>   writes to unregistered `slotKey`s via `unknownSlot()`, sanitizes
>   format-aware (RICH_TEXT through `sanitizeCmsRichText`/
>   `CMS_RICH_TEXT_ALLOW_LIST` from `lib/sanitizeHtml.ts`; PLAIN_TEXT stored
>   AS-IS — never double-sanitized, since the frontend escapes on render),
>   and stamps `lastEditedById` from the authenticated editor on every
>   write. **The "registered-but-unpopulated slot" contract — DECIDED per
>   the plan's own recommendation**: `getSlot` returns a safe empty-string
>   default (`{ slotKey, format: <from registry>, value: '', updatedAt:
>   null }` — `updatedAt: null` an honest "never written" signal) rather
>   than 404/throw, for ANY registered slot lacking a row (immediately
>   post-migration, or a newly-registered slot whose seed hasn't shipped
>   yet) — the public read path NEVER hard-errors on this condition.
> - ✅ **Batched public endpoint — `GET /cms?keys=a,b,c` returns a MAP**
>   (step 3, resolving the Frontend Review Note verbatim): `CmsService.
>   getSlots` returns `Record<slotKey, CmsSlotView>` (not an array), and
>   guarantees **every requested, IN-REGISTRY key is present** in the
>   response (filling unpopulated ones with the same safe-empty default
>   `getSlot` uses) — exactly the "renderer never special-cases a missing
>   key" contract the frontend asked for, serving both the public About/
>   Contact pages (one batched call) and the admin `SlotEditor` (a 1-key
>   batch, reusing the identical shape).
>   **Out-of-registry batch-key handling — DECIDED: silently omit.** Three
>   options were weighed in `getSlots`'s doc-comment (400 the whole
>   request / include with an error marker / silently omit); silent
>   omission was chosen because it keeps the map contract uniform for
>   well-formed requests, degrades exactly like the existing `CmsSlot`
>   frontend fallback-heading behavior already handles, and treats an
>   out-of-registry key as a dev/deploy-coordination defect (not a runtime
>   data problem) that the registry/seed parity test and manual QA already
>   catch — without forcing every anonymous page-view to pay for a
>   request-rejecting code path over a bug only developers can fix.
> - ✅ **Response caching — DECIDED: skip the in-memory TTL cache, document
>   `Cache-Control` via Nginx as the fast-follow** (step 3's "good
>   candidate for short server-side response caching"): `cms.service.ts`'s
>   file header records the YAGNI rationale in full — this is a six-row
>   table Postgres serves in well under a millisecond; an in-memory TTL
>   cache adds real invalidation-correctness surface (every `updateSlot`
>   would need to evict precisely) AND a cross-process staleness hazard
>   once PM2 runs in cluster mode (each worker would cache independently);
>   and admin-initiated content edits are rare enough that Postgres's own
>   buffer cache already absorbs the "hit on every page view" cost for
>   free. If load ever justifies it, `Cache-Control` headers terminated at
>   Nginx (architecture.md §11's reverse-proxy layer) is the documented,
>   lower-risk lever to pull first.
> - ✅ **Admin routes gated `requireRole(authService, 'ADMIN')` ONLY — no
>   staff-role escape hatch, no ownership check** (step 4, confirmed against
>   the RBAC matrix): unlike `/admin/blog/*`/`/admin/events/*` (reachable by
>   `BLOGGER`/`EVENT_MANAGER` respectively, often plus an ownership check),
>   `/admin/cms/*` is the deliberate exception to both patterns —
>   `cms.router.ts`'s doc-comment explains why: `CMSContent` is sitewide
>   branding/contact copy with no "author" concept (`lastEditedById` is
>   attribution/audit metadata, not an access-control field), so `ADMIN`
>   alone is both necessary and sufficient; there is no narrower "may this
>   Admin touch this slot" question to ask.
> - ✅ **`GET /admin/cms/:slotKey` reuses `getSlot` (not `getSlots`) —
>   deliberately precise `unknownSlot()` for operators**: the admin
>   single-slot read path throws a precise, named error for an
>   out-of-registry key — the CORRECT behavior for an authenticated Admin
>   who can act on "that slotKey doesn't exist" (very plausibly a typo),
>   categorically different from the public batch endpoint's "silently
>   degrade" contract that exists specifically to protect anonymous
>   visitors from a developer-side drift they have no way to act on. The
>   two behaviors are not contradictory — they're the right call for each
>   audience, documented side-by-side in both the service's and router's
>   doc-comments.
>
> **Critical files**:
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.slots.ts` (the registry — single source of truth for ADR-0007 compliance)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.constants.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.schemas.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.repository.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.service.ts` (the safe-empty-default contract, out-of-registry batch-key decision, and no-cache rationale all live in this file's doc-comments)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.router.ts` (the ADMIN-only RBAC rationale and `getSlot`-vs-`getSlots` admin/public asymmetry rationale live here)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.slots.test.ts` (incl. the registry/seed source-text parity test)
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.service.test.ts`
> - `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.router.test.ts`

(original planning notes retained below for reference)

1. **Slot registry**: a developer-defined, fixed list of valid `slotKey`s (a TypeScript const array/enum mirroring the seeded rows from Phase 1) — the single source of truth the service checks writes against (architecture.md §7.3.8, ADR-0007).
2. Service: `getSlot(slotKey)`, `updateSlot(slotKey, value, editor)` — rejects unknown keys (`UnknownSlotError`), sanitizes per `format` (plainText: escape on render; richText: server-side allow-list sanitization, e.g., via `sanitize-html` with a tiny allow-list — bold/italic/line breaks only, per architecture.md §9.5).
   - Decide what `getSlot` returns for a `slotKey` that is in the registry but has **no row yet** (e.g., immediately post-migration before the seed runs, or if a new slot is added to the registry but the seed/migration to create its row hasn't shipped) — return a typed "empty" value vs. 404 vs. throw. The public pages (Phase 6) need a defined contract here so they don't render `undefined`/crash on a missing slot. Recommend: the registry and the seed are committed together in the same change, AND `getSlot` returns a safe empty-string default for a registered-but-unpopulated slot (never a hard error on the public read path).
3. Public route: `GET /cms/:slotKey` (or bundle into page payloads — decide based on whether public pages need 1 round-trip per slot or a batched fetch; recommend a batch endpoint like `GET /cms?keys=a,b,c` to avoid request waterfalls on the About/Contact pages).
   - **Frontend Review Note (response to this open question — see Phase 6 for the full reasoning)**: the frontend wants the batched form, returning a **map keyed by `slotKey`** (e.g., `{ "about.card.who-are-we": { format, value, updatedAt }, ... }`), not an array — this gives `CmsSlot` an O(1) lookup without every consumer re-deriving the same index. Critically, the frontend also wants **every requested key present in the response** (with a safe empty `value` for a registered-but-unpopulated slot, consistent with the `getSlot` "safe empty default" decision in step 2 above) — never an omitted key — so the renderer never has to special-case "key was requested but missing from the response." This single contract serves both the public pages (one batch call per page, e.g., 3 keys for About) and the admin `SlotEditor` (a 1-key batch call, reusing the exact same hook/shape — no parallel single-slot-fetch path needed).
   - Whichever shape is chosen, this is a good candidate for short server-side response caching (e.g., a small in-memory TTL cache, or `Cache-Control` headers via Nginx) — CMS content changes rarely (admin-edited, not high-frequency), and the public About/Contact pages will hit this on every page view. Cheap win for a low-resource VPS; invalidate the cache on `updateSlot`.

### 4e. Media Module (depends on Blog + Events as owner types) ✅ COMPLETED (2026-06-09)
1. Service: file validation (MIME allow-list, size cap), filename sanitization/randomization (prevent path traversal/collisions — architecture.md §14 contract), storage to local disk **outside** the web/build root (e.g., `api/uploads/` or a configured path matching the eventual `/var/www/rejuvenate/uploads`).
   - **Validate the actual file content, not just the declared MIME type/extension** — a classic upload-bypass is renaming a malicious file to `.jpg` while the browser/client lies about `Content-Type`. Use a magic-byte/file-signature check (e.g., `file-type` package) in addition to the declared MIME type. This is the kind of detail the architecture brief summarizes as "validation (type/size)" but a backend engineer needs to know it means *content-sniffed* validation, not header-trusting validation.
   - Consider whether images need server-side resizing/re-encoding (e.g., via `sharp`) before storage — re-encoding strips embedded metadata (EXIF — which can include GPS location, a POPIA-relevant leak for photos uploaded from phones) and normalizes dimensions/format, at the cost of additional CPU on a small VPS. This isn't in the architecture brief explicitly but is a common real-world gap; flag it as a decide-now-or-decide-later item — at minimum, strip EXIF on upload even if no resizing is done.
   - **DECIDED**: EXIF stripping via `sharp` (no resizing — YAGNI). `file-type@18` for content-sniffed MIME (pinned to v18, last CommonJS-compatible release). `MAX_FILE_SIZE_BYTES = 5 MB`. Allowed types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Storage path from `UPLOADS_DIR` env var (default `./uploads`). UUID filenames (`<uuid>.<ext>`) — never the client-supplied name.
2. `MediaAsset` creation with `ownerType`/`ownerId` — **write the fitness-function integration test now** (architecture.md §15: "no MediaAsset row references a non-existent BlogPost/Event") since this is the riskiest part of ADR-0005's tradeoff (no DB-level FK).
   - **Validate `ownerId` existence AND ownership at creation time** — the service must (a) confirm a `BlogPost`/`Event` row with that id actually exists (guards ADR-0005's integrity gap) and (b) confirm the *current user* is allowed to attach media to it (a Blogger uploading to `ownerType: BLOG_POST, ownerId: <someone else's post>` must be rejected — see the Phase 3 note about applying `canEditPost`-style ownership checks symmetrically here). Both checks belong in the service layer, before any file is written to disk (don't write-then-validate — that leaves orphaned files on disk when validation fails).
   - Define what happens to `MediaAsset` rows (and the underlying files) when their owning `BlogPost`/`Event` is deleted — since there's no DB-level cascade (no FK), this must be handled explicitly in `BlogService.deletePost`/`EventService.deleteEvent` (delete associated `MediaAsset` rows + unlink files, or the system accumulates orphaned rows/files that the fitness-function test will start failing against). This is the natural extension of the ADR-0005 tradeoff that the architecture brief doesn't spell out but a backend engineer must handle.
   - **IMPLEMENTED**: `BlogService.deletePost` and `EventService.deleteEvent` both call `mediaService.cascadeDeleteForOwner(ownerType, ownerId)` before deleting the parent row. `MediaService.cascadeDeleteForOwner` deletes all `MediaAsset` rows for the owner in a transaction (returns the deleted rows' `url` fields) then unlinks each file (ENOENT silently ignored). Fitness-function integration test verifies zero orphaned `MediaAsset` rows remain after `deletePost`/`deleteEvent`.
3. Route: `POST /admin/media` (multipart upload, returns URL + id) — gated by role scoped to content area (`BLOGGER` for blog, `EVENT_MANAGER` for events, `ADMIN` for both). Set an explicit request body size limit at both the Express/multer layer and Nginx (`client_max_body_size`) — the two must agree, or large uploads fail with a confusing generic error.
   - **IMPLEMENTED**: `POST /admin/media` (upload), `GET /admin/media?ownerType=&ownerId=` (list), `DELETE /admin/media/:id` (delete). All three gated `requireRole('ADMIN', 'BLOGGER', 'EVENT_MANAGER')` with per-content-area ownership enforcement in the service layer. Multer memory-storage with `LIMIT_FILE_SIZE` translated to `badRequest`. Nginx `client_max_body_size 6m` note documented in `media.constants.ts`.
4. Decide and document the URL scheme returned (must match the eventual Nginx `/media/*` location block in Phase 10).
   - **DECIDED**: `MEDIA_URL_PREFIX = '/media'`. Stored as relative URL `/media/<uuid>.<ext>`. Phase 10 Nginx location block documented in `media.constants.ts` file-header. Frontend constructs absolute URLs from the relative `url` field using its own base URL.

### 4f. Users Module (Admin-only — depends on Auth) ✅ COMPLETED (2026-06-09)

> **Done on 2026-06-09.**
> Five-file module (`users.constants.ts`, `users.schemas.ts`, `users.repository.ts`, `users.service.ts`, `users.router.ts`) under `src/modules/users/`. Mounted in `app.ts` after all other modules. 50 new tests (26 service + 24 router) — all pass in isolation; the suite's intermittent "too many DB clients" failures are a pre-existing pool-exhaustion issue unrelated to this module. All invariants implemented: last-Admin lockout, self-lock prevention, temp-password generation + argon2id hash verification, `passwordHash` never exposed in any response, welcome email via `ConsoleMailService` (best-effort, non-blocking), role-change structured pino audit log (`event: 'role_change'`). No `DELETE` route — deactivation only. Audit log decision: structured pino (same Phase 4c precedent).

1. **Open question to resolve here**: *confirm Admin-only staff account creation/role assignment* — build per the documented presumption (Admin-only, no public registration); flag for stakeholder confirmation but proceed (changing it later would be additive, not destructive).
   - **RESOLVED**: Built Admin-only (`requireRole(authService, 'ADMIN')` on every route, no exceptions). Stakeholder confirmation still recommended before launch but the implementation is correct-by-presumption per plan.
2. Service + routes: `GET/POST/PATCH /admin/users` — create staff account (generates a temp password or sends an invite via the email integration), assign role, deactivate (`isActive = false`, never hard-delete — preserves authored-content audit trail per architecture.md §7.2).
   - **Guard against an Admin locking themselves (or the last Admin) out**: prevent the last remaining `ADMIN` from being deactivated or demoted to a non-Admin role via the API — a small, deliberate check (`count(role=ADMIN, isActive=true) > 1` before allowing the change) that prevents an unrecoverable state requiring direct DB intervention. Cheap to build now, painful to discover missing in production.
   - Also prevent a user from deactivating/demoting **themselves** via this endpoint (a common UX footgun — "why did I just lock myself out") unless that's an explicitly desired admin capability.
   - **IMPLEMENTED**: All four routes (`GET /admin/users`, `GET /admin/users/:id`, `POST /admin/users`, `PATCH /admin/users/:id`). Temp password: `crypto.randomBytes(16).toString('hex')` → 32 hex chars, argon2id-hashed, returned once in `POST` response only. Welcome email via injected `MailService`. Both guards implemented in service layer with clear error messages. `AdminUserView` type strips `passwordHash` before the router ever sees it. No hard-delete route.
3. Audit-log role changes (architecture.md §7.3.1 — "role changes are Admin-only operations, audit-logged"). This may warrant a small `AuditLog` table/model not explicitly in §7's ER diagram — flag this as a **schema addition decision** (small, additive migration) if a structured audit trail is wanted vs. relying on session/access logs.
   - **Recommend deciding this in Phase 1**, not Phase 4f — if a structured `AuditLog` table is wanted (and given §12.1.6 also wants export-audit-logging, and §7.3.1 wants role-change audit-logging, there are now *two* independent reasons to want one), it's better added to the *initial* migration than as a bolt-on after the schema is "final." A minimal generic shape — `AuditLog { id, actorId, action, targetType, targetId, metadata Json, createdAt }` — could serve both the role-change and CSV-export use cases with one table. Surface this to the team before Phase 1's migration is written, even though the detailed implementation naturally happens here in 4f/4c.
   - **IMPLEMENTED (structured pino)**: Role changes log `{ event: 'role_change', actorId, actorEmail, targetUserId, fromRole, toRole, timestamp }` at `info` level via the injected `logger`. Same pattern as Phase 4c's `exportForEvent` audit entry. A future `AuditLog` table migration is additive and does not require revisiting this service.

**Sequencing note**: 4a/4b can be built in parallel by two engineers/sessions since neither depends on the other (only on Phase 2/3). 4c strictly needs 4b. 4d/4e/4f can trail behind or interleave. Note that **4e (Media) has a soft dependency on 4a/4b existing first** even though it's listed last — `MediaAsset.ownerId` validation (the new note added to step 2 above) needs `BlogPost`/`Event` repositories to check existence/ownership against, so in practice build the Media *service skeleton* (file handling, validation, storage) any time, but defer wiring its `ownerId` checks until 4a/4b's repositories are available to call into.

**Critical files** (representative, one per module — full module has router/service/repository):
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\blog\blog.service.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\events\events.service.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.service.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.slots.ts` (the fixed slot registry — single most important file for ADR-0007 compliance)
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\media\media.service.ts`

---

## Phase 5 — Frontend Scaffolding & Design-System Port ✅ COMPLETED (2026-06-09)

> **Done on `feature/dynamic-rewrite`**: vite.config.ts path alias (`@` → `src/`), tsconfig.app.json `paths`, Google Fonts in `web/index.html`, design-system tokens + global CSS ported verbatim from `styles.css`, `Header`+`useDropdownNav` (full script.js port: hover-intent, touch guard, Escape, click-outside, resize, aria-expanded/aria-haspopup), `Footer`, `PageHero` (all variants including `page-hero-location`), `Card` (default/location-contact/contact-form variants), `Button` (primary/secondary), `Brand`, `FormField`+`FieldError` (aria-invalid/aria-describedby ready), typed API client (`apiFetch<T>`, `ApiError`, `isApiError`), `Providers` (React Query, staleTime 5 min, retry 1), `Layout` (Outlet-based), `Router` (element-based `<Routes>`, full public table + admin placeholder), all public page stubs with correct PageHero variants and placeholder content, Quicket event-card dropped from location pages (replaced with `/events` link per plan option b). All Reference assets copied to `web/src/assets/`. `npm run build`, `npm run lint`, `npm run typecheck` all pass clean.

**Goal**: Stand up the Vite SPA shell and port the existing branding into reusable React components — this work has **no backend dependency** and should run concurrently with backend module-building to shorten the critical path.

Steps:
1. Vite React+TS scaffold under `web/` (already done in Phase 0 — this phase fleshes it out). Configure `vite.config.ts` with the `VITE_API_BASE_URL` env convention, path aliases matching the `src/{app,design-system,public,admin,shared}` layout (architecture.md §10.1), and `vitest`/React Testing Library if component tests are wanted (YAGNI-check: a thin smoke-test layer for design-system components is reasonable; full coverage is not, for a small content site).
2. `src/app/` — router setup (React Router v6 data-router or plain `<Routes>`, whichever is simpler to wire with the auth guard — prefer the simpler element-based `<Routes>` tree over loaders/actions unless a concrete need for the latter emerges, per YAGNI), route trees split into `public/*` and `admin/*`, layout shells (the shared header/nav/footer chrome). Concretely define the public route table now so Phase 6 has a target:
   `/`, `/about`, `/cape-town`, `/durban`, `/contact`, `/blog`, `/blog/:slug`, `/events`, `/events/:slug`, plus a catch-all `*` → `NotFound` (architecture.md §10.2). Mirror this with the admin route table in Phase 7.
3. **`src/design-system/`** — port `styles.css` (571 lines) into:
   - CSS custom properties / theme tokens (the `:root` palette: `--bg`, `--accent`, `--text`, etc. — copy 1:1, do not "clean up" or rename variables during the port; a rename is a diffable, reviewable change that should happen later and deliberately, if at all).
   - Components, with concrete props/variants spelled out so nobody has to reverse-engineer the markup mid-port:
     - `Header`/`Nav` — with the dropdown/mobile-menu behavior currently in `script.js` (127 lines): port the hover/touch dropdown logic faithfully, including the `DESKTOP_BREAKPOINT`/`HOVER_CLOSE_DELAY_MS` constants and the recent "Cape Town mobile banner top gap" fix (commit `5e096f9`). This is **stateful, event-driven DOM logic** (hover-intent timers, resize listeners, touch-vs-mouse detection) — port it into a small custom hook (e.g., `useDropdownNav()`) backed by `useState`/`useRef`/`useEffect`, not a line-by-line jQuery-style DOM-manipulation transliteration; verify behavior at the same breakpoints with the same timing constants.
     - `Footer`, `Card` (the generic `<article class="card">` wrapper — used for About cards, Contact's "Reach Out" card, location-contact-cards, and the contact form's outer wrapper via a `contact-form` modifier), `PageHero` (accepts a `variant` prop mapping to `.page-hero-about` / `.page-hero-cape-town` / `.page-hero-durban` / `.page-hero-contact` / `.page-hero-location`, plus `title`/`subtitle` children — confirmed from `cape-town.html`'s markup: `<section class="page-hero page-hero-location page-hero-cape-town"><h1>…</h1><p>…</p></section>`), `Button`, `Brand`/logo.
     - Confirm from the actual markup (verified by reading `cape-town.html`/`contact.html` directly): the location pages use `.content-grid.location-content-grid` containing an `event-card` (to be replaced — see Quicket note below) and a `.location-contact-card`; the Contact page uses a plain `.card` for "Reach Out" and a `.card.contact-form` for the message form. Model these as composable variants of the single `Card` primitive (e.g., `<Card variant="contact-form">`) rather than separate components — keeps the design-system surface small (CUPID *Predictable*).
   - Bring `Reference/rejuvenateLogo.svg` and other brand images into `web/src/assets/` (or `public/`) — preserve original filenames/aspect ratios so `alt` text and CSS `background-size`/`object-fit` rules port without adjustment.
   - Google Fonts (Manrope, Space Grotesk) — port the `<link>` preconnect/stylesheet tags into the Vite `index.html` head (simplest, matches current behavior, avoids a build-time font-bundling decision that isn't needed at this scale — YAGNI on self-hosting fonts unless a Lighthouse audit later flags the external request as a real problem).
4. **Side-by-side visual parity check**: keep the legacy static HTML pages reachable (e.g., archived under `legacy-static-site/` per Phase 0 step 1, or a quick local static server) to diff against the ported components — this operationalizes "preserve branding exactly" into something checkable, not just asserted. Concretely: open both versions side-by-side at the same viewport widths (mobile/tablet/desktop breakpoints from `styles.css`) and walk every page; note any deviation as a bug, not a "future polish" item — branding fidelity is a hard constraint here, not a nice-to-have.
5. Typed API client skeleton (`shared/api/client.ts`) — `fetch` wrapper with `credentials: 'include'` (for session cookies; **never** read/write to `localStorage`/`sessionStorage` for auth state — the architecture's HttpOnly-cookie decision means the client never sees a token), base URL from env, typed response/error handling matching the `{ error: { code, message, fields? } }` shape. Define the client's small surface now: a generic `apiFetch<T>(path, options)` that (a) throws a typed `ApiError` carrying `code`/`message`/`fields` on non-2xx, (b) handles the 401 case distinctly (so `RequireAuth`/React Query can react to "session expired" uniformly — e.g., redirect to `/admin/login` on any 401 from an admin-scoped call), and (c) is the single place `credentials: 'include'` and the base URL are set. Can be built against *mocked* responses (e.g., MSW or simple fixture objects) until backend routes land, then pointed at the real API — write it against the documented `/api/v1/*` contract shapes in architecture.md §8 so the swap-over is mechanical.
6. Set up TanStack React Query provider (sensible defaults: `staleTime` tuned per query — public content can tolerate a longer `staleTime` since it changes rarely; admin lists should refetch more eagerly after mutations via `invalidateQueries`), React Hook Form + Zod resolver conventions (a shared `zodResolver(schema)` pattern and a small `<FormField>`/`<FieldError>` pair of presentational helpers so every form — RSVP, login, editors — renders field-level errors identically and accessibly, i.e. `aria-invalid`/`aria-describedby` wired to the error message id).

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\web\src\design-system\Header.tsx` (+ `.css`, + `useDropdownNav.ts` hook)
- `C:\Users\Admin\Projects\Rejuvenate\web\src\design-system\Card.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\design-system\PageHero.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\app\router.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\api\client.ts`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\api\errors.ts` (the typed `ApiError`/`{ error: { code, message, fields? } }` shape — shared by every form's error rendering)

**Note on the Quicket placeholder**: while porting `cape-town.html`/`durban.html` into React (their `event-card` blocks contain `<a class="event-link" href="https://www.quicket.co.za/">Book on Quicket</a>` alongside placeholder venue/time/date text), this is the moment to act on the open question — architecture.md §14 recommends **removal**. Drop the static Quicket link and the placeholder `event-card` block entirely when porting these pages; the new Events module (Phase 6 step 3) replaces this functionality with real, database-backed event cards (filtered by branch) and an in-house RSVP form. Flag this decision in the commit/PR description so it's traceable to the architecture's recommendation. **Practical sequencing note**: since the Events backend (Phase 4b) won't exist yet when this phase runs, the location pages will temporarily lose their "Upcoming Event" card — either (a) port the page without it and let Phase 6 step 3 add the live event-list widget, or (b) leave a simple "See our Events page for upcoming gatherings" link to `/events` as an interim placeholder. Prefer (b): it avoids a visually-empty regression during the gap between Phase 5 and Phase 6.

**Frontend Review Notes — accessibility baseline to bake in from the start (not bolt on later)**:
- Every interactive control ported from `script.js` (dropdown triggers, mobile-menu toggle) must be keyboard-operable (`Tab`/`Enter`/`Escape` to close) and expose `aria-expanded`/`aria-haspopup` — the legacy vanilla-JS version may not have done this; this is the moment to *add* it without it reading as a "redesign," since it's behavior, not visual change.
- `PageHero` headings must follow a single `<h1>` per page convention (each legacy page has exactly one `<h1>` in its hero — preserve that when composing page components from shared layout + page-specific content).
- Run an axe/Lighthouse pass on the ported pages *before* moving on to Phase 6 (don't wait for Phase 11 step 5) — it's far cheaper to fix a contrast or labeling issue while the markup is fresh in mind than to rediscover it in a final pre-launch sweep across a much larger surface area.

---

## Phase 6 — Public Pages Wired to Live Data ✅ COMPLETED (2026-06-09)

> **Done on `feature/dynamic-rewrite`**: shared types (`CmsSlotView`, `BlogPost`, `Event`), five React Query hooks (`useCmsSlots`, `useBlogPosts`, `useBlogPost`, `useEvents`, `useEvent`), `CmsSlot` dumb renderer (PLAIN_TEXT/RICH_TEXT, reused by admin SlotEditor in Phase 8 for WYSIWYG fidelity), RSVP Zod schema (`rsvp.schema.ts` — Zod v4 transform approach for age coercion, client-side gate for consent checkbox). All public pages wired: AboutPage (3 CMS slots), CapeTownPage + DurbanPage (CMS contact card + branch-filtered upcoming events strip), ContactPage (CMS Reach Out card + RHF/Zod mailto form), HomePage (2-item events + blog preview strips), BlogListPage (paginated, URL-param page), BlogPostPage (useBlogPost, 404 → NotFoundPage), EventsPage (branch/temporal filter bar + pagination, URL params), EventDetailPage (useEvent, 404 → NotFoundPage, RsvpForm gated on startsAt), RsvpForm (POPIA consent notice first, all PRD fields, hidden honeypot, field-level 400 errors via setError, top-level 409/429 messages, success state). CSS additions: loading-placeholder, rich-text, home-preview-strips, events/blog list, pagination, event-detail, rsvp-form, blog-post-body. `npm run build`, `npm run lint`, `npx tsc --noEmit` all pass clean.

**Goal**: Make the public site fully dynamic — this is where frontend meets backend for the first time (excluding auth).

**Note for the frontend reviewer/specialist (cross-cutting API contract flags from the backend review)**:
- The CMS batch-fetch shape (`GET /cms/:slotKey` vs. `GET /cms?keys=a,b,c`) is explicitly undecided in this plan (see Phase 4d) — **frontend's answer to this question is below**; confirm the chosen shape with backend before building `CmsSlot` against an assumed contract.
- `GET /blog/posts/:slug` enforces *both* `status = PUBLISHED` and `publishedAt <= now()` (an addition this review made to the plan) — a scheduled-but-not-yet-live post will 404 on direct link, which the frontend should render as a normal "not found" (`NotFound`/404 page), not a special "coming soon" state — don't build UI for a state the backend won't expose.
- The error shape's `fields` key uses Zod's field-path structure — coordinate the exact shape (flat vs. nested paths for nested objects) before building generic form-error rendering, so the RSVP/editor forms don't need rework once real validation errors start flowing. Concretely: the frontend's `<FieldError>` helper (Phase 5 step 6) needs to know whether `fields` is `{ age: ["must be a positive integer"] }` (flat, matches RHF's `setError(name, { message })` directly) or something nested like `{ "registrant.age": [...] }` — flat is strongly preferred since none of this app's forms have nested object fields; **recommend the backend keep `fields` flat, keyed by the top-level field name**, which maps 1:1 onto React Hook Form's `setError`.
- `Event.isPaid`/`price` will appear in the Event admin/detail payloads (dormant fields) — the frontend should treat them as present-but-inert per ADR-0006 (see Phase 8 step 2's show-vs-hide UX decision, which affects what the frontend needs to build). On **public** event pages, `isPaid`/`price` should simply not be rendered at all in v1 (no payment flow exists) — don't build a "Free" vs "R [price]" badge for a feature that's dormant; that's premature UI for a non-existent checkout path.

**Frontend response to the backend's "CMS batch-fetch contract shape" question** (raised in Phase 4d's note: `GET /cms/:slotKey` vs. a batched `GET /cms?keys=a,b,c`):
From the frontend's perspective, a **batched endpoint is the right call**, and here is the concrete shape the SPA would actually want to consume:
- `GET /api/v1/cms?keys=about.card.who-are-we,about.card.what-we-do,about.card.get-involved` → a **map keyed by `slotKey`**, not an array — e.g. `{ "about.card.who-are-we": { format: "plainText", value: "...", updatedAt: "..." }, "about.card.what-we-do": { ... } }`. A map lets the `CmsSlot` component do an O(1) lookup by key (`slots["about.card.who-are-we"]`) without the consuming page needing to know array order or do a `.find()`. An array-of-objects shape would force every consumer to re-derive the same lookup map — push that work into the API response once, not into N component instances.
- Each page should issue **exactly one** batch request for all the slot keys it needs (About needs 3, Cape Town/Durban need 1 each, Contact needs 1) — wired through a single `useCmsSlots(keys: string[])` React Query hook that returns the map, with `staleTime` set generously (CMS content changes rarely — minutes-to-hours is fine, this directly serves the backend's planned response-caching). This avoids the request-waterfall the backend note is rightly worried about, and minimizes round-trips on a low-resource VPS.
- For a requested key that doesn't yet have a row (the Phase 4d "registered-but-unpopulated slot" case), the **batch response should still include the key** with a safe empty value (e.g., `{ format: "plainText", value: "" }`) rather than omitting it — so `CmsSlot` always has a defined entry to render and never has to special-case "key present in request but absent in response." This keeps the renderer's contract simple: "given a `slotKey`, look it up in the map; it is always there."
- This same `useCmsSlots`/batch-map shape is reused unchanged by the admin `SlotEditor` (Phase 8 step 3) to fetch the single slot it's editing (`keys=about.card.who-are-we`) — one hook, one contract, two consumers; no parallel single-slot fetch path needs to exist.

Sequencing within this phase (each sub-step depends on the corresponding backend module from Phase 4 being deployed/runnable locally):

1. **Home, About, Cape Town, Durban, Contact** — port the static markup/branding (mostly done in Phase 5), then "hollow out" the `.card` blocks identified in architecture.md §2/§27 into CMS-slot-driven content:
   - About's three cards → `about.card.who-are-we`, `about.card.what-we-do`, `about.card.get-involved`
   - Cape Town/Durban `.location-contact-card` → `contact.capeTown.card` / `contact.durban.card`
   - Contact's "Reach Out" card / page details → `contact.page.details`
   - Build a `CmsSlot` rendering component — `<CmsSlot slotKey="about.card.who-are-we" fallbackHeading="Who Are We" />` or similar — that looks up its value from the `useCmsSlots` map (see the batch-fetch response above) and renders `plainText` (escaped, with line/paragraph breaks preserved via CSS `white-space: pre-wrap` or explicit `\n`→`<br/>` mapping — confirm which with the backend's chosen plain-text convention) or `richText` (sanitized server-side already, rendered via a tightly-scoped `dangerouslySetInnerHTML` limited to the agreed allow-list — never widen this allow-list client-side). **This exact component gets reused in the admin CMS editor's preview pane** (architecture.md §9.5 — build it once, here, so WYSIWYG fidelity is structural, not promised). Keep it a "dumb" presentational component (slot value in, rendered markup out) so it has no admin-vs-public branching logic baked in — that's what makes the reuse trivial and the fidelity guarantee real.
   - Each page composes `CmsSlot`s inside the existing `Card`/layout components from Phase 5 — the slot only ever supplies the *text*, never the surrounding card chrome, heading element, or layout grid (preserves the "layout is code-controlled" boundary structurally, not just by convention).
   - **Dependency**: blocked on Phase 4d (CMS module) + Phase 1 seed data (slot keys must exist in DB, and must match the keys this phase requests — coordinate the final slot-key list with the backend's Phase 1 seed before either side hardcodes them; a mismatch here surfaces as a silent "empty card" with no error).
2. **Blog** (`BlogIndex`, `BlogPostDetail`) — list/detail pages consuming `GET /blog/posts` / `/blog/posts/:slug`, paginated per the backend's page/limit convention (Phase 4a step 5). `BlogIndex` needs a simple pager UI (Prev/Next or page numbers — keep it minimal, no infinite-scroll complexity for a small post volume). `BlogPostDetail` renders the sanitized rich-text body via the same constrained `dangerouslySetInnerHTML` pattern as `CmsSlot`'s richText path (share the rendering helper between them — one sanitized-HTML-render function, two call sites) and lists any attached `MediaAsset` images with their `altText`. Render a `NotFound` state for 404s (including the scheduled-but-not-yet-published case noted above) rather than a blank page or spinner-forever. **Dependency**: Phase 4a.
3. **Events** (`EventsIndex`, `EventDetail`, `RsvpForm`) — list/detail consuming `GET /events`/`/events/:slug` (filterable by branch — wire simple branch filter controls on `EventsIndex` consistent with the Cape Town/Durban page contexts, and respect whatever "upcoming vs. past" semantics the backend lands on per Phase 4b step 3); the RSVP form is the most sensitive piece and deserves its own component breakdown:
   - **Consent-first UX**: display the **POPIA consent/privacy notice** prominently *before* the input fields (not buried in a footer link or only-on-submit modal) — architecture.md §12.1.2 — even if using placeholder wording pending the stakeholder's confirmed text (flag visibly in code/comments — e.g., `{/* PLACEHOLDER COPY — pending stakeholder sign-off, see Phase 9 */}` — that this copy is provisional, and structure the component so swapping the copy string is the only change needed once Phase 9 lands).
   - **Field set — exactly the PRD-named fields, no more**: first name, surname, age, email, phone, plus a required "I have read and agree to the above" consent checkbox bound to `consentVersion`. Do not add any field not in this list (no "how did you hear about us," no marketing opt-in) — POPIA data minimization is a frontend discipline too, not just a schema one.
   - **Validation**: build the Zod schema for this form to mirror the backend's exactly — `firstName`/`surname` non-empty strings with sane max-lengths, `age` a **positive integer** (use `z.coerce.number().int().min(0).max(120)` or equivalent on a text/number input — be deliberate about `<input type="number">`'s quirks with leading zeros/decimals/locale; a masked or pattern-validated text input may be more predictable), `email` via `z.string().email()`, `phone` a loosely-validated string (international/local formats vary — don't over-constrain with a brittle regex that rejects legitimate numbers). Use the **same `zodResolver` + `<FieldError>` convention** from Phase 5 so server-returned `fields` errors (e.g., a server-side uniqueness/timing rule the client can't fully replicate) surface in the same place as client-side errors.
   - **Submission UX**: disable the submit button while the mutation is in flight (prevent the double-click that the backend's "soft duplicate guard" exists to catch — client-side debouncing is a courtesy to the user and the server, not a substitute for the server's own guard), show a clear success state (confirm what was submitted, restate that a confirmation email may follow per architecture.md §5/§12.1.7 once email integration exists), and surface capacity-exceeded (`409`) and validation (`400`) errors distinctly — "this event is full" is not a validation error and should not render inside the form's field-error list.
   - Submits to `POST /events/:slug/registrations` via a React Query `useMutation` (no need to cache RSVP submissions — they're write-once; just track in-flight/error/success state).
   - **Dependency**: Phase 4b + 4c.
4. **Contact form**: re-check the PRD — it doesn't explicitly require persisting contact-form messages, only the CMS-editable "Reach Out" details (`contact.page.details`). Replace the static `action="#"` stub with either (a) a `mailto:` link, or (b) a simple POST to a hosted form-relay/email-forwarding service — **do not invent a `ContactMessage` table or backend endpoint** that isn't in architecture.md's data model; that would be scope creep into backend territory the architecture deliberately didn't take on. If the org later wants persisted contact messages, that's a new backend module + ADR, not a frontend-only addition. Whichever interim approach is chosen, it still needs basic client-side validation (name/email/message required, valid email) and an accessible success/error state — it's a real form a real visitor will use, even if it's not POPIA-sensitive in the same way RSVP is.

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\web\src\public\pages\Events\RsvpForm.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\public\pages\About\About.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\components\CmsSlot.tsx` (or wherever the shared slot-renderer lives — critical for §9.5 fidelity)
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\hooks\useCmsSlots.ts` (the batch-fetch React Query hook — shared by public pages and the admin `SlotEditor`)
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\schemas\rsvp.schema.ts` (the Zod schema mirroring the backend's registration validation — single source of truth for RSVP client-side validation)

---

## Phase 7 — Admin Area: Auth-Gated Shell + Dashboard ✅ COMPLETED (2026-06-09)

**Goal**: Build the admin route tree's skeleton — `RequireAuth`, `RoleGuard`, login page, dashboard — before building feature-specific admin screens.

Steps:
1. `Login` page (`/admin/login`) — a React Hook Form + Zod form (email + password, both required, email format validated client-side as a courtesy; the *real* check is server-side) that posts to `POST /auth/login` via the typed API client with `credentials: 'include'`. On success, invalidate/refetch the `useCurrentUser` query (see step 2) and redirect to `/admin` (or the originally-requested admin route — preserve the "redirect back after login" `state.from` pattern so a bookmarked deep link works). On failure, show a single generic "invalid email or password" message — **do not** distinguish "wrong password" from "no such account" in the UI (mirrors the backend's account-enumeration defense from Phase 3 step 4; a frontend that says "no account with that email" defeats a server-side control that exists specifically to prevent that leak).
2. **Session/identity plumbing**: a `useCurrentUser()` React Query hook wrapping `GET /me` — this is the single source of truth for "who is logged in and what's their role" throughout the admin tree (`RequireAuth`, `RoleGuard`, `Dashboard`, nav, and any "logged in as X" display all read from this one cached query, never from a locally-duplicated copy of the user object). Configure it to treat a `401` response as "not authenticated" (not an error to retry/alert on) — this is exactly the distinct-401-handling the typed client (Phase 5 step 5) needs to support.
3. `RequireAuth` — wraps `/admin/*`, reads `useCurrentUser()`; while loading, render a neutral loading state (not a flash of the login page or a flash of protected content); if unauthenticated, `<Navigate to="/admin/login" state={{ from: location }} replace />`. This is **UX redirection only** — the architecture is explicit (§10.2) that server-side authorization is the actual boundary; `RequireAuth` exists so a logged-out visitor doesn't see a broken admin shell mid-fetch, not to "secure" anything.
4. `RoleGuard` — a small composable wrapper (`<RoleGuard allow={['ADMIN', 'BLOGGER']}>...</RoleGuard>` or a `useHasRole(...roles)` hook for inline conditionals) that hides nav items/routes per the **RBAC matrix** (architecture.md §9.2 table). Concretely, encode the matrix as the nav's data, not as scattered conditionals — e.g. a small `adminNavConfig` array of `{ label, to, allowedRoles }` entries that both the nav renderer and the route table iterate over, so the "what can role X see" answer lives in exactly one place and the matrix can be eyeballed against architecture.md §9.2 directly:
   - Admin: Dashboard, Blog, Events, Registrations (via Events), CMS, Users
   - Blogger: Dashboard, Blog (own posts only — enforced by the API; the UI additionally just doesn't show other authors' posts in the list)
   - Event Manager: Dashboard, Events, Registrations
   - A route a role can't reach (e.g., a Blogger navigating directly to `/admin/cms/...` by URL) should redirect to the Dashboard with a brief "you don't have access to that" notice — not a blank page or a console error — even though the API would also 403 it.
5. `Dashboard` — minimal landing page showing role-appropriate quick links/summary (e.g., "3 draft posts," "Next event in 5 days" — keep simple, no analytics per non-goals; this likely needs small, cheap summary queries from the Blog/Events APIs — confirm with the backend whether existing list endpoints with `limit=1`/count metadata suffice, or whether a dedicated summary endpoint is warranted; **prefer reusing existing list endpoints** over asking the backend to build a bespoke dashboard-summary endpoint for what is explicitly a "keep it simple" screen).
6. Admin layout shell (nav differs from public site — staff-focused: no hero banners, a persistent sidebar/topbar with the current user's name+role and a logout action that calls `POST /auth/logout` then clears the `useCurrentUser` cache and redirects to `/admin/login`). Reuse design-system primitives (`Button`, color tokens, fonts) from Phase 5 so the admin area still feels like *this* site's brand, just in a utilitarian staff-facing layout — it should not look like a generic admin template bolted onto the brand.

**Dependency**: strictly requires Phase 3 (Auth module + RBAC middleware) deployed and runnable.

**Frontend Review Note**: Build `useCurrentUser`/`RequireAuth`/`RoleGuard` *before* any feature screen in Phase 8 — every one of those screens assumes this plumbing exists and is correct. Treat a bug here (e.g., a stale cached user after logout, or a `RoleGuard` that flickers protected content before redirecting) as a blocker for Phase 8, not a "fix it later" — these are exactly the kind of subtle defects that erode trust in "is this thing actually secure" even though the real boundary is server-side.

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\components\RequireAuth.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\components\RoleGuard.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\pages\Login\Login.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\hooks\useCurrentUser.ts`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\config\navConfig.ts` (the single-source-of-truth RBAC-matrix-as-data for nav + route gating)

---

## Phase 8 — Admin Feature Screens (in dependency order, mirroring Phase 4) ✅ COMPLETED (2026-06-09)

Each screen is blocked on its corresponding backend module (Phase 4) AND the admin shell (Phase 7). All list/mutation screens use React Query (`useQuery` for lists/detail, `useMutation` + `invalidateQueries` for create/update/delete/publish actions — e.g., publishing a post should invalidate both the admin list and, if cached, the public blog-list query so the new state is reflected without a manual refresh).

1. **Blog admin** (`PostList`, `PostEditor`):
   - `PostList` — author-scoped list (Bloggers see own only — both because the API scopes the query *and* because a Blogger seeing other authors' drafts in a list they can't open would be confusing UX; Admins see all with an author column/filter), status badges (Draft/Published), publish/unpublish actions, and a clear empty-state for "no posts yet."
   - `PostEditor` — rich-text editor for post bodies (TipTap/Lexical — justified per architecture.md §9.5 as the *one* place a heavyweight editor is appropriate; pick one now rather than deferring — TipTap is the lighter-weight, more actively-maintained option for a small team and integrates cleanly with React Hook Form via a controlled-field adapter). Concretely scope the editor's toolbar to what the PRD actually asks for (rich text + embedded images — headings, bold/italic, lists, links, images) and **resist the urge to enable every plugin TipTap ships with**; an unconstrained toolbar increases the sanitizer allow-list surface (the backend has to accept whatever the editor can produce) and the support burden. Coordinate the editor's output-HTML shape with the backend's `sanitize-html` allow-list (Phase 4a step 2) — they must agree, or the admin will see "my formatting disappeared" after save, which is exactly the WYSIWYG-fidelity problem §9.5 exists to prevent (this is the blog-body analogue of the CMS fidelity guarantee, even though it uses a heavier editor).
   - Image upload integration (→ Media module, Phase 4e): an `ImageUploadField` that posts to `POST /admin/media` with `ownerType: BLOG_POST`/`ownerId: <post.id>`, shows upload progress, and on success either inserts the image into the rich-text body or attaches it to the post's media list (confirm which UX the PRD/backend expects — a blog post's "embedded images" suggests inline insertion via the editor's image tool, which is the more natural fit for TipTap). Handle the **new-post-has-no-id-yet** ordering problem explicitly: either (a) require saving the post as a draft before allowing image upload (simplest — gate the upload UI on `post.id` existing), or (b) support a staged-upload-then-associate flow. Recommend (a) — it's a one-line UX constraint ("save your draft before adding images") and avoids a more complex orphaned-upload reconciliation flow.
   - Draft/publish controls with the slug-stability behavior from Phase 4a step 2 reflected in the UI — e.g., show the slug as read-only/locked once a post has been published (with an Admin-only "edit slug" affordance if that's the chosen policy), so authors don't expect a title edit to silently change the public URL.
2. **Events admin** (`EventList`, `EventEditor`, `RegistrationsView`):
   - `EventEditor` — full CRUD form (title, description via a lighter rich-text or plain-textarea control — confirm with backend whether `Event.description` is `plainText` or allows rich text; the ER diagram just says `text`), branch, dates, location detail, capacity, status. For the **dormant `isPaid`/`price` fields**: this review recommends **hiding them entirely from the v1 form** rather than showing-but-disabled — a visible-but-inert "Price (coming soon)" field invites Event Managers to fill it in "for when it's ready," producing stored values the system then has to decide whether to honor later (a confusing half-state). Hidden fields cost nothing to re-add when paid ticketing actually ships (per ADR-0006's Open/Closed framing — the *form* gets a new section, not a retrofit); a visible-but-fake field actively misleads users about what the system currently does. **Flag this as a decision needing a one-line confirmation from the team before building the form** — it's cheap to reverse either way, but someone should consciously choose.
   - Status-transition UI must reflect whatever transition graph the backend defines (Phase 4b step 4) — e.g., don't render a "Reopen" button for a `CANCELLED` event if that transition isn't allowed server-side; the UI offering an action the API will reject is a worse experience than not offering it. If an event has existing registrations, surface that count prominently before allowing a cancel/date-change action (per the same backend note) — a simple "this event has 47 registrations — cancelling will not notify them automatically" confirmation dialog is enough for v1 (no notification mechanism exists yet).
   - `RegistrationsView` — attendee list with headcount (vs. capacity, if set — show "47 / 60" or "47 registered (no capacity limit)"), and a CSV export button (`GET /admin/events/:id/registrations.csv`) that triggers a file download (`<a download>` with a blob URL, or a direct navigation if the endpoint sets `Content-Disposition: attachment` correctly — confirm with backend which, since it changes the frontend implementation). This view renders the most POPIA-sensitive data the admin UI shows — apply the same data-minimization instinct as the RSVP form: show what Event Managers need for logistics (name, age, contact details, registration time) and nothing decorative.
3. **CMS admin** (`SlotEditor`): reuses the `CmsSlot` rendering component **and the `useCmsSlots` hook** from Phase 6 (see that phase's batch-fetch contract response) as a live preview pane — a constrained input (plain `<textarea>` for `plainText` slots, or the tiny bold/italic/line-break-only rich-text control for `richText` slots — match the input affordance to the slot's `format`, don't offer rich-text controls on a plain-text slot) on one side, the *exact* `<CmsSlot>` public-rendering component on the other, **fed the in-progress form value (not the saved value) so the preview updates on every keystroke** — this "live, uncommitted value in, live render out" wiring is what makes the WYSIWYG guarantee real rather than "looks right after you save and reload." On save (`PUT /admin/cms/:slotKey`), invalidate the `useCmsSlots` cache for that key so the public pages (if open in another tab/on next navigation) pick up the change — and so the editor's own preview now reflects the persisted (sanitized) value, which is a useful sanity check that what was sanitized server-side still matches what was previewed client-side.
4. **Users admin** (`StaffAccountList`, `StaffAccountEditor` — Admin-only): create staff accounts, assign roles, deactivate/reactivate. Gated doubly: `RoleGuard` hides the nav entry from non-Admins, and the API independently enforces it. Reflect the backend's "can't deactivate/demote the last Admin or yourself" guard (Phase 4f step 2) in the UI — disable that action with an explanatory tooltip/message rather than letting the admin attempt it and receive a raw `409`/`403`. Show `isActive` status clearly (a deactivated account is not deleted — preserve that distinction visually, e.g., "Deactivated" badge vs. removing the row).

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\pages\Cms\SlotEditor.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\pages\Events\RegistrationsView.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\pages\Blog\PostEditor.tsx`
- `C:\Users\Admin\Projects\Rejuvenate\web\src\admin\components\ImageUploadField.tsx`

---

## Phase 9 — POPIA Compliance Completion (Retention Job, Audit, Consent Finalization)

**Goal**: Close out the privacy-control mechanisms whose *values* depend on organizational/stakeholder decisions.

This phase is explicitly **gated on the stakeholder answering the go-live-blocking open question**: *"Confirm POPIA retention period for Registration data and required consent-notice wording."*

Steps (sequence once the answer arrives — but the *mechanism* should already be wired by Phase 4c so this phase is "flip the switch," not "build from scratch"):
1. Update `Registration` creation to set a real `retainUntil` (e.g., `eventDate + N months`, per the confirmed period) instead of the placeholder. **Also backfill `retainUntil` on any `Registration` rows created during the placeholder period** (between go-live and the stakeholder's answer) — don't leave a cohort of rows with `null`/provisional values that the purge job will never pick up; write a one-off migration script for this and run it as part of "flipping the switch."
2. Replace the placeholder consent-notice copy in the RSVP form (Phase 6) with the confirmed wording; bump `consentVersion` to mark the change (architecture.md §12.1.2 — versioning makes notice changes auditable). Note: bumping `consentVersion` only affects *future* registrations — existing rows retain the version string they were created under, which is the entire point (an auditable record of what each registrant actually agreed to). Don't be tempted to "fix" historical rows to the new version.
   - **Frontend note**: per Phase 6 step 3's component design, this should be a single-string copy swap in the `RsvpForm` (the placeholder was deliberately isolated behind a clearly-marked constant/prop, not interleaved with layout markup) — if it turns out to require touching component structure, that's a signal the Phase 6 implementation didn't isolate the copy as cleanly as intended; treat that as a small bug to fix, not "just how it has to be." The `consentVersion` value sent with the submission should also live alongside that copy constant (e.g., `export const CONSENT_NOTICE = { version: "v1-placeholder", text: "..." }`) so the two can never drift out of sync.
3. Build the **scheduled purge job** (cron + script, or PM2 cron-task): finds `Registration` rows past `retainUntil`, anonymizes or deletes per the organization's policy choice (anonymize preserves headcount history; delete is simpler — confirm which with the stakeholder as part of the same retention conversation).
   - **Make the job idempotent and safe to re-run** (it will run daily; a crash mid-run must not double-process or corrupt rows). Log a summary (count anonymized/deleted, run duration) — this is the kind of unattended job that needs to leave a trail for a solo operator to audit later, especially since it's destructive/irreversible by nature.
   - If "anonymize" is chosen: define precisely what that means at the field level (e.g., null out `firstName`/`surname`/`email`/`phone`, keep `age`/`eventId`/`registeredAt` for headcount/historical reporting) — write this down as a documented transformation, not an ad-hoc set of nulls decided at code-review time.
4. Write the **fitness-function test** named in architecture.md §15: assert registrations past `retainUntil` are anonymized/purged by the job — this can only be meaningfully written once the policy (anonymize vs. delete, and the period) is known.
5. Add the audit-log for registration-CSV exports (architecture.md §12.1.6) if not already done in Phase 4c.
6. Confirm POPIA Information Officer designation is an **organizational** action (architecture.md §12.2) — the system should support it operationally (Admin can fulfill data-subject access/correction/deletion requests via the existing Users/Registrations admin views) but the designation itself is outside the system.

**This phase cannot be fully completed without the stakeholder's answer** — flag it as a tracked, named blocker in the project plan/issue tracker, not a silent TODO. Everything else in the plan can proceed without it; only this phase's *final* steps are gated.

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\api\src\jobs\purgeRegistrations.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.service.ts` (update `retainUntil` calculation)

---

## Phase 10 — Deployment Setup (Linode VPS)

**Goal**: Stand up the production topology described in architecture.md §11 — can begin in parallel with later feature phases (it's infrastructure work, not feature work) but the *first deploy* naturally happens once Phases 1-8 produce a buildable artifact.

Steps:
1. **Provision the VPS**: Ubuntu LTS, SSH key-auth only (disable password auth), create a non-root deploy user. Apply OS security updates and enable unattended-upgrades for security patches — a solo-operator VPS that nobody patches is a long-tail risk the architecture's "best-effort availability" framing doesn't excuse.
2. **`ufw` firewall**: allow only 22 (SSH), 80, 443.
3. **PostgreSQL**: install locally, bind to `127.0.0.1:5432`, create the production database/user (a dedicated least-privilege DB user for the app — not the Postgres superuser), configure `pg_hba.conf` for localhost-only access. Set a strong, generated `DATABASE_URL` password and store it only in the server's `.env` (with restrictive `chmod 600` permissions) — never in the repo.
4. **Nginx**: 
   - TLS via Certbot/Let's Encrypt (auto-renewal cron verified).
   - Serve the SPA build (`/var/www/rejuvenate/dist`).
   - Reverse-proxy `/api/*` → `http://127.0.0.1:3000` — and **set `proxy_set_header X-Forwarded-For`/`X-Forwarded-Proto`/`Host`** so Express's `trust proxy` setting (Phase 2 note) and `express-session`'s `secure` cookie detection work correctly. This is the deployment-side half of that Phase 2 dependency — list it explicitly here so it isn't assumed to "just work."
   - Dedicated `location /media/ { ... }` block for uploads — content-type allow-list, **disable script execution** in that directory (defense against malicious uploads), and set `client_max_body_size` to match the Media module's upload limit (Phase 4e note — the two must agree).
   - Security headers (HSTS, X-Content-Type-Options, X-Frame-Options/CSP, Referrer-Policy), gzip/Brotli, cache headers (long cache + content-hashed filenames for the SPA's static assets; short/no-cache for `index.html` so deploys take effect immediately).
5. **Process supervision**: PM2 (or systemd unit) for the Node API — auto-restart, log rotation, `pm2 reload` for near-zero-downtime deploys. **Configure PM2/systemd to start on boot** (`pm2 startup` + `pm2 save`, or `systemctl enable`) — a VPS reboot (kernel update, provider maintenance) must not require manual intervention to bring the API back up.
6. **Deploy script**: `git pull && npm ci && npm run build && prisma migrate deploy && pm2 reload` — keep it simple per architecture.md §11.2 (no heavyweight CI/CD).
   - **Sequencing matters**: run `prisma migrate deploy` *before* `pm2 reload` (as written, correctly) so the new code never runs against an old schema — but also verify the *previous* running process can tolerate the *new* schema for the brief window between migration and reload (forward-compatible migrations: prefer additive changes, avoid drop-column/rename-column in the same deploy as the code that stops referencing them — a two-step "expand, then contract" pattern for breaking schema changes). Document this convention now so it's second nature once the schema is live with real data.
   - Confirm the deploy user has the necessary permissions to run `prisma migrate deploy` (DB credentials available in the server's `.env`) and to signal PM2 — without `sudo` for routine deploys (least privilege).
7. **Backups**: automated daily `pg_dump` + uploads-directory backup, shipped **off-host** (Linode Object Storage or equivalent) — this is non-negotiable per architecture.md §11.2/§12 ("a single-VPS architecture without off-host backups is a single point of total data loss... unacceptable given the system now holds personal data").
   - **Test the restore path, not just the backup job** — an unrestored backup is theoretical insurance. Schedule (and document) a periodic "restore the latest backup into a scratch DB and verify row counts/spot-check data" drill; this is the single most commonly-skipped step in small-team ops and the one that turns "we have backups" into "we have backups that work."
   - Encrypt backups at rest in off-host storage (they contain the same personal data as the live DB) and ensure the backup retention period itself doesn't quietly violate the POPIA retention policy once that's confirmed (Phase 9) — a purge job that anonymizes live rows but leaves un-anonymized copies in 2 years of daily backups undermines the retention guarantee. Flag this as a POPIA-adjacent detail worth raising alongside the Phase 9 stakeholder conversation.
8. **Monitoring**: external uptime monitor hitting `/healthz`; log retention/rotation for Nginx and PM2.
9. **Encryption at rest** (recommended, architecture.md §12.1.5): enable disk-level or Postgres-level encryption on the VPS volume.
10. Document the rollback process (git revert + `prisma migrate resolve` + redeploy) — substitutes for a staging environment at this scale (architecture.md §11.3).
11. **Reiterate the uploads-directory safety note from Phase 0**: confirm the production `uploads/` path lives *outside* `/var/www/rejuvenate/dist` (the SPA build output) and outside any directory `npm run build`/`git pull` could overwrite or clean. Write this into the deploy script as an assertion/sanity-check (e.g., fail loudly if the configured uploads path resolves inside the build output dir) rather than relying on operator memory — this is exactly the kind of mistake that destroys user-uploaded content silently on a routine deploy.

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\deploy\nginx\rejuvenate.conf`
- `C:\Users\Admin\Projects\Rejuvenate\deploy\pm2\ecosystem.config.js` (or systemd `.service` unit)
- `C:\Users\Admin\Projects\Rejuvenate\deploy\scripts\deploy.sh`
- `C:\Users\Admin\Projects\Rejuvenate\deploy\scripts\backup.sh`

**Backend Review Note**: The plan correctly says deployment work "can begin in parallel ... it's infrastructure work." One refinement: provision the VPS and get a bare-bones Nginx+Postgres+PM2 skeleton live **early** (e.g., right after Phase 2/3), even before there's a full feature set to deploy — deploying a trivial "hello world" + `/healthz` end-to-end early flushes out TLS/firewall/proxy/systemd issues while the stakes are low, rather than discovering a Certbot or `trust proxy` misconfiguration during the first real launch crunch.

---

## Phase 11 — Testing, Fitness Functions & Launch Readiness

**Goal**: Operationalize the architecture's "fitness functions" (architecture.md §15) into automated, repeatable checks — the project's definition of "actually done," not just "code exists."

Steps (each maps to a named fitness function from §15):
1. **MediaAsset referential-integrity test**: integration test asserting no `MediaAsset` row references a non-existent `BlogPost`/`Event` (guards ADR-0005's no-DB-FK tradeoff). Write alongside or immediately after Phase 4e. Also assert the *ownership* check (a Blogger cannot create a `MediaAsset` against another author's post) — this is functionally part of the same risk surface and should live in the same test file/suite.
2. **Capacity-concurrency test**: assert `Registration` count never exceeds `Event.capacity` under concurrent submissions (guards invariant §7.3.6) — write alongside Phase 4c; this is the single highest-risk race condition in the system (overselling/over-registering a capacity-limited event). **Make this a genuine concurrency test** (fire N parallel requests at a capacity-1 or capacity-N event via `Promise.all`/a load-test tool, not a sequential loop with assertions) — a sequential test will pass against a broken (non-transactional) implementation and give false confidence. This is the test most likely to be written wrong in a way that still goes green.
3. **CMS unknown-slot-key rejection test**: assert writes to unknown `slotKey` values are rejected (guards ADR-0007) — write alongside Phase 4d.
4. **Retention purge test**: assert registrations past `retainUntil` are anonymized/purged (guards POPIA control) — **only buildable once Phase 9's policy is confirmed**, as noted there.
5. **Accessibility check**: Lighthouse/axe automated check against public pages in CI or a pre-deploy script — operationalizes the "baseline accessibility" goal (semantic HTML, labels, contrast, keyboard nav). **This is a formalization, not a first look** — Phase 5's note already calls for running this informally on the ported design-system pages before Phase 6 begins; here it becomes an automated, repeatable gate (e.g., `@axe-core/playwright` assertions in the e2e suite, or a Lighthouse CI budget) so a later change can't silently regress contrast/labeling that was once verified by eye. Extend the same check to the **admin area** post-login (Phase 7/8) — form labeling and keyboard navigation matter at least as much there (staff may use the CMS/editor screens daily) and are easy to overlook because "it's just for us."
6. **End-to-end smoke test** (optional but recommended for a solo operator): a thin Playwright/Cypress suite covering the critical user journeys from PRD §5 (read a blog post, register for an event, admin publishes a post, admin edits a CMS slot) — cheap insurance against "it worked on my machine" regressions before each deploy. **Frontend addition**: also cover the RSVP form's POPIA-sensitive path explicitly — submit with consent unchecked (must block submission client-side), submit with an invalid age (must surface the field error), and submit successfully (must show the success state and not resubmit on a second click of a disabled button) — this form is the single highest-stakes piece of public-facing UI in the system and deserves its own named scenarios, not just a "fill the form, hit submit" happy-path line in a generic suite.
7. **Visual-parity check**: confirm the ported design-system components render equivalently to the legacy static pages (Phase 5's parity check, formalized as a checklist or visual-regression snapshot — e.g., Playwright's screenshot comparison against the archived `legacy-static-site/` pages at the same viewport widths). Run this once after Phase 5 and again after Phase 6 (CMS-driven content can shift card heights/line counts in ways static placeholder text didn't) — branding fidelity is a moving target until the real content is in place, not a one-time check.
8. **Stakeholder sign-off checklist** (architecture.md §15 "Validate before/during build"): before declaring v1 launch-ready, confirm:
   - POPIA retention period + consent wording (blocking)
   - Blogger cross-author permissions (cheap to decide now)
   - Event capacity/waitlisting behavior (cheap to decide now)
   - Quicket placeholder disposition (recommend: removed — already acted on in Phase 5)
   - Transactional email provider chosen and wired (Phase 3a/9)
9. **Backend-specific pre-launch checks not explicitly named as "fitness functions" in §15 but worth adding to this phase's checklist**:
   - **Rate-limit verification under realistic conditions**: confirm `express-rate-limit` is actually keying off real client IPs in production (the `trust proxy`/Nginx `X-Forwarded-For` chain from Phases 2/10) — a rate limiter that silently rate-limits "127.0.0.1" for every visitor is a (different, but real) production surprise.
   - **Backup-restore drill executed at least once** before go-live (per the Phase 10 note) — "we have a backup script" and "we have verified we can restore from a backup" are different claims; only the second is launch-readiness evidence.
   - **Login/RSVP rate-limit and account-enumeration spot-check**: manually verify the password-reset endpoint's response is indistinguishable for existing vs. non-existent emails (Phase 3 note), and that login lockout/rate-limiting actually engages after N failed attempts.
   - **`/healthz` failure-mode check**: stop the DB temporarily in a staging/local environment and confirm `/healthz` correctly reports unhealthy (not a false "OK") — verifies the monitoring chain end-to-end, not just its happy path.

**Critical files**:
- `C:\Users\Admin\Projects\Rejuvenate\api\tests\integration\mediaAsset.integrity.test.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\tests\integration\registrationCapacity.test.ts`
- `C:\Users\Admin\Projects\Rejuvenate\api\tests\integration\cmsSlotRegistry.test.ts`

---

## Milestone / Session Mapping (suggested grouping for discrete work sessions)

| Milestone | Phases | Status | Can run in parallel with |
|---|---|---|---|
| M1 — Foundations | 0, 1, 2 | ✅ Done (2026-06-07/08) | — |
| M2 — Auth spine | 3 | ✅ Done (2026-06-08) | M3 (design-system port has no backend dependency) |
| M3 — Branding port | 5 | ✅ Done (2026-06-09) | M2 |
| M4 — Content backend | 4a, 4b, 4d | ✅ Done (2026-06-08) | — (sequential within: blog/events parallel, CMS can trail) |
| M5 — Public site goes live | 6 | ✅ Done (2026-06-09) | Starts once M3+M4(partial: CMS, Blog, Events) land |
| M6 — Registration backend | 4c | ✅ Done (2026-06-08) | Needs 4b done |
| M7 — RSVP goes live | 6 (RSVP portion) | ✅ Done (2026-06-09) | Needs M6 |
| M8 — Media + Users backend | 4e, 4f | ✅ Done (2026-06-09) | Can trail M4/M6 |
| M9 — Admin shell | 7 | ✅ Done (2026-06-09) | Needs M2 |
| M10 — Admin feature screens | 8 | ✅ Done (2026-06-09) | Needs M9 + corresponding M4/M6/M8 module |
| M11 — POPIA finalization | 9 | ⬜ Not started — **gated on stakeholder retention-period answer** | Track as external dependency |
| M12 — Deployment | 10 | ⬜ Not started | Can start infra prep anytime; first real deploy needs M5+M7 buildable |
| M13 — Testing/launch readiness | 11 | ⬜ Not started | Interleave fitness-function tests with their corresponding module phase; final smoke-test pass gates launch |

**Critical-path observation**: the longest dependency chain is `Phase 1 (schema) → Phase 3 (auth) → Phase 7 (admin shell) → Phase 8 (admin screens) → Phase 11 (sign-off)`, with `Phase 4 → Phase 6 (public data wiring)` as a parallel branch that must also complete before a meaningful first deploy. Phase 5 (branding port) is the only large chunk of work with zero backend dependency — front-load it to keep the frontend specialist productive while backend phases 1-4 are underway.

---

### Critical Files for Implementation

- `C:\Users\Admin\Projects\Rejuvenate\api\prisma\schema.prisma` — the entire data model gates every backend module; getting this right once (per architecture.md §7, including dormant `isPaid`/`price`, `consentVersion`/`retainUntil`, fixed `slotKey`) avoids painful migrations-on-live-data later.
- `C:\Users\Admin\Projects\Rejuvenate\api\src\middleware\rbac.ts` — the `requireAuth()`/`requireRole()` middleware is the single security boundary every protected route depends on; the entire RBAC matrix (architecture.md §9.2) is enforced through this one file plus the `canEditPost` ownership-check helper.
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\cms\cms.slots.ts` — the fixed slot-key registry is the concrete embodiment of ADR-0007 ("named-slot CMS, not generic page builder"); every other CMS file (service, router, seed, frontend `CmsSlot` component) must agree with this single source of truth.
- `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\components\CmsSlot.tsx` (or equivalent shared rendering component), paired with `C:\Users\Admin\Projects\Rejuvenate\web\src\shared\hooks\useCmsSlots.ts` (the batch-fetch hook — see Phase 6's response to the backend's open contract question) — reused identically on public pages and inside the admin `SlotEditor` preview pane; this single component+hook pair is what makes the WYSIWYG fidelity guarantee (architecture.md §9.5) structural rather than aspirational.
- `C:\Users\Admin\Projects\Rejuvenate\web\src\design-system\Header.tsx` (and its sibling design-system components/CSS, ported from `styles.css`/`script.js`) — the entire "preserve existing branding" constraint (PRD §12, architecture.md §10.3) lives or dies on the fidelity of this port; it's also the highest-leverage early/parallel task since it blocks nothing on the backend side but blocks all public-page work on the frontend side.
- `C:\Users\Admin\Projects\Rejuvenate\api\src\modules\registrations\registrations.service.ts` — the single highest-risk piece of business logic (POPIA-sensitive personal data capture, transactional capacity enforcement, consent versioning, provisional `retainUntil`) and the one most entangled with an external, currently-unanswered stakeholder decision (retention period); changes here ripple into the RSVP form, the purge job, and the launch-readiness sign-off checklist.
</content>
