# Ozow adapter reference

Ozow handles **instant EFT** (bank-to-bank) for ZAR. Flow: build a payment request
with a SHA512 `HashCheck` → send the buyer to Ozow's hosted page → fulfil from the
verified notification (webhook) whose `Hash` you recompute. Official docs:
<https://ozow.com/integrations> and the Ozow developer hub (hub.ozow.com).

> ⚠ **Two things to confirm against your live merchant dashboard the moment you have an
> account** (they are the usual sources of Ozow integration failure and cannot be
> tested until you're set up):
> 1. **Amount format.** Ozow's API has historically expected `Amount` as a **decimal in
>    Rands** (e.g. `250.00`), *not* cents — but some integrations report cents. Confirm
>    with a known-good sample from your dashboard before go-live. If it's Rands, convert
>    `amountCents / 100` with exactly 2 decimals; if cents, send `amountCents`. Get this
>    wrong and you charge 100× too much or too little.
> 2. **Exact field order for the HashCheck.** The hash is order-sensitive. Use the order
>    your dashboard/docs sample shows; the order below is the commonly-documented one but
>    **verify it** by reproducing a sample hash from the docs before trusting it.

## Request fields (commonly-documented order)

Concatenate these **values** in this order to build the hash (see below). Typical set:

```
SiteCode, CountryCode, CurrencyCode, Amount, TransactionReference, BankReference,
Optional1..Optional5 (if used), Customer (if used),
CancelUrl, ErrorUrl, SuccessUrl, NotifyUrl, IsTest
```

| Field | Value |
|---|---|
| `SiteCode` | `env.OZOW_SITE_CODE` (merchant identifier) |
| `CountryCode` | `ZA` |
| `CurrencyCode` | `ZAR` |
| `Amount` | order total — **format per the caveat above** |
| `TransactionReference` | our `Order.reference` (internal) |
| `BankReference` | short buyer-visible statement label (≤ provider limit) |
| `CancelUrl` / `ErrorUrl` / `SuccessUrl` | display-only return pages (`PAYMENTS_BASE_URL` + path) |
| `NotifyUrl` | `PAYMENTS_BASE_URL` + `/api/v1/webhooks/ozow` (server-to-server) |
| `IsTest` | `env.OZOW_IS_TEST` (`true` until go-live) |
| `HashCheck` | computed (below) — **not** included in its own concatenation |

## HashCheck computation

1. Concatenate all the request **values** (excluding `HashCheck`) in the defined order.
2. Append your **private key** (`env.OZOW_PRIVATE_KEY`).
3. **Lowercase** the whole string.
4. SHA512-hex it.

```ts
import crypto from 'node:crypto';

function ozowHash(valuesInOrder: string[], privateKey: string): string {
  const concatenated = (valuesInOrder.join('') + privateKey).toLowerCase();
  return crypto.createHash('sha512').update(concatenated).digest('hex');
}
```

## Creating the payment request (two methods — pick one)

**A. API method (recommended).** POST the fields (incl. `HashCheck`) to Ozow's
post-payment-request API with your `ApiKey` header; it returns a JSON payload
containing a `url` to redirect the buyer to.

```
POST https://api.ozow.com/postpaymentrequest
ApiKey: <OZOW_API_KEY>
Accept: application/json
Content-Type: application/json   (or form-encoded — confirm in docs)
```

Response includes `{ url, paymentRequestId, errorMessage }`. Return `{ redirectUrl: url }`.

**B. Browser form-POST method.** Render an auto-submitting HTML form that POSTs the
fields to `https://pay.ozow.com`, which 302-redirects to
`https://pay.ozow.com/:uuid/Secure`. Simpler but moves hash building to where the form
is generated. Prefer method A so the secret/private key stays purely server-side.

```ts
// ozow.adapter.ts (sketch, method A)
export async function initTransaction(order: Order): Promise<{ redirectUrl: string }> {
  const fields = {
    SiteCode: env.OZOW_SITE_CODE,
    CountryCode: 'ZA',
    CurrencyCode: 'ZAR',
    Amount: formatOzowAmount(order.amountCents),   // see caveat
    TransactionReference: order.reference,
    BankReference: bankRef(order),
    CancelUrl: `${env.PAYMENTS_BASE_URL}/checkout/cancel?ref=${order.reference}`,
    ErrorUrl:  `${env.PAYMENTS_BASE_URL}/checkout/error?ref=${order.reference}`,
    SuccessUrl:`${env.PAYMENTS_BASE_URL}/checkout/return?ref=${order.reference}`,
    NotifyUrl: `${env.PAYMENTS_BASE_URL}/api/v1/webhooks/ozow`,
    IsTest: String(env.OZOW_IS_TEST),
  };
  const hashValues = [
    fields.SiteCode, fields.CountryCode, fields.CurrencyCode, fields.Amount,
    fields.TransactionReference, fields.BankReference,
    fields.CancelUrl, fields.ErrorUrl, fields.SuccessUrl, fields.NotifyUrl, fields.IsTest,
  ]; // ⚠ confirm this order against the docs sample
  const body = { ...fields, HashCheck: ozowHash(hashValues, env.OZOW_PRIVATE_KEY) };

  const res = await fetch('https://api.ozow.com/postpaymentrequest', {
    method: 'POST',
    headers: { ApiKey: env.OZOW_API_KEY, Accept: 'application/json',
               'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.errorMessage) throw new Error(`Ozow init failed: ${json.errorMessage}`);
  return { redirectUrl: json.url };
}
```

## Notification / webhook (Ozow → us) — the authoritative trigger

Ozow POSTs to your `NotifyUrl` (typically `application/x-www-form-urlencoded`) with the
transaction outcome and a `Hash`. Verify by recomputing the hash over the notification
fields:

1. Take the notification fields **in their documented order**, excluding `Hash`.
2. Append the **private key**, lowercase, SHA512 — same algorithm as the request hash.
3. Compare (timing-safe) to the received `Hash`. Mismatch → reject, log
   `PaymentEvent { verified: false }`, do not fulfil.

Notification carries a `Status` (e.g. `Complete`, `Cancelled`, `Error`, `Pending`).
Only fulfil on the success status. If a `Pending` arrives, Ozow sends a follow-up once
final — your idempotent `PENDING → PAID` guard handles the eventual success delivery.

```ts
export function verifyOzowNotification(fieldsInOrder: string[], received: { Hash: string }): boolean {
  const expected = ozowHash(fieldsInOrder, env.OZOW_PRIVATE_KEY);
  const got = received.Hash.toLowerCase();
  return expected.length === got.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
```

Then: re-check the notification's amount + reference against the order, idempotently
flip to `PAID`, create per-attendee `Registration` rows, record the `PaymentEvent`, and
respond 200.

> Defence in depth: in addition to the notification hash, you can call Ozow's
> get-transaction/status API by `TransactionReference` to independently confirm the
> settled amount and status before fulfilling — recommended, mirroring Paystack's verify
> step.

## Testing (once the account exists)

- Set `IsTest=true` and use the sandbox/test bank Ozow provides; complete a full payment
  to see a real notification fire.
- `NotifyUrl` must be publicly reachable — use a tunnel in dev and set the notify URL in
  the Ozow merchant portal (it can be configured there as well as per-request).
- Reproduce a **known-good HashCheck from the docs sample** first — this validates your
  field order and private key before any live money moves.
