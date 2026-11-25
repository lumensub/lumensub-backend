# Webhooks

Merchants register HTTPS endpoints and we POST a JSON body to them whenever
something happens to their plans or subscriptions.

## Events

| Type | When |
|---|---|
| `merchant.updated` | The merchant registered or changed their payout address. |
| `plan.created` | A plan was created on chain. |
| `plan.updated` | A plan was switched on or off. `data.active` is the new value. |
| `subscription.created` | Someone subscribed. |
| `subscription.charged` | A billing cycle was paid. |
| `subscription.charge_failed` | A charge failed. `data.reason` is `allowance` or `balance`; `data.status` says what the subscription is now. |
| `subscription.paused` | The subscriber paused. |
| `subscription.resumed` | The subscriber resumed. |
| `subscription.cancelled` | Cancelled. `data.by` is the address that did it. |
| `subscription.plan_changed` | Moved to another plan. |
| `subscription.refunded` | The merchant refunded part or all of a charge. |

An endpoint can subscribe to a list of types. An empty list means all of them.

## Payload

```json
{
  "id": "0000051539611648-0000000001",
  "type": "subscription.charged",
  "created_at": "2026-03-01T12:00:00.000Z",
  "ledger": 1200042,
  "tx_hash": "5b1c...",
  "data": {
    "sub_id": "12",
    "amount": "50000000",
    "fee": "250000",
    "keeper_reward": "50000",
    "cycle": 2,
    "next_charge_at": "2026-03-31T12:00:00.000Z"
  }
}
```

- `id` is the on-chain event id. Use it to de-duplicate: we deliver at least
  once, so the same event can arrive twice.
- Amounts are strings in the token's smallest unit (7 decimals for Stellar assets).
- Deliveries for different events can arrive out of order. If order matters,
  compare `ledger`, or fetch the subscription from the API.

## Verifying the signature

Every request carries a `LumenSub-Signature` header:

```
LumenSub-Signature: t=1772366400,v1=6f1e0c8b...
```

`v1` is a hex HMAC-SHA256 of `"<t>.<raw request body>"`, keyed with the
endpoint's secret (the `whsec_...` value returned once when you created it).
Check it against the raw bytes, before any JSON parsing, and reject timestamps
more than five minutes from your clock.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, header, rawBody, toleranceSecs = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSecs) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Python:

```python
import hashlib, hmac, time

def verify(secret: str, header: str, raw_body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.strip().split("=", 1) for p in header.split(","))
    t = int(parts.get("t", 0))
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

Other headers: `LumenSub-Event` (the type) and `LumenSub-Delivery` (our delivery
id, handy when asking us about a specific attempt).

## Retries

Any 2xx counts as delivered. Anything else, including timeouts
(`WEBHOOK_TIMEOUT_MS`, 10 s by default) and redirects, is retried with
exponential backoff starting around 30 seconds and capped at 6 hours. After
`WEBHOOK_MAX_ATTEMPTS` (8 by default) the delivery is marked `dead`.

You can see recent attempts with
`GET /v1/webhook-endpoints/:id/deliveries` and push a failed or dead one back
into the queue with `POST /v1/webhook-endpoints/:id/deliveries/:deliveryId/retry`.

## Which URLs are allowed

Endpoints must be `https`, must not carry credentials, and must resolve only to
public addresses. Loopback, private ranges, link-local (including cloud metadata
at `169.254.169.254`), carrier-grade NAT and their IPv6 equivalents are refused.
The check runs when the endpoint is created and again before every send, since
DNS can change in between. Redirects are not followed.

For local development, `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` turns the check off
and allows plain `http`. Never set it in production.
