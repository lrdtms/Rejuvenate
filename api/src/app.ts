/**
 * Express application factory.
 *
 * Phase 2 scaffolding: wires up the cross-cutting global middleware every module
 * relies on (security headers, trust-proxy, CORS, cookie/body parsing, request
 * logging), plus /healthz and the consistent JSON error shape. A generic
 * `rateLimiter()` factory exists (middleware/rateLimit.ts) but is mounted
 * per-route by feature modules, not globally here.
 *
 * Phase 3 additions: Postgres-backed sessions (`express-session` +
 * `connect-pg-simple`, see `modules/auth/session.ts`) are mounted on the
 * `/api/v1` router — deliberately AFTER `/healthz` is registered on it, so the
 * health probe stays reachable without touching the session store (see the
 * inline comment at the session-mounting site for the full reasoning). RBAC
 * middleware and feature module routers are added in subsequent phases per
 * plan.md.
 */
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

import { env } from './config/env';
import { db } from './lib/db';
import { AppError } from './lib/errors';
import { createAuthRouter } from './modules/auth/auth.router';
import { createAuthService } from './modules/auth/auth.service';
import { ConsoleMailService } from './modules/auth/mail.service';
import { createSessionMiddleware, enforceAbsoluteSessionMaxAge } from './modules/auth/session';
import { createBlogRepository } from './modules/blog/blog.repository';
import { createBlogRouter } from './modules/blog/blog.router';
import { createBlogService } from './modules/blog/blog.service';
import { createCmsRepository } from './modules/cms/cms.repository';
import { createCmsRouter } from './modules/cms/cms.router';
import { createCmsService } from './modules/cms/cms.service';
import { createEventRepository } from './modules/events/events.repository';
import { createEventRouter } from './modules/events/events.router';
import { createEventService } from './modules/events/events.service';
import { createMediaRepository } from './modules/media/media.repository';
import { createMediaRouter } from './modules/media/media.router';
import { createMediaService } from './modules/media/media.service';
import { createRegistrationRepository } from './modules/registrations/registrations.repository';
import { createRegistrationRouter } from './modules/registrations/registrations.router';
import { createRegistrationService } from './modules/registrations/registrations.service';

/**
 * Upper bound on how long `/healthz` will wait for `SELECT 1` before treating the
 * dependency as down. Chosen as a middle ground between two failure modes:
 *
 *   - Too short (e.g. a few hundred ms) risks false "degraded" reports under brief,
 *     harmless latency spikes (a slow disk fsync, a momentary connection-pool wait) —
 *     flapping a monitored health check is its own kind of false confidence problem.
 *   - Too long (e.g. 10s+) defeats the entire point of adding a timeout: deploy
 *     tooling and uptime monitors need a bounded answer to act on (architecture.md
 *     §11's `pm2 reload` gate shouldn't itself hang waiting on a health probe).
 *
 * 2.5s comfortably exceeds a healthy `SELECT 1` round trip (sub-millisecond to a
 * few ms on localhost Postgres per architecture.md §11's single-VPS topology) by
 * orders of magnitude, while still being short enough that a genuinely hung
 * connection is reported within a couple of seconds rather than left hanging.
 */
const HEALTHZ_DB_TIMEOUT_MS = 2_500;

/**
 * Rejects after `HEALTHZ_DB_TIMEOUT_MS` — paired with `db.$queryRaw` in a
 * `Promise.race` so a hung DB connection can't block the `/healthz` response
 * indefinitely (see the constant's doc comment for the chosen bound, and the
 * route handler for why this matters). Deliberately rejects with a `never`-typed
 * promise so `Promise.race([db.$queryRaw\`...\`, healthzTimeout().promise])` resolves
 * to the query's result type when the query wins.
 *
 * Returns `{ promise, cancel }` rather than a bare promise: when the query wins
 * the race, the timer is still pending (it'll fire ~2.5s later regardless). The
 * route handler calls `cancel()` in a `finally` so a healthy, frequently-polled
 * endpoint (uptime monitors typically hit `/healthz` every few seconds to a
 * minute) doesn't accumulate one dangling `setTimeout` per request.
 */
function healthzTimeout(): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Healthcheck DB query timed out')),
      HEALTHZ_DB_TIMEOUT_MS,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

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

  // Request logging (pino + pino-http): structured JSON logs of method, path,
  // status code, and duration for every request — chosen over morgan for first-class
  // structured/JSON output (pairs well with PM2/journald log collection on the VPS)
  // and built-in redaction support.
  //
  // Deliberately registered BEFORE cors/cookieParser/express.json(): pino-http
  // attaches `req.log` and starts its request timer on the way in, then emits the
  // access-log line from a `res.on('finish'/'close')` listener — so as long as it's
  // mounted first, every response gets logged regardless of which downstream
  // middleware/handler produced it (including `express.json()` itself rejecting a
  // malformed body with a parse error that lands in the central error handler
  // below). Mounting it any later would mean requests that error out during
  // body-parsing — e.g. a malformed RSVP/login submission — bypass it entirely,
  // leaving zero structured access-log line for exactly the requests most likely to
  // carry sensitive data and most worth auditing.
  //
  // Deliberately NOT logging request/response bodies or headers such as `cookie`/
  // `authorization`: RSVP and login payloads carry personal data (POPIA) and
  // credentials, and logging them wholesale would itself be a compliance violation.
  // `pino-http`'s default request/response serializers only emit method, url,
  // status code, and the standard non-sensitive headers — never `req.body`.
  //
  // `rootLogger` is constructed explicitly (rather than letting `pino-http`
  // build its own internal instance, as the Phase 2 version of this file did)
  // so Phase 3's `AuthService`/`MailService` (and any future module-level
  // service that needs to log) can share the EXACT SAME instance — same
  // level, same redaction config — that `req.log` is derived from, via
  // `pinoHttp({ logger: rootLogger, ... })` below. One logger, one redaction
  // policy, no risk of a second hand-rolled `pino()` instance drifting from
  // the carefully-considered `redact`/`level` settings here (e.g. someone
  // building a service-level logger that forgets to redact `cookie`/
  // `authorization` and accidentally reintroduces the exact POPIA/credential-
  // leak risk this configuration exists to close).
  const rootLogger = pino({
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      remove: true,
    },
  });

  app.use(
    pinoHttp({
      logger: rootLogger,
      // Keep noise down: uptime monitors hit /healthz frequently and its result
      // carries no diagnostic value beyond "DB up/down" (already logged separately
      // by the handler on failure).
      autoLogging: {
        ignore: (req) => req.url === '/api/v1/healthz',
      },
    }),
  );

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

  const router = express.Router();

  /**
   * Liveness/readiness probe per architecture.md §11 — checks DB connectivity.
   * Used by deploy tooling / uptime checks; intentionally unauthenticated and
   * minimal (no sensitive details in the response body).
   *
   * The `SELECT 1` is raced against a short timeout (see `HEALTHZ_DB_TIMEOUT_MS`)
   * so a hung connection — e.g. Postgres accepting the TCP connection but never
   * responding, a saturated connection pool, a network partition that doesn't
   * reset the socket — can't hang this endpoint indefinitely. A `/healthz` that
   * blocks forever is worse than one that fails fast: uptime monitors and deploy
   * tooling (architecture.md §11's `pm2 reload` gate) need a bounded answer to act
   * on, and a hung probe reads identically to "the whole process is wedged" from
   * the outside regardless of which is actually true.
   */
  router.get('/healthz', async (_req: Request, res: Response) => {
    const timeout = healthzTimeout();
    try {
      await Promise.race([db.$queryRaw`SELECT 1`, timeout.promise]);
      res.status(200).json({ status: 'ok', db: 'up' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Healthcheck DB query failed:', err);
      res.status(503).json({ status: 'degraded', db: 'down' });
    } finally {
      // Whichever side of the race settled first, the other is now moot — clear
      // the timer so it doesn't fire ~2.5s later for no reason (see `healthzTimeout`).
      timeout.cancel();
    }
  });

  // ---------------------------------------------------------------------------
  // Sessions (ADR-0002 / plan.md Phase 3 step 1) — mounted on the ROUTER, not
  // globally on `app`, and AFTER `/healthz` is registered above.
  //
  // Why this matters: `/healthz` (architecture.md §11 — the external uptime
  // monitor's liveness/readiness probe) must stay reachable WITHOUT a session —
  // per plan.md Phase 2 step 5, "Mount [healthz] *before* the auth/session
  // middleware so an external monitor doesn't need credentials and a DB outage
  // doesn't also break session-store lookups for the health check itself." A
  // session-store lookup is itself a Postgres query (connect-pg-simple reads/
  // writes the `session` table) — routing the health probe through it would
  // mean a DB outage breaks BOTH the thing being checked and the check itself,
  // and would needlessly couple an unauthenticated monitoring endpoint to the
  // session store's availability/latency.
  //
  // Express evaluates middleware/routes attached to the SAME router object in
  // REGISTRATION order: a request matching an earlier-registered layer that
  // sends a response (as `/healthz`'s handler does — it never calls `next()`)
  // never reaches later-registered layers on that router, including
  // `router.use(...)` calls below. Registering the session middleware as
  // `router.use(...)` AFTER `router.get('/healthz', ...)` therefore guarantees
  // `/healthz` requests never touch `express-session`/`connect-pg-simple` at
  // all — while every OTHER route on this router (mounted below, including
  // `mountForTesting` probes and all future feature-module routers) gets
  // `req.session`/`req.sessionID` populated, all without changing `/healthz`'s
  // final mount path (`/api/v1/healthz` — unchanged, as required).
  //
  // A global `app.use(session(...))` mounted before `app.use('/api/v1', router)`
  // would NOT achieve this: Express would run it for every `/api/v1/*` request
  // — including `/healthz` — regardless of where `/healthz` is later attached
  // to `router`, because global middleware runs in registration order
  // independent of which router eventually handles the request.
  router.use(createSessionMiddleware());
  // Enforces the absolute session-lifetime ceiling that `express-session` has
  // no native concept of — must run immediately after the session middleware
  // populates `req.session` (see `modules/auth/session.ts` for the full
  // rolling-vs-absolute rationale and chosen TTL values).
  router.use(enforceAbsoluteSessionMaxAge());

  // ---------------------------------------------------------------------------
  // Auth module (plan.md Phase 3 steps 3-4) — mounted AFTER sessions, since
  // every route it exposes (`/auth/login`, `/auth/logout`, `/me`,
  // `/auth/password-reset/*`) reads or writes `req.session`. `app.ts` is the
  // composition root: it constructs the shared `AuthService` (wiring in the
  // shared Prisma client, a `ConsoleMailService` — see that file's header for
  // why this is the only `MailService` implementation that exists today and
  // the open question blocking a real one — and a child logger) and hands it
  // to `createAuthRouter`, mirroring the `mountForTesting` seam's "inject
  // dependencies, don't reach for module-level singletons" posture so the
  // whole chain stays substitutable in tests.
  const authService = createAuthService({
    db,
    mailService: new ConsoleMailService(rootLogger),
    logger: rootLogger,
  });
  router.use(createAuthRouter({ authService }));

  // ---------------------------------------------------------------------------
  // Blog module (plan.md Phase 4a) — mounted AFTER sessions/auth, since its
  // `/admin/blog/*` routes are gated by `requireRole(authService, ...)`
  // (reads `req.session` via the shared `loadAuthenticatedUser` primitive —
  // see `middleware/rbac.ts`) and its public `/blog/posts*` routes need no
  // session at all but are harmless to mount alongside. `app.ts` remains the
  // composition root: it constructs the repository -> service chain (wiring
  // in the shared Prisma client) and hands the assembled `BlogService`
  // (alongside the already-constructed `authService`, for the router's
  // `requireRole`/`requireAuth` gates) to `createBlogRouter` — mirroring the
  // exact "inject dependencies, don't reach for module-level singletons"
  // posture the auth module established.
  // ---------------------------------------------------------------------------
  // Media repository constructed early — it is injected into BlogService and
  // EventService so their `deletePost`/`deleteEvent` methods can cascade-delete
  // associated MediaAsset rows and on-disk files (ADR-0005 application-layer
  // cascade; no DB-level FK exists). The mediaService is fully wired below once
  // blogRepository and eventRepository are available.
  const mediaRepository = createMediaRepository({ db });

  const blogRepository = createBlogRepository({ db });
  const eventRepository = createEventRepository({ db });

  // MediaService is constructed after both blog and event repositories exist
  // so it can hold references to them for the ownerId existence+ownership check.
  const mediaService = createMediaService({
    repository: mediaRepository,
    blogRepository,
    eventRepository,
  });

  const blogService = createBlogService({ repository: blogRepository, mediaService });
  router.use(createBlogRouter({ authService, blogService }));

  // ---------------------------------------------------------------------------
  // Events module (plan.md Phase 4b) — mounted AFTER Blog, in the same
  // dependency-ordered sequence plan.md Phase 4's intro names ("Blog needs
  // only User; Events needs User"). Same composition-root posture as Blog:
  // construct the repository -> service chain (wiring in the shared Prisma
  // client) and hand the assembled `EventService` (alongside `authService`,
  // for `requireRole`/`requireAuth` gates) to `createEventRouter`. The
  // constructed `eventService` is ALSO the home of the capacity-check
  // primitive (`tryRegisterWithCapacityCheck` — see
  // `modules/events/events.service.ts`'s extensive doc-comment) that Phase
  // 4c's `RegistrationService` will receive via the identical DI pattern
  // once that module exists.
  const eventService = createEventService({ repository: eventRepository, mediaService });
  router.use(createEventRouter({ authService, eventService }));

  // ---------------------------------------------------------------------------
  // Registrations module (plan.md Phase 4c) — mounted AFTER Events, the module
  // it depends on (the public RSVP route resolves eligibility through
  // `EventService.getPublishedBySlug` and the race-safe capacity guarantee
  // through `EventService.tryRegisterWithCapacityCheck` — see
  // `modules/registrations/registrations.service.ts`'s file-header "THE CALL
  // CHAIN" note for the full call graph this module relies on, built and
  // exhaustively concurrency-tested in Phase 4b specifically so this module
  // could call straight into it). Same composition-root posture as every
  // other module: construct the repository -> service chain (wiring in the
  // shared Prisma client, the already-constructed `eventService`, and
  // `rootLogger` for the export-audit log entries — see that service's
  // `exportForEvent` doc-comment for the "structured pino logging vs.
  // AuditLog table" decision record) and hand the assembled
  // `RegistrationService` (alongside `authService`, for `requireRole` gates)
  // to `createRegistrationRouter`.
  // ---------------------------------------------------------------------------
  const registrationRepository = createRegistrationRepository({ db });
  const registrationService = createRegistrationService({
    eventService,
    repository: registrationRepository,
    logger: rootLogger,
  });
  router.use(createRegistrationRouter({ authService, registrationService }));

  // ---------------------------------------------------------------------------
  // CMS module (plan.md Phase 4d) — depends only on `User` (for
  // `lastEditedBy` attribution), so it has no ordering dependency on
  // Blog/Events/Registrations beyond "mount after sessions/auth exist" (its
  // `/admin/cms/*` routes are gated by `requireRole(authService, 'ADMIN')`,
  // which reads `req.session` via the shared `loadAuthenticatedUser`
  // primitive — see `middleware/rbac.ts`). Mounted last among the content
  // modules purely as a matter of this file's narrative ordering (Blog ->
  // Events -> Registrations -> CMS mirrors plan.md Phase 4's own a/b/c/d
  // lettering); Express route resolution is registration-order-sensitive
  // only for OVERLAPPING paths, and `/cms*`/`/admin/cms/*` overlap with
  // nothing any earlier module registers. Same composition-root posture as
  // every other module: construct the repository -> service chain (wiring
  // in the shared Prisma client) and hand the assembled `CmsService`
  // (alongside `authService`, for the `requireRole(authService, 'ADMIN')`
  // gate — see `cms.router.ts`'s "why ADMIN-only, no ownership check" note)
  // to `createCmsRouter`.
  // ---------------------------------------------------------------------------
  const cmsRepository = createCmsRepository({ db });
  const cmsService = createCmsService({ repository: cmsRepository });
  router.use(createCmsRouter({ authService, cmsService }));

  // ---------------------------------------------------------------------------
  // Media module (plan.md Phase 4e) — depends on Blog + Events (as owner types
  // for the ownerId existence+ownership check — see ADR-0005 and the Media
  // module's file-header). Mounted after Blog/Events/Registrations/CMS because
  // its `mediaService` is already constructed above (injected into blogService
  // and eventService for cascade-delete). The router is the final wiring step:
  // all three routes (`POST`, `GET`, `DELETE /admin/media`) are gated by
  // `requireRole(authService, 'ADMIN', 'BLOGGER', 'EVENT_MANAGER')` at the
  // route level; per-content-area scoping is enforced in the service layer (see
  // `media.service.ts`'s `checkOwnerAccess` and `media.router.ts`'s file-header
  // "why not gate by ownerType at the router level" note).
  // ---------------------------------------------------------------------------
  router.use(createMediaRouter({ authService, mediaService }));

  // Test-only seam (see `CreateAppOptions` doc comment above) — registered before
  // the catch-all 404 handler so probe routes are actually reachable. Runs AFTER
  // the session middleware above, so probe routes correctly observe
  // `req.session`/`req.sessionID` like any real authenticated route would.
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
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
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

    // Log via the per-request pino logger (attached by `pinoHttp`, mounted ahead of
    // every other middleware — see the comment at its registration site) rather than
    // raw `console.error(err)`. This matters beyond consistency: body-parser raises
    // plain `SyntaxError`s for malformed JSON with the *raw, unredacted request body*
    // attached as `err.body` (e.g. `{ body: '{not valid json', type:
    // 'entity.parse.failed', ... }`). Dumping that error object wholesale to stdout —
    // exactly what `console.error('Unhandled error:', err)` did — would print
    // whatever the client sent verbatim, completely bypassing the
    // `redact: { paths: [...], remove: true }` pipeline this commit established and
    // leaking personal data/credential fragments from a malformed RSVP/login
    // submission straight into the logs (a POPIA violation). Logging only
    // `err.name`/`err.message` (never the error object itself, never `err.body`)
    // keeps the "what broke" diagnostic value without the body ever reaching stdout.
    const safeError =
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: 'UnknownError', message: String(err) };
    req.log.error({ err: safeError }, 'Unhandled error');

    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  return app;
}
