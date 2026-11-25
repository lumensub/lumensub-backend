# Architecture

LumenSub keeps the money on chain and everything else off it. The subscription
contract in [lumensub-contracts](https://github.com/lumensub/lumensub-contracts)
holds plans and subscriptions, pulls payments from subscribers' allowances and
pays merchants. This backend never holds funds and never signs anything on a
merchant's or subscriber's behalf. Its jobs are narrower:

1. Read the contract's events and keep a queryable copy of the state.
2. Call `charge()` when a subscription is due, because contracts cannot wake themselves up.
3. Tell merchants what happened, through an API and signed webhooks.

## Processes

There are two processes, built from the same code and the same Docker image.

```
                  Soroban RPC
                 ▲          ▲
        getEvents│          │simulate / send charge()
                 │          │
   ┌─────────────┴──────────┴────────────┐
   │ worker.ts                           │
   │  Indexer ──► Postgres ◄── Keeper    │
   │                 │                   │
   │      Webhook dispatcher ──► merchant endpoints
   └─────────────────┼───────────────────┘
                     │
   ┌─────────────────┴───────────────────┐
   │ main.ts  (Fastify API, read-mostly) │ ◄── dashboard, checkout, merchants' servers
   └─────────────────────────────────────┘
```

**API (`src/main.ts`).** Serves `/v1` for merchants (API key required) and
`/v1/public` for the checkout page and subscriber portal. It reads Postgres. The
only things it writes are API keys, webhook endpoints, display names and retry
requests. It can be scaled horizontally; give it `REDIS_URL` so rate limits are
shared between instances.

**Worker (`src/worker.ts`).** Runs three loops:

- The **indexer** polls `getEvents` for the subscription contract, decodes each
  event and applies it to the read model. See [indexer.md](indexer.md).
- The **webhook dispatcher** sends queued deliveries with retries. See
  [webhooks.md](webhooks.md).
- The **keeper** (off unless `KEEPER_ENABLED=true`) finds due subscriptions and
  submits `charge()`. A Postgres advisory lock makes sure only one worker is
  charging at a time, so you can run several workers for availability.

## Why the chain stays the source of truth

The keeper never marks a subscription as charged. It submits the transaction and
moves on. The `charged` or `chg_fail` event comes back through the indexer like
everything else. This keeps one write path for subscription state, which makes
the read model easy to rebuild: drop the tables, reset the cursor, re-index.

Before charging, the keeper also asks the contract `is_due()`. The read model
can trail the chain by a few ledgers, and a charge that the contract rejects
still costs the keeper a fee.

## Data model

| Table | Filled by | Notes |
|---|---|---|
| `merchants` | indexer, CLI | One row per merchant address. |
| `plans` | indexer | Mirrors `get_plan`. `name` is set through the API. |
| `subscriptions` | indexer | `updated_ledger` stops older events from overwriting newer state. |
| `charges`, `charge_failures`, `refunds` | indexer | One row per event. |
| `contract_events` | indexer | Raw log of every applied event. Also the idempotency key. |
| `dead_letter_events` | indexer | Events that could not be decoded. |
| `indexer_cursor` | indexer | Single row: last ledger and event id applied. |
| `webhook_endpoints`, `webhook_deliveries` | API, indexer, dispatcher | The delivery queue. |
| `api_keys` | API, CLI | SHA-256 hashes only. |
| `keeper_attempts` | keeper | What the keeper tried and what happened. |

Token amounts are `NUMERIC(39,0)` in the database and strings everywhere else.
They are `i128` on chain and do not fit in a JavaScript number.

## Code layout

```
src/
  api/            Fastify server, routes, API keys, pagination, errors
  analytics/      MRR and churn maths, summary queries
  db/             pg pool, migration runner
  indexer/        polling loop, cursor rules, event application
  notifications/  notifier interface and senders
  scheduler/      keeper and leader lock
  stellar/        RPC client, event decoding, status mapping
  webhooks/       payloads, signing, SSRF guard, queue, dispatcher
  main.ts         API process
  worker.ts       background process
migrations/       plain SQL, applied in order
test/             fakes and tests that run SQL on PGlite
```
