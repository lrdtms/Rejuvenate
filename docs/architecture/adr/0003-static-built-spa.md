# ADR-0003: Static-Built React SPA over Server-Side Rendering

## Status

Accepted

## Context

The frontend needs two route trees: a public, unauthenticated site (Home, About, Cape
Town, Durban, Contact, Blog, Events) and an authenticated, role-gated admin backend.
The public site is content-driven (a community blog/events site) but is not an
SEO-extreme context such as an e-commerce storefront competing on organic search and
rich social previews at scale.

The deployment target is a single self-managed Linode VPS (architecture.md §11),
where every additional long-running process is an additional thing to provision,
supervise, secure, patch, and monitor. Operational simplicity and cost are explicit
drivers (Conway's Law / solo-operator constraints, architecture.md §3).

Two broad approaches were considered:
1. A React application server-rendered at request time (e.g., a Next.js/Remix Node
   server), giving strong SEO/social-preview metadata out of the box at the cost of
   running and securing an additional Node runtime.
2. A React SPA built once to static assets (e.g., via Vite) and served as plain files
   by the existing reverse proxy (Nginx), with all dynamic data fetched client-side
   from the REST API.

## Decision

Build the React frontend as a **static-built SPA** (Vite), deployed as static assets
served by Nginx — **no Node SSR runtime** (no Next.js server process, no Remix
server). The API remains a separate, single Express process (ADR-0001) that the SPA
talks to over `/api/*`.

## Consequences

**Positive:**
- Simpler deployment: the entire frontend is a directory of static files copied into
  place by the deploy script — no additional process to supervise (PM2/systemd unit),
  no additional port, no additional runtime to patch/secure.
- Smaller attack surface: static files served by Nginx carry far less exposed
  surface area than a Node SSR server handling arbitrary request-time rendering.
- Cheaper to operate: one fewer long-running Node process on a resource-constrained
  single VPS.
- Clean separation of concerns: the SPA is "just" a REST API consumer, matching the
  modular-monolith API's REST-over-JSON design (ADR-0001).

**Negative / tradeoffs:**
- Weaker out-of-the-box SEO and social-preview metadata for content pages (blog post
  detail pages, event detail pages) compared to SSR, since crawlers and link-preview
  bots may not execute client-side JavaScript. This is a known, accepted limitation
  for v1 — mitigated, if it becomes a real problem, by a lightweight build-time
  prerender step or static `<head>` meta-tag injection per route (e.g., generating
  static HTML shells with correct `<title>`/`<meta property="og:*">` tags for known
  blog/event slugs at build or publish time), without requiring a full SSR runtime.

**Neutral / future-facing:**
- Revisit this decision if organic search traffic to blog/event pages becomes a
  measured business priority — at that point, a build-time prerender step is the
  first escalation, with a full SSR migration as a last resort given the operational
  cost it would reintroduce.
