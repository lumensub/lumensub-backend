# Running LumenSub in production

## What to deploy

- Postgres 14 or newer. Everything durable lives here.
- One or more **API** containers: `node dist/main.js`.
- One or more **worker** containers: `node dist/worker.js`. Two is a good number;
  only one keeper is active at a time and the other takes over if it dies.
- Redis, if you run more than one API instance and want shared rate limits.
- A Soroban RPC endpoint. A public one works for testnet. For mainnet, run your
  own or use a provider with a retention window longer than your worst outage.

Both processes come from the same image. Run migrations before starting new
versions:

```
node dist/db/migrate.js
```

Migrations are append-only and each runs in a transaction. A failed migration
leaves the schema as it was.

## The keeper account

The keeper signs `charge()` transactions, so it needs a funded account on the
same network. It pays transaction fees and receives the keeper reward set in the
contract. It never has access to subscriber or merchant funds; the contract only
lets it trigger charges that are already due.

Keep its seed in your secret manager and pass it as `KEEPER_SECRET`. Watch its
balance; when it runs out, charges stop and subscriptions slide into `past_due`.

## Health checks

- `GET /health` returns 200 while the process is up. Use it for liveness.
- `GET /ready` returns 200 only if Postgres answers and the indexer is within
  120 ledgers (about ten minutes) of the chain tip. Use it for readiness and
  alerting. The body says which check failed.

## Logs

JSON lines from pino. Every line has `service`, worker lines also have
`component` (`indexer`, `keeper`, `webhooks`, `notifications`). Authorization
headers and anything named `secret` are redacted before writing.

Lines worth alerting on:

| Message | Meaning |
|---|---|
| `RPC no longer has the cursor ledger` | The indexer fell further behind than the RPC's history. Events were missed. |
| `could not decode event; moved to dead letters` | Contract and backend disagree about an event. |
| `indexer poll failed` (repeating) | RPC or database trouble. The indexer backs off up to 5 minutes. |
| `charge failed` at a high rate | Often subscribers with exhausted allowances. Also check the keeper's balance. |

## Useful queries

How far behind is the indexer?

```sql
SELECT ledger, last_event_id, now() - updated_at AS since_last_write FROM indexer_cursor;
```

What is due but not being charged?

```sql
SELECT id, status, next_charge_at, keeper_failures, keeper_retry_at
FROM subscriptions
WHERE status IN ('trialing', 'active', 'past_due') AND next_charge_at < now() - interval '1 hour'
ORDER BY next_charge_at LIMIT 50;
```

Which webhook endpoints are failing?

```sql
SELECT e.id, e.url, COUNT(*) FILTER (WHERE d.status = 'dead') AS dead,
       COUNT(*) FILTER (WHERE d.status = 'failed') AS retrying
FROM webhook_endpoints e JOIN webhook_deliveries d ON d.endpoint_id = e.id
WHERE d.created_at > now() - interval '1 day'
GROUP BY e.id HAVING COUNT(*) FILTER (WHERE d.status IN ('dead', 'failed')) > 0;
```

## Re-indexing

The read model can be rebuilt from the chain, as long as the RPC still has the
history you need.

1. Stop the workers.
2. Truncate the indexed tables and reset the cursor:
   ```sql
   TRUNCATE charges, charge_failures, refunds, contract_events, dead_letter_events,
            keeper_attempts, subscriptions, plans CASCADE;
   DELETE FROM indexer_cursor;
   ```
   This keeps merchants, API keys, webhook endpoints and past deliveries.
   Because a delivery is unique per endpoint and event id, re-indexed events
   are not sent to merchants a second time. If you do want them re-sent, add
   `webhook_deliveries` to the TRUNCATE.
3. Set `INDEXER_START_LEDGER` to the ledger the contract was deployed in.
4. Start the workers.

## Backups

Back up Postgres like any other database. `api_keys` and `webhook_endpoints`
cannot be recovered from the chain; everything else can, given enough RPC
history.
