# Codebase map — where payments plugs in

Absolute paths and verbatim conventions for wiring the payments module into the
Rejuvenate app. Read this before touching files so the integration matches existing
patterns exactly.

## Backend (`api/`)

| Purpose | Path |
|---|---|
| Prisma schema | `api/prisma/schema.prisma` |
| Migrations dir | `api/prisma/migrations/` |
| Config / env validation | `api/src/config/env.ts` |
| Env example | `api/.env.example` |
| App composition root | `api/src/app.ts` |
| Server entrypoint | `api/src/server.ts` |
| RBAC middleware | `api/src/middleware/rbac.ts` |
| Request validation | `api/src/middleware/validate.ts` |
| Rate limiting | `api/src/middleware/rateLimit.ts` |
| Error constructors | `api/src/lib/errors.ts` |
| Pagination helper | `api/src/lib/pagination.ts` |
| Events module (template to mirror) | `api/src/modules/events/` |
| Registrations module | `api/src/modules/registrations/` |
| **One schema to relax** (dormant fields) | `api/src/modules/events/events.schemas.ts` |

### Module shape (mirror `events/`)

A module is a folder under `api/src/modules/<name>/` containing:
`<name>.router.ts`, `<name>.service.ts`, `<name>.repository.ts`, `<name>.schemas.ts`,
`<name>.constants.ts`. Services and repositories are **factory functions** that
receive their dependencies, e.g. `createEventService({ repository, mediaService })`.
The router is a factory too: `createEventRouter({ authService, eventService, ... })`.

### Routing conventions

- Public: `GET /api/v1/events`, `GET /api/v1/events/:slug`
- Public write (rate-limited): `POST /api/v1/events/:slug/registrations`
- Admin: `GET|POST|PATCH|DELETE /api/v1/admin/events...` guarded by `requireRole`

For payments add (see SKILL.md checklist): `POST /api/v1/events/:slug/orders`,
`GET /api/v1/orders/:reference`, `POST /api/v1/webhooks/paystack`,
`POST /api/v1/webhooks/ozow`, `GET /api/v1/admin/events/:id/orders`.

### Public write route pattern (rate limit + validation), from registrations.router.ts

```ts
router.post(
  '/events/:slug/registrations',
  rateLimiter({
    ...RSVP_RATE_LIMIT,
    message: 'Too many registration attempts from this connection — please try again later',
  }),
  validate({ params: eventSlugParamSchema, body: createRegistrationSchema }),
  (req, res, next) => {
    registrationService
      .registerAttendee(req.params.slug, req.body)
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);
```

### Admin route pattern (RBAC), from registrations.router.ts

```ts
router.get(
  '/admin/events/:id/registrations',
  requireRegistrationStaff, // = requireRole(authService, 'ADMIN', 'EVENT_MANAGER')
  validate({ params: eventIdParamSchema, query: listRegistrationsQuerySchema }),
  (req, res, next) => { /* ... */ },
);
```

### RBAC middleware, from middleware/rbac.ts

```ts
export function requireRole(authService: AuthService, ...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    loadAuthenticatedUser(req, authService)
      .then((user) => {
        if (!user) return next(unauthorized());
        if (!roles.includes(user.role)) return next(forbidden());
        req.user = user;
        next();
      })
      .catch(next);
  };
}
```

Webhook routes get **no** `requireRole`/`requireAuth` — they are authenticated by
provider signature/hash, not session cookies.

### Env pattern, from config/env.ts

```ts
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be set to a long random value'),
  CORS_ALLOWED_ORIGIN: z.string().url('CORS_ALLOWED_ORIGIN must be a valid origin URL'),
  // ...SMTP, UPLOADS_DIR...
});
export type Env = z.infer<typeof envSchema>;
export const env = loadEnv();
```

Add payment vars here following the same style (keep them `.optional().default('')`
so dev/test boots without them; the adapters should throw a clear error if invoked
without their keys set):

```ts
PAYSTACK_SECRET_KEY: z.string().optional().default(''),
PAYSTACK_PUBLIC_KEY: z.string().optional().default(''),
OZOW_SITE_CODE:      z.string().optional().default(''),
OZOW_API_KEY:        z.string().optional().default(''),
OZOW_PRIVATE_KEY:    z.string().optional().default(''),
OZOW_IS_TEST: z.enum(['true', 'false']).optional().default('true')
  .transform((v) => v === 'true'),
PAYMENTS_BASE_URL:   z.string().url().optional().default(''), // public origin for return/notify URLs
```

### Validation middleware, from middleware/validate.ts

`validate({ body, params, query })` runs each Zod schema, merges field errors into a
`{ field: [messages] }` shape, and on failure calls `next(validationError(fields))`.
On success it **replaces** `req.body/params/query` with the parsed result. Mirror each
request schema by hand into `web/src/shared/schemas/` (project convention).

### App composition root, from app.ts

- `express.json()` is applied globally (currently **without** a `verify` hook — add one
  for raw body; see SKILL.md "Raw-body gotcha").
- Routers are mounted via `app.use('/api/v1', router)`.
- Central error handler renders `{ error: { code, message, fields? } }`.
- Wire payments like the others:
  ```ts
  const paymentRepository = createPaymentRepository({ db });
  const paymentService = createPaymentService({
    repository: paymentRepository,
    eventService,
    logger: rootLogger,
  });
  router.use(createPaymentRouter({ authService, paymentService }));
  ```

## Frontend (`web/`)

| Purpose | Path |
|---|---|
| Typed API client (`apiFetch`, `isApiError`) | `web/src/shared/api/client.ts` |
| RSVP form (mutation pattern to mirror) | `web/src/public/pages/Events/RsvpForm/RsvpForm.tsx` |
| RSVP zod schema (mirror convention) | `web/src/shared/schemas/rsvp.schema.ts` |
| Public event detail | `web/src/public/pages/Events/EventDetail/EventDetailPage.tsx` |
| Public events list | `web/src/public/pages/Events/EventsIndex/EventsPage.tsx` |
| Admin event editor (expose price here) | `web/src/admin/pages/Events/EventEditor/EventEditor.tsx` |
| Event hooks | `web/src/shared/hooks/useEvent.ts`, `useEvents.ts` |
| Event types | `web/src/shared/types/events.ts` |

### API client usage, from client.ts + RsvpForm.tsx

```ts
const mutation = useMutation<OrderResponse, unknown, CheckoutInput>({
  mutationFn: (values) =>
    apiFetch<OrderResponse>(`/api/v1/events/${encodeURIComponent(slug)}/orders`, {
      method: 'POST',
      body: JSON.stringify(values),
    }),
  onSuccess: (order) => { window.location.assign(order.redirectUrl); },
  onError: (err) => {
    if (isApiError(err) && err.status === 400 && err.body.code === 'VALIDATION_ERROR') {
      // map err.body.fields onto form fields
    }
  },
});
```

`apiFetch` sends `credentials: 'include'` and `Content-Type: application/json`, returns
parsed JSON, and throws `ApiError` with `{ status, body: { code, message, fields? } }`.

## Existing Event / Registration models (api/prisma/schema.prisma)

```prisma
model Event {
  id String @id @default(uuid())
  title String
  slug  String @unique
  // ...
  isPaid     Boolean @default(false) // DORMANT (ADR-0006) — activate for paid tickets
  priceCents Int?                    // DORMANT — ZAR cents
  status EventStatus @default(DRAFT)
  registrations Registration[]
  @@map("events")
}

model Registration {
  id        String @id @default(uuid())
  eventId   String
  event     Event  @relation(fields: [eventId], references: [id], onDelete: Restrict)
  firstName String
  surname   String
  age       Int
  email     String
  phone     String
  consentVersion String
  retainUntil    DateTime?
  registeredAt   DateTime @default(now())
  @@index([eventId])
  @@map("registrations")
}
```

Enums present: `Role { ADMIN BLOGGER EVENT_MANAGER }`,
`EventStatus { DRAFT PUBLISHED CANCELLED }`, `Branch { CAPE_TOWN DURBAN OTHER }`.
Registrations are currently anonymous (no User FK) by design.
