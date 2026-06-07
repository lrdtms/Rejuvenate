/**
 * Typed Prisma Client singleton.
 *
 * Exports a single, fully-typed `PrismaClient` instance (`db`) for the whole API to
 * share — `db.user`, `db.blogPost`, `db.$transaction`, `db.$queryRaw`, etc. The schema
 * lives at `prisma/schema.prisma`; the client is (re)generated via `prisma generate`,
 * which runs as part of `npm run build` / `npm run prisma:generate` (see package.json),
 * so the generated types are always available when this module is imported.
 *
 * Singleton + hot-reload guard: in development, `tsx watch` reloads modules on every
 * file change. Without care, each reload would construct a brand-new `PrismaClient`
 * (and its own connection pool), and the old instances are never disposed — quickly
 * exhausting Postgres's connection limit. The standard fix (per Prisma's own guidance)
 * is to stash the instance on `globalThis`, which survives module reloads, and reuse it
 * if present. In production there is no hot-reloading, so we always construct fresh.
 */
import { PrismaClient } from '@prisma/client';

import { env } from '../config/env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const db: PrismaClient =
  env.NODE_ENV === 'production' ? new PrismaClient() : (globalThis.__prisma ??= new PrismaClient());
