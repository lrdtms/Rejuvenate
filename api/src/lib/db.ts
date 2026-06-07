/**
 * Typed Prisma Client singleton.
 *
 * Phase 0 NOTE: `prisma/schema.prisma` does not exist yet (that's Phase 1 — see
 * plan.md). `@prisma/client` is installed and pinned now (per the dependency-pinning
 * step of Phase 0) but `prisma generate` has nothing to generate from until the schema
 * is written, so importing `@prisma/client` directly here would throw at module-load
 * time on a fresh checkout (`npm ci` -> no generated client -> import error) and break
 * `npm run dev`/`build` before Phase 1 lands.
 *
 * To keep the Phase 0 skeleton runnable end-to-end (so `/healthz` and `npm run dev`
 * work today), we lazily `require` the client and degrade gracefully if it hasn't been
 * generated yet. Once Phase 1 lands a real schema and `prisma generate` has run, this
 * module starts resolving the client normally — no further changes needed here.
 *
 * Standard guidance retained for Phase 1: store the client on `globalThis` outside of
 * production to avoid the well-known "PrismaClient instantiated multiple times during
 * hot-reload exhausts DB connections" problem.
 */
import { env } from '../config/env';

// Minimal structural type so callers can use `db.$queryRaw` etc. without pulling in
// the generated client's full type surface before it exists.
type PrismaClientLike = {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
  $disconnect: () => Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClientLike | undefined;
}

function createClient(): PrismaClientLike | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require('@prisma/client') as {
      PrismaClient: new (...args: unknown[]) => PrismaClientLike;
    };
    return new PrismaClient();
  } catch {
    // No generated client yet (schema not written / `prisma generate` not run).
    // This is expected on a fresh Phase 0 checkout — see note above.
    return undefined;
  }
}

export const db: PrismaClientLike | undefined =
  env.NODE_ENV === 'production' ? createClient() : (globalThis.__prisma ??= createClient());

export const isDbClientAvailable = (): boolean => db !== undefined;
