# Contributing

Thanks for taking the time. This file covers how to get set up and what we look
for in a pull request. If something here is out of date, a PR fixing it is
welcome too.

## Setting up

You need Node 20 or newer and Docker (for Postgres).

```
git clone https://github.com/lumensub/lumensub-backend.git
cd lumensub-backend
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm test
```

The tests do not need Docker: anything that touches SQL runs on
[PGlite](https://github.com/electric-sql/pglite), a WASM build of Postgres, with
all migrations applied. Docker is only for running the service itself.

## Picking something to work on

Issues labelled `good first issue` are small and self-contained. If you want to
take one, comment on it so two people do not end up on the same thing. For
anything larger, open an issue first and describe the approach; it saves
rewriting a PR later.

## Making a change

- Branch from `main`. Name it after what it does, e.g. `fix/indexer-gap-warning`.
- Keep pull requests focused. One issue per PR is easiest to review.
- Add tests. Pure logic gets a unit test next to the file (`foo.test.ts`). Code
  that issues SQL gets a test in `test/` that runs on PGlite.
- Run `npm run lint`, `npm run typecheck` and `npm test` before pushing. CI runs
  the same commands.
- Use conventional commit messages (`feat(api): ...`, `fix(indexer): ...`,
  `docs: ...`). They make the history easy to scan.

## Rules worth knowing

- **Migrations are append-only.** Never edit a file in `migrations/` that is on
  `main`. Add a new numbered file instead.
- **Amounts never become numbers.** Keep i128 values as `bigint` in code and
  strings in JSON and SQL parameters.
- **Subscription state only changes through the indexer.** The keeper and the
  API do not write status, cycles or charge times. If you find yourself wanting
  to, the change probably belongs in the contract.
- **Webhook payloads are a public contract.** Adding a field is fine. Renaming or
  removing one needs a new event type or a version bump, and an issue first.
- **No secrets in logs.** The logger redacts the usual suspects; if you add a new
  secret field, add it to the redact list in `src/logger.ts`.

## Reporting bugs

Use the bug report form. Logs help a lot, but strip API keys, webhook secrets
and keeper seeds first. Security problems go through [SECURITY.md](SECURITY.md),
not public issues.
