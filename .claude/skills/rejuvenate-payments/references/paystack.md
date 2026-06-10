# Paystack adapter reference

Paystack handles **cards** (and more) for ZAR. Flow: initialize a transaction
server-side → redirect buyer to the returned `authorization_url` → fulfil from the
verified webhook (and an independent verify call). Docs:
<https://paystack.com/docs/payments/accept-payments/>,
`/verify-payments/`, `/webhooks/`.

> Amounts are in the **lowest denomination** — for ZAR that is **cents**. Our
> `amountCents` maps 1:1 (do NOT multiply again). `currency: "ZAR"`.

## 1. Initialize a transaction (server → Paystack)

```
POST https://api.paystack.co/transaction/initialize
Authorization: Bearer <PAYSTACK_SECRET_KEY>
Content-Type: application/json
```

Body:

```json
{
  "email": "buyer@example.com",
  "amount": 25000,
  "currency": "ZAR",
  "reference": "our-unique-order-reference",
  "callback_url": "https://app.rejuvenate.org/checkout/return?ref=our-unique-order-reference"
}
```

- `amount` = the order's `amountCents` (server-computed; never from the client).
- `reference` = our `Order.reference` (so the webhook/verify map back to the order).
- `callback_url` = our display-only return page.

Response (`data.authorization_url` is where you send the buyer):

```json
{
  "status": true,
  "message": "Authorization URL created",
  "data": {
    "authorization_url": "https://checkout.paystack.com/0peioxfhpn",
    "access_code": "0peioxfhpn",
    "reference": "our-unique-order-reference"
  }
}
```

Adapter `initTransaction` returns `{ redirectUrl: data.authorization_url,
providerReference: data.reference }`.

```ts
// paystack.adapter.ts (sketch)
import { env } from '../../config/env';

export async function initTransaction(order: Order): Promise<{ redirectUrl: string }> {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: order.payerEmail,
      amount: order.amountCents,        // ZAR cents — 1:1
      currency: order.currency,         // "ZAR"
      reference: order.reference,
      callback_url: `${env.PAYMENTS_BASE_URL}/checkout/return?ref=${order.reference}`,
    }),
  });
  const json = await res.json();
  if (!json.status) throw new Error(`Paystack init failed: ${json.message}`);
  return { redirectUrl: json.data.authorization_url };
}
```

## 2. Webhook (Paystack → us) — the authoritative trigger

```
POST /api/v1/webhooks/paystack
Header: x-paystack-signature: <HMAC-SHA512 of the RAW body, key = PAYSTACK_SECRET_KEY>
```

Verify the signature against the **raw request bytes** (see the raw-body gotcha in
SKILL.md). Compare using a timing-safe comparison.

```ts
import crypto from 'node:crypto';

export function verifyWebhookSignature(req: Request): boolean {
  const raw: Buffer = (req as any).rawBody;            // captured in express.json verify hook
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(raw)
    .digest('hex');
  const got = req.header('x-paystack-signature') ?? '';
  return (
    expected.length === got.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))
  );
}
```

Event payload (the one you care about is `charge.success`):

```json
{
  "event": "charge.success",
  "data": {
    "reference": "our-unique-order-reference",
    "amount": 25000,
    "currency": "ZAR",
    "status": "success"
  }
}
```

Handler outline:

1. `verifyWebhookSignature(req)` — if false: respond 200 (so Paystack stops retrying a
   request it can't fix) but record a `PaymentEvent { verified: false }` and do nothing
   else. (Some teams return 401 here; 200 + log is fine and avoids noisy retries —
   choose one and be consistent.)
2. Look up the order by `data.reference`. If `event !== 'charge.success'`, ack 200.
3. **Independently verify** (step 3 below) — don't trust the webhook body's amount alone.
4. Idempotently flip `PENDING → PAID`, create per-attendee `Registration` rows, set
   `paidAt`, record `PaymentEvent { verified: true }`. Second delivery = no-op 200.
5. Respond **200** promptly. Defer emails/slow work.

## 3. Verify a transaction (server → Paystack) — defence in depth

```
GET https://api.paystack.co/transaction/verify/:reference
Authorization: Bearer <PAYSTACK_SECRET_KEY>
```

Response:

```json
{
  "status": true,
  "data": { "status": "success", "amount": 25000, "currency": "ZAR",
            "reference": "our-unique-order-reference" }
}
```

Only fulfil when **all** hold:
- `data.status === "success"`,
- `data.amount === order.amountCents`,
- `data.currency === order.currency`.

Any mismatch → do **not** fulfil; log a suspicious `PaymentEvent`.

## Testing (once the account exists)

- Use **test secret/public keys** (`sk_test_…`, `pk_test_…`) from the dashboard.
- Paystack provides test cards (e.g. a success card and cards that simulate failures)
  in their docs — walk a full purchase end-to-end before switching env to live keys.
- Webhooks need a publicly reachable URL; use a tunnel (e.g. ngrok/cloudflared) in dev,
  set as the webhook URL in the Paystack dashboard.
