# lumensub-backend

The off-chain half of [LumenSub](https://github.com/lumensub), a recurring
payments system for Stellar. Subscriptions themselves live in a Soroban contract.
This service watches that contract, charges subscriptions when they come due, and
gives merchants an API and webhooks so their own systems know who has paid.

It does not custody funds or sign for anyone. If it disappeared tomorrow, every
subscription would still be on chain and anyone could call `charge()` on them.

## How it fits together

LumenSub is three repositories:

- **[lumensub-contracts](https://github.com/lumensub/lumensub-contracts)**: the
  Soroban contract. Plans, subscriptions, pulling payments, fees, refunds.
- **lumensub-backend** (this one): indexer, keeper, merchant API, webhooks.
- **[lumensub-app](https://github.com/lumensub/lumensub-app)**: the merchant
  dashboard, hosted checkout page and subscriber portal. It talks to this API
  and to the contract directly through the user's wallet.

Inside this repo there are two processes:

- **`main.ts`** runs the HTTP API.
- **`worker.ts`** runs the indexer (reads contract events into Postgres), the
  webhook dispatcher, and optionally the keeper (submits `charge()` for due
  subscriptions).

[docs/architecture.md](docs/architecture.md) has the longer version.

## Quick start

You need Node 20+ and Docker.

```bash
npm install
cp .env.example .env          # then set SUBSCRIPTION_CONTRACT_ID
docker compose up -d          # Postgres and Redis on 127.0.0.1
npm run db:migrate
npm run dev                   # API on http://localhost:8080, docs at /docs
npm run dev:worker            # in a second terminal
```

To call merchant routes you need an API key:

```bash
npm run keys:create -- G...YOUR_MERCHANT_ADDRESS "local"
curl -H "Authorization: Bearer lsk_..." http://localhost:8080/v1/plans
```

Point `SUBSCRIPTION_CONTRACT_ID` at a contract deployed from lumensub-contracts
on testnet. Without one, the API starts but the indexer has nothing to read.

## Configuration

Everything is read from environment variables and validated at startup. A bad
value stops the process with a message naming the variable.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `SUBSCRIPTION_CONTRACT_ID` | required | `C...` address of the subscription contract |
| `STELLAR_RPC_URL` | testnet RPC | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | testnet | Must match the RPC's network |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | API listen address |
| `LOG_LEVEL` | `info` | pino level |
| `REDIS_URL` | unset | Shared rate limiting across API instances |
| `INDEXER_START_LEDGER` | `0` | Where to start on an empty database. `0` means the oldest ledger the RPC has |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | Time between `getEvents` calls |
| `INDEXER_PAGE_SIZE` | `200` | Events per call |
| `KEEPER_ENABLED` | `false` | Run the keeper in this worker |
| `KEEPER_SECRET` | unset | Seed of the funded account that submits charges |
| `KEEPER_INTERVAL_MS` | `15000` | Time between keeper passes |
| `KEEPER_BATCH_SIZE` | `20` | Subscriptions per pass |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per delivery attempt |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Before a delivery is marked dead |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | `false` | Local development only |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `120` / `1 minute` | Per API key, or per IP |

## Project layout

```
src/
  api/            HTTP server and routes
  analytics/      MRR, churn, revenue
  db/             connection pool and migration runner
  indexer/        event polling and the read model
  notifications/  merchant notifications
  scheduler/      keeper and leader election
  stellar/        RPC client and event decoding
  webhooks/       signing, delivery, SSRF protection
migrations/       SQL, applied in order
docs/             architecture, API, webhooks, indexer, operations
test/             fakes and SQL tests on PGlite
```

## Docs

- [Architecture](docs/architecture.md)
- [API](docs/api.md), plus the live reference at `/docs`
- [Webhooks](docs/webhooks.md), including signature verification in Node and Python
- [Indexer](docs/indexer.md)
- [Operations](docs/operations.md): deploying, monitoring, re-indexing

## Status

Early. The contract and this service run on testnet and the API may still change
before 1.0. Please do not point it at mainnet funds yet.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains
the setup and the few rules we care about. Security problems go to
[SECURITY.md](SECURITY.md), not the issue tracker.

## License

MIT. See [LICENSE](LICENSE).
