# Rejuvenate — Web (SPA)

React + TypeScript single-page application, built with Vite. See `architecture.md`
§10 and `plan.md` at the repo root for the authoritative frontend architecture
and structure.

## Stack

- React + TypeScript (Vite, static build — no SSR, see ADR-0003)
- TanStack React Query for server-state caching/invalidation (admin area)
- React Hook Form + Zod resolvers for all forms
- React Router (public route tree + authenticated/role-gated `/admin/*` tree)
- Thin typed `fetch` API client aligned to the backend's `/api/v1/*` contract

## Getting started

```bash
npm install
cp .env.example .env   # set VITE_API_BASE_URL to point at the local api (see api/.env.example)
npm run dev
```

Requires Node.js 22.x LTS (see root `.nvmrc`).

## Scripts

| Script             | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `npm run dev`      | Start the Vite dev server (HMR)          |
| `npm run build`    | Type-check (`tsc -b`) and produce a static production build in `dist/` |
| `npm run preview`  | Preview the production build locally     |
| `npm run typecheck`| Type-check only, no emit                 |
| `npm run lint`     | ESLint (flat config, typescript-eslint + react-hooks + react-refresh) |
| `npm run lint:fix` | ESLint with `--fix`                      |
| `npm run format`   | Prettier — write                          |
| `npm run format:check` | Prettier — check only                |

## Project structure (architecture.md §10.1)

```
src/
  app/                — routing, providers, layout shells
  design-system/      — Header, Nav, Footer, Card, PageHero, Button
                        (ported 1:1 from the root styles.css — branding lives in code)
  public/pages/       — Home, About, CapeTown, Durban, Contact, Blog, Events (public route tree, no auth)
  admin/pages/        — Login, Dashboard, Blog, Events, Cms, Users (authenticated, role-gated /admin/* tree)
  admin/components/   — RequireAuth, RoleGuard
  shared/             — api client, hooks, utils, types
```

## Notes

- **Branding/layout/nav are code-controlled** — ported 1:1 from the existing static
  site (`index.html`, `about.html`, `styles.css`, etc. at the repo root), never
  redesigned and never CMS-editable (architecture.md §10.3, §9.5).
- **Auth uses HttpOnly session cookies** — requests are sent with credentials;
  no token is read from or written to JS-accessible storage (architecture.md §10.2, ADR-0002).
- **Client-side `RequireAuth`/`RoleGuard` are a UX convenience only** — the API
  independently re-checks authorization on every request (defense in depth).
- **The RSVP form is POPIA-sensitive** — collects only first name, surname, age,
  email, phone; displays a versioned consent notice before submission; validates
  every field client-side (mirroring, not replacing, server-side validation).
