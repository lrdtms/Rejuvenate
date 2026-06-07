/**
 * Express application factory.
 *
 * Phase 2 scaffolding: wires up the cross-cutting global middleware every module
 * relies on (security headers, trust-proxy, CORS, cookie/body parsing, request
 * logging), plus /healthz and the consistent JSON error shape. Sessions, RBAC
 * middleware, rate limiting, and feature module routers are added in later phases
 * per plan.md (Phase 2 — Backend Application Skeleton).
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env } from './config/env';
import { db } from './lib/db';
import { AppError } from './lib/errors';

/**
 * Optional hook for mounting additional routers under `/api/v1` ahead of the
 * catch-all 404/error handlers. Production code never passes this — `server.ts`
 * calls `createApp()` with no arguments. It exists solely so integration tests can
 * register throwaway probe routes (e.g. to assert `req.cookies`/`req.log` are
 * populated by the global middleware) without reaching into `createApp`'s closure
 * or duplicating its middleware stack in a parallel test-only app.
 */
export interface CreateAppOptions {
  mountForTesting?: (router: express.Router) => void;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());

  // Required for correct behaviour behind the Nginx reverse proxy described in
  // architecture.md §11: without this, `express-rate-limit` and `express-session`'s
  // `secure`-cookie detection see the proxy's loopback connection (not the real
  // client), so IP-based rate limiting and "only set Secure cookies over HTTPS"
  // checks silently misbehave in production while appearing to work locally.
  // `1` trusts exactly one hop (the Nginx proxy) — see plan.md Phase 2 review note.
  app.set('trust proxy', 1);

  // Credentialed CORS: server-side sessions live in cookies (ADR-0002), so the
  // browser must be told both `Access-Control-Allow-Credentials: true` AND an
  // explicit allow-listed origin — `origin: '*'` is rejected by browsers when
  // credentials are involved, and would be unsafe even if it weren't. Exactly one
  // SPA origin is expected per environment (the Vite dev server locally, the
  // deployed SPA in prod), sourced from env so it never needs a code change to
  // deploy to a new host.
  app.use(
    cors({
      origin: env.CORS_ALLOWED_ORIGIN,
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json());

  // Request logging (pino + pino-http): structured JSON logs of method, path,
  // status code, and duration for every request — chosen over morgan for first-class
  // structured/JSON output (pairs well with PM2/journald log collection on the VPS)
  // and built-in redaction support.
  //
  // Deliberately NOT logging request/response bodies or headers such as `cookie`/
  // `authorization`: RSVP and login payloads carry personal data (POPIA) and
  // credentials, and logging them wholesale would itself be a compliance violation.
  // `pino-http`'s default request/response serializers only emit method, url,
  // status code, and the standard non-sensitive headers — never `req.body`.
  app.use(
    pinoHttp({
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      // Keep noise down: uptime monitors hit /healthz frequently and its result
      // carries no diagnostic value beyond "DB up/down" (already logged separately
      // by the handler on failure).
      autoLogging: {
        ignore: (req) => req.url === '/api/v1/healthz',
      },
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
        remove: true,
      },
    }),
  );

  const router = express.Router();

  /**
   * Liveness/readiness probe per architecture.md §11 — checks DB connectivity.
   * Used by deploy tooling / uptime checks; intentionally unauthenticated and
   * minimal (no sensitive details in the response body).
   */
  router.get('/healthz', async (_req: Request, res: Response) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ok', db: 'up' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Healthcheck DB query failed:', err);
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // Test-only seam (see `CreateAppOptions` doc comment above) — registered before
  // the catch-all 404 handler so probe routes are actually reachable.
  options.mountForTesting?.(router);

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
