---
name: rejuvenate-payments
description: >-
  Implementation guide for adding paid event ticket sales to the Rejuvenate app
  using Ozow (instant EFT) and Paystack (cards) as ZAR payment gateways. Use this
  skill WHENEVER the work touches event ticket payments, checkout, the
  Ozow/Paystack gateways, payment webhooks/redirects, orders, the dormant
  isPaid/priceCents Event fields (ADR-0006), or activating paid ticketing — even
  if the user just says "let people pay for tickets", "add a checkout", "wire up
  the payment gateway", or names only one provider. It encodes this project's
  exact module/file conventions, the data model, the end-to-end payment flow, and
  the security-critical webhook/verification details so the integration is built
  correctly the first time.
---

# Rejuvenate — Paid Ticketing (Ozow + Paystack)

This skill turns "let people buy event tickets" into a concrete, project-aligned
implementation. It exists because payment integrations are easy to get *subtly,
dangerously* wrong (trusting client-sent amounts, skipping webhook signature
checks, double-fulfilling on duplicate webhooks). Follow it so those traps are
closed by construction.

## Product decisions (locked with stakeholder)

These were confirmed up front — build to them; don't re-derive:

1. **Both providers** offered at checkout. Buyer chooses **Ozow** (instant EFT) or
   **Paystack** (cards). Build the two as interchangeable adapters behind one flow.
2. **One price per event** (`Event.priceCents`), but a buyer may purchase **multiple
   tickets** (a `quantity`). Order total = `priceCents × quantity`.
3. **Collect every attendee's details.** For `quantity > 1`, the checkout collects the
   full name/age/email/phone for **each ticket** — create one fully-populated
   `Registration` per ticket, not a single buyer record. The payer's details live on
   the `Order`; each attendee's details live on their own `Registration`.
4. **Free and paid events coexist.** `isPaid === false` events keep the *existing*
   free RSVP flow untouched — no payment, no order. Only `isPaid === true` events
   route through checkout.
5. **Currency: ZAR**, always. Money is stored and computed in **integer cents**
   (never floats) — matches `priceCents` and both gateways' conventions.
6. **Refunds/cancellations: out of scope for v1.** See the "Future work" section —
   document the hook points, build nothing.

## Critical context: this is the activation of ADR-0006

Read `docs/architecture/adr/0006-forward-compatible-paid-ticketing-fields.md`
before writing code. Key consequences for how you build:

- `Event` already has the dormant `isPaid` (bool, default false) and `priceCents`
  (nullable int, ZAR cents) columns. **Do not add a destructive Event migration** —
  these columns already exist. You only add *new* tables (`Order`, `PaymentEvent`)
  and a *new* payments module alongside the existing `Event` module. This is the
  Open/Closed approach the ADR mandates.
- There is exactly **ONE existing schema to relax** to let admins set real prices:
  the `dormantPaidFieldsShape` `.refine()`s in
  `api/src/modules/events/events.schemas.ts` (they currently 400 any `isPaid: true`
  or non-null `priceCents`). Relax them carefully — see the implementation checklist.
- If a legacy **Quicket** placeholder still exists anywhere, ADR-0006 recommends
  removing it rather than carrying dead code. Check and flag.

## How this project is built (match these conventions exactly)

The full reconnaissance of file paths and patterns lives in
`references/codebase-map.md` — read it; it has verbatim snippets and absolute paths.
The essentials:

- **Backend module shape** (mirror the `events` module): a folder under
  `api/src/modules/payments/` with `payments.router.ts`, `payments.service.ts`,
  `payments.repository.ts`, `payments.schemas.ts`, `payments.constants.ts`. Services
  and repositories are **factory functions** (`createPaymentService({...})`) wired in
  the composition root `api/src/app.ts`.
- **Routing**: mount on `/api/v1`. Public routes are open (rate-limited); admin
  routes use `requireRole(authService, 'ADMIN', 'EVENT_MANAGER')` from
  `api/src/middleware/rbac.ts`; **webhook routes use NO auth** (verified by signature
  instead — see below).
- **Validation**: Zod schemas consumed via `validate({ body/params/query })`
  (`api/src/middleware/validate.ts`). Mirror request schemas into the SPA at
  `web/src/shared/schemas/` per the project's "duplicated per module, mirrored by
  hand" convention.
- **Config/env**: add new vars to the Zod `envSchema` in `api/src/config/env.ts`
  (pattern: `z.string().optional().default('')`) and document them in
  `api/.env.example`. Never hardcode keys; never commit them.
- **Errors**: throw the constructors from `api/src/lib/errors.ts`
  (`badRequest`, `conflict`, `notFound`, …); the central handler renders
  `{ error: { code, message, fields? } }`.
- **Rate limiting**: reuse the `rateLimiter` pattern (see RSVP's `RSVP_RATE_LIMIT`)
  for the public "create order" endpoint.
- **Frontend**: call the API through the typed `apiFetch` wrapper in
  `web/src/shared/api/client.ts`; data fetching/mutations via React Query
  (`useMutation`/`useQuery`); forms via React Hook Form + Zod. Checkout UI hooks into
  the events pages under `web/src/public/pages/Events/`.

## Data model to add

Add to `api/prisma/schema.prisma` (new tables only):

```prisma
enum PaymentProvider { OZOW PAYSTACK }

enum OrderStatus {
  PENDING    // created, awaiting payment
  PAID       // verified settled — fulfilled
  FAILED     // provider reported failure/abandoned
  CANCELLED  // buyer cancelled at gateway
  EXPIRED    // never completed in time
}

model Order {
  id        String  @id @default(uuid())
  eventId   String
  event     Event   @relation(fields: [eventId], references: [id], onDelete: Restrict)

  // Payer (the person paying — may also be one of the attendees).
  // POPIA: personal data — treat per the project's existing retention/consent rules.
  payerFirstName String
  payerSurname   String
  payerEmail     String
  payerPhone     String

  quantity       Int     // tickets in this order (>= 1) — must equal attendees count
  unitPriceCents Int     // SNAPSHOT of event.priceCents at purchase time
  amountCents    Int     // quantity * unitPriceCents — the authoritative total
  currency       String  @default("ZAR")

  provider          PaymentProvider
  status            OrderStatus @default(PENDING)
  reference         String      @unique   // OUR ref; sent to the gateway
  providerReference String?               // gateway's transaction id, once known
  paidAt            DateTime?

  registrations Registration[] // one per attendee, created on successful payment
  events        PaymentEvent[] // webhook/verify audit trail

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([eventId, status])
  @@map("orders")
}

// Append-only audit + idempotency log of every webhook/verify we process.
model PaymentEvent {
  id         String          @id @default(uuid())
  orderId    String
  order      Order           @relation(fields: [orderId], references: [id], onDelete: Cascade)
  provider   PaymentProvider
  rawStatus  String          // provider's status string as received
  verified   Boolean         // did signature/hash verification pass?
  payload    Json            // raw provider payload, for debugging/audit
  createdAt  DateTime @default(now())

  @@index([orderId])
  @@map("payment_events")
}
```

Then add a **nullable** FK to `Registration` so paid tickets link to their order
while free RSVPs keep working unchanged:

```prisma
// in model Registration
orderId String?
order   Order?  @relation(fields: [orderId], references: [id], onDelete: SetNull)
```

Adding a *nullable* column / optional relation is the low-risk, additive migration
ADR-0006 explicitly endorses — it does not change the meaning of existing rows.

**Why these shapes:**
- One `Registration` **per attendee** carries each ticket-holder's full details (the
  locked decision). `Order.quantity` must equal the number of attendees submitted, and
  the service creates exactly that many `Registration` rows on payment success.
- `unitPriceCents` is snapshotted so a later admin price change never rewrites the
  total an already-placed order was charged.
- `amountCents` is the single source of truth you reconcile the gateway against —
  **never** trust an amount sent back by the browser.
- `reference` is unique and generated by us; it ties the redirect, the webhook, and
  the verify call together and is the basis for idempotency.
- `PaymentEvent` gives you an auditable, replay-safe record (POPIA accountability +
  debugging) and a place to notice duplicate webhooks.

## The payment flow (end to end)

This is the spine. Both providers follow it; only the adapter steps differ.

1. **Buyer fills checkout** on a paid event page → submits payer details, an
   **attendees array** (one full detail set per ticket), and the chosen provider to
   `POST /api/v1/events/:slug/orders`.
2. **Server creates a PENDING order.** Validate `attendees.length === quantity`.
   Recompute `unitPriceCents` from the *event row* (not the request), compute
   `amountCents = unitPriceCents × quantity`, generate a unique `reference`. Reject if
   the event isn't `isPaid`/`PUBLISHED`, or capacity would be exceeded. Stash the
   attendee details so they can be turned into `Registration` rows on success (persist
   them with the pending order, or in a holding field).
3. **Server initialises the gateway transaction** (provider adapter) and gets back a
   redirect URL. **Amount sent to the gateway is the server-computed `amountCents`.**
4. **Redirect the buyer** to the gateway's hosted page (return the URL; the SPA
   navigates there).
5. **Buyer pays** on Ozow/Paystack's page and is redirected back to our
   success/cancel/error URL (display-only — never fulfil based on the redirect alone).
6. **Gateway calls our webhook** (server-to-server). This is the **authoritative**
   fulfilment trigger:
   - Verify the signature/hash **first** (reject if invalid — log to `PaymentEvent`
     with `verified: false`).
   - **Independently verify** with the gateway (Paystack: verify endpoint; Ozow:
     recompute hash + optionally query status) and **re-check amount + currency**
     against the order's `amountCents`/`currency`.
   - **Idempotently** transition `PENDING → PAID` exactly once (guard on current
     status; a second webhook for an already-PAID order is a no-op 200). On success
     create the per-attendee `Registration` row(s), set `paidAt`, record a
     `PaymentEvent`.
   - Respond **200 quickly**; do slow work (emails) after acknowledging, or async.
7. **Buyer's success page** polls/queries order status (`GET .../orders/:reference`)
   and shows confirmation once `PAID`.

Provider-specific request/response shapes, endpoints, headers, and verification code
are in `references/paystack.md` and `references/ozow.md`. **Read the relevant one
before writing that adapter.**

## Security & correctness — the non-negotiables

These are why the skill exists. Every one has bitten real integrations.

- **Never trust client-supplied money.** Amount and price come from the `Event` row,
  server-side. The browser only sends `quantity`, attendee details, and provider.
- **Webhooks are the source of truth, not redirects.** A user can navigate to your
  success URL without paying. Only fulfil from a verified webhook (+ verify call).
- **Verify signatures before doing anything.**
  - *Paystack* signs with `x-paystack-signature` = HMAC-SHA512 of the **raw request
    body** using your secret key. You MUST hash the raw bytes, not re-serialised JSON.
  - *Ozow* sends a `Hash` you recompute (SHA512 of concatenated field values + private
    key, lowercased). See `references/ozow.md` for exact field order.
- **Raw-body gotcha (project-specific):** `api/src/app.ts` applies `express.json()`
  globally, which discards the raw body Paystack's HMAC needs. Fix by capturing it in
  the parser's `verify` hook:
  ```ts
  app.use(express.json({
    verify: (req, _res, buf) => { (req as any).rawBody = buf; },
  }));
  ```
  Then HMAC over `req.rawBody`. Ozow's notify is `application/x-www-form-urlencoded`
  and verified from parsed fields (not raw body) — ensure `express.urlencoded()` is
  available on that route (the app may only mount JSON today; add it scoped to the
  webhook route).
- **Idempotency.** Gateways retry webhooks and may fire "pending" then "complete".
  Make `PENDING → PAID` a guarded, once-only transition keyed on `reference`. Use the
  unique `reference` and the `PaymentEvent` log to detect replays. Wrap the
  status-flip + registration-creation in a DB transaction.
- **Re-check amount and currency** from the gateway's verified data against the order.
  A mismatch = do NOT fulfil; mark suspicious and log.
- **Secrets** live only in env (`api/src/config/env.ts` + server `.env`, never
  committed). Use **test/sandbox** keys until go-live; swap to live keys via env only.
- **Logging/POPIA:** never log secrets or full card/banking data. Payer + attendee PII
  on `Order`/`Registration` is personal data — apply the same retention/consent posture
  as the existing `Registration` flow (consent version, retention) and the project's
  POPIA controls.

## Implementation checklist

Work top-down; each step is small and testable. Use TDD per the project's norms.

1. **Schema:** add `Order`, `PaymentEvent`, `PaymentProvider`, `OrderStatus`, and the
   nullable `Registration.orderId`. Create a Prisma migration.
2. **Env:** add `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`,
   `OZOW_SITE_CODE`, `OZOW_API_KEY`, `OZOW_PRIVATE_KEY`, `PAYMENTS_BASE_URL`
   (for building return/notify URLs), `OZOW_IS_TEST` to `envSchema` + `.env.example`.
3. **Activate dormant fields:** relax the two `.refine()`s in
   `events.schemas.ts` `dormantPaidFieldsShape` so admins can set `isPaid: true` and a
   real `priceCents`. Add a cross-field rule: **if `isPaid` then `priceCents` must be a
   positive integer** (and conversely a free event must not carry a price). Update the
   admin Events UI to expose the price field (it was hidden in v1).
4. **Provider adapters:** a small interface
   (`initTransaction(order) → { redirectUrl, providerReference? }`,
   `verify(order, payload) → { settled, amountCents, currency, providerReference }`,
   `verifyWebhookSignature(req) → boolean`) with `paystack.adapter.ts` and
   `ozow.adapter.ts`. See the reference files.
5. **Service + repository:** `createOrder` (with attendees), `getByReference`,
   `markPaid` (transactional, idempotent, creates per-attendee registrations),
   `recordPaymentEvent`.
6. **Routes:**
   - `POST /api/v1/events/:slug/orders` (public, rate-limited, validated)
   - `GET /api/v1/orders/:reference` (public status check by opaque reference)
   - `POST /api/v1/webhooks/paystack` and `POST /api/v1/webhooks/ozow` (no auth;
     signature-verified; raw/urlencoded body handled)
   - `GET /api/v1/admin/events/:id/orders` (admin: reconciliation view)
7. **Frontend:** paid-event detail page shows price + quantity selector; choosing a
   quantity reveals that many attendee detail sub-forms plus payer details and a
   provider choice → on submit, call create-order, then redirect to `redirectUrl`.
   Build the return (success/cancel/error) pages that poll order status.
8. **Tests:** signature verification (valid + tampered), amount-tamper rejection,
   duplicate-webhook idempotency, `attendees.length === quantity` enforcement,
   free-event path unaffected, capacity enforcement.
9. **Sandbox dry run** (once accounts exist): use each provider's test
   credentials/cards/test bank to walk a full purchase before switching to live keys.

## Future work (document, don't build)

- **Refunds/cancellations**: hook point is `Order.status` (+ a `REFUNDED` state) and a
  provider refund call; out of scope now.
- **Receipts/ticketing artifacts** (QR codes, PDF tickets) if ever required.

## Reference files

- `references/codebase-map.md` — exact file paths, conventions, and verbatim snippets
  for this project's backend/frontend (read first when wiring things in).
- `references/paystack.md` — Paystack initialize/verify/webhook details + Node/TS code.
- `references/ozow.md` — Ozow create-request, hashcheck field order, notify
  verification + Node/TS code, and the amount-format caveat to confirm.
