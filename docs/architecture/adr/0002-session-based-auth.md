# ADR-0002: Session-Based Authentication over JWT

## Status

Accepted

## Context

Three roles (`ADMIN`, `BLOGGER`, `EVENT_MANAGER`) require authenticated login to
access the admin backend; the public site requires no authentication. The frontend is
a same-origin SPA served from the same deployment as the API (single-origin
deployment, ADR-0003). There is no current or near-term requirement for a separate
API consumer (e.g., a native mobile app) — that is explicitly out of scope.

The two mainstream approaches for web session management are:
1. Server-side sessions, referenced by an opaque ID stored in an HttpOnly cookie, with
   session state held in a shared store (e.g., Postgres, Redis).
2. Stateless JSON Web Tokens (JWTs), typically stored in browser storage or cookies,
   carrying signed claims that the server verifies without a lookup.

Security requirements (architecture.md §12 / POPIA) call for minimizing XSS/
token-theft surface and for the ability to instantly revoke access (e.g., when an
Admin deactivates a staff account or changes a role).

## Decision

Use **server-side sessions** stored in HttpOnly, Secure, SameSite=Lax cookies, backed
by a **PostgreSQL-backed session store** (via `connect-pg-simple`), **not** JWTs held
in browser storage.

## Consequences

**Positive:**
- Instant revocability: deactivating a user or changing their role takes effect
  immediately by deleting/invalidating the session row(s) — no waiting for token
  expiry, no token-blacklist infrastructure required.
- Reduced XSS/token-theft surface: HttpOnly cookies are not readable by client-side
  JavaScript, unlike tokens stored in `localStorage`/`sessionStorage`.
- Operationally simple: one additional table in the database we already run and back
  up (no separate Redis/cache tier to provision, secure, and monitor on the VPS).
- Plays naturally with a same-origin SPA + API deployment (no CORS/credential-sharing
  complexity that cross-origin token APIs typically introduce).

**Negative / tradeoffs:**
- Marginally more friction if a separate, independent API consumer appears later
  (e.g., a future native mobile app that cannot easily participate in cookie-based
  sessions). This is an explicitly out-of-scope concern for v1 (PRD §7).
- Requires a shared, persistent session store reachable by the Node process (here:
  the same Postgres instance) — a small additional operational dependency, but one
  that piggybacks on infrastructure (Postgres, backups) that already exists.
- Slightly less convenient for horizontal scaling across multiple API processes on
  different hosts (each must reach the same store) — not a concern for the single-VPS
  deployment target (architecture.md §11).

**Neutral / future-facing:**
- Token-based authentication can be added later as an *additional* strategy
  (alongside, not instead of, sessions) without requiring a schema migration on the
  `User` table — e.g., via a separate `ApiToken`/`PersonalAccessToken` model — if a
  genuine need (mobile app, third-party integration) ever materializes.
