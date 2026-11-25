# API

The full reference is generated from the code and served at `/docs` (Swagger UI)
and `/docs/json` (OpenAPI 3). This page covers the parts that are easier to
explain in prose.

## Authentication

Merchant routes live under `/v1` and need an API key:

```
Authorization: Bearer lsk_4f0c...
```

`X-Api-Key: lsk_...` works too. Keys belong to one merchant address and every
query is scoped to it; there is no way to read another merchant's data with your
key.

The first key for a merchant is issued from the command line by whoever runs the
backend:

```
npm run keys:create -- GABC...XYZ "dashboard"
```

After that a merchant can manage their own keys with `GET/POST /v1/api-keys` and
`DELETE /v1/api-keys/:id`. We store a SHA-256 hash, so a key is shown exactly
once, in the response that creates it.

## Public routes

Three routes need no key. They exist for the hosted checkout page and the
subscriber portal, and return only data that is already public on chain:

- `GET /v1/public/plans/:id`: price and terms of one plan, with the merchant's display name.
- `GET /v1/public/subscribers/:address/subscriptions`: every subscription a wallet holds.
- `GET /v1/public/subscriptions/:id/payments`: `{ charges, failures, refunds }` for one
  subscription, which the portal turns into receipts.

## Conventions

- **Amounts** are strings in the token's smallest unit. `"10000000"` is 1 USDC.
- **Ids** of plans and subscriptions are the contract's ids, also as strings.
- **Times** are ISO 8601 in UTC.
- **Lists** are newest first and use cursor pagination: pass `limit` (1 to 200,
  default 50) and the `next_cursor` from the previous page as `cursor`. A
  `next_cursor` of `null` means you have reached the end.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "invalid_request", "message": "request validation failed", "details": [ ... ] } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | A parameter or body field failed validation. `details` lists which. |
| 401 | `unauthorized` | Missing, malformed or revoked API key. |
| 404 | `not_found` | No such record for this merchant, or no such route. |
| 409 | `limit_reached` | For example, too many webhook endpoints. |
| 422 | `unsafe_url` | A webhook URL points at a private or loopback address. |
| 429 | `rate_limited` | Slow down. The limit is per API key, or per IP without one. |
| 500 | `internal` | Our fault. The request id in the logs will help us find it. |

## Endpoints at a glance

| Method | Path | |
|---|---|---|
| GET | `/v1/merchant` | Your merchant record |
| PATCH | `/v1/merchant` | Set `display_name` |
| GET | `/v1/plans` | Your plans, with live subscription counts |
| GET / PATCH | `/v1/plans/:id` | One plan / set its display name |
| GET | `/v1/subscriptions` | Filter by `status`, `plan_id`, `subscriber` |
| GET | `/v1/subscriptions/:id` | One subscription |
| GET | `/v1/subscriptions/:id/charges` | Charges and failures for it |
| GET | `/v1/charges` | All charges, filter by `from` / `to` |
| GET | `/v1/refunds` | All refunds |
| GET | `/v1/analytics/summary` | MRR per token, counts by status, 30-day churn and revenue |
| GET | `/v1/analytics/revenue` | Charges per UTC day and token; `days` from 1 to 365, default 30 |
| GET / POST | `/v1/webhook-endpoints` | List / create |
| DELETE | `/v1/webhook-endpoints/:id` | Disable |
| GET | `/v1/webhook-endpoints/:id/deliveries` | Last 100 deliveries |
| POST | `/v1/webhook-endpoints/:id/deliveries/:deliveryId/retry` | Re-send now |
| GET / POST / DELETE | `/v1/api-keys` | Manage keys |

Plans and subscriptions are created, changed and cancelled on chain, from the
merchant's or subscriber's wallet. The API reflects those changes; it does not
make them.

## Analytics

`MRR` scales each plan's price to a 30-day month and sums active and past-due
subscriptions, per token. It rounds down. Churn is the share of subscriptions
that were live 30 days ago and have since been cancelled or lapsed.
