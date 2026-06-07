/**
 * Express application factory.
 *
 * Phase 0 scaffolding: wires up the bare minimum (security headers, JSON body parsing,
 * /healthz, and a consistent JSON error shape) so the skeleton boots and is testable.
 * Sessions, RBAC middleware, rate limiting, and feature module routers are added in
 * later phases per plan.md (Phase 2 — Backend Application Skeleton).
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';

import { db, isDbClientAvailable } from './lib/db';
import { AppError } from './lib/errors';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json());

  const router = express.Router();

  /**
   * Liveness/readiness probe per architecture.md §11 — checks DB connectivity.
   * Used by deploy tooling / uptime checks; intentionally unauthenticated and
   * minimal (no sensitive details in the response body).
   */
  router.get('/healthz', async (_req: Request, res: Response) => {
    if (!isDbClientAvailable() || !db) {
      // Expected pre-Phase-1 (no Prisma schema / generated client yet).
      res.status(503).json({
        status: 'degraded',
        db: 'unavailable',
        reason: 'Prisma client not generated yet (schema pending — see Phase 1)',
      });
      return;
    }

    try {
      await db.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/api/v1', router);

  // 404 handler for unmatched routes — consistent error shape.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });

  // Central error handler — translates AppError (and unknown errors) into the
  // consistent `{ error: { code, message, fields? } }` shape from architecture.md §8.
  // Express identifies error-handling middleware by arity (4 args) — `_next` must
  // stay declared even though unused, so it's prefixed to satisfy the lint rule.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
        },
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  return app;
}
