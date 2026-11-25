# Indexer

The indexer turns contract events into rows. It is the only writer of
subscription state, so most correctness questions in this service come down to
how it reads events.

## The loop

Every `INDEXER_POLL_INTERVAL_MS` it:

1. Loads the cursor: the last ledger and the last event id it applied.
2. Asks the RPC for events from that ledger onward, up to `INDEXER_PAGE_SIZE`.
3. Drops events at or before the cursor.
4. For each remaining event, in order: decode it, fetch any extra on-chain state it
   needs, then in one transaction apply it, queue its webhooks and move the cursor.

Because the cursor moves in the same transaction as the event, a crash at any
point leaves the database consistent. On restart the indexer picks up at the
first event it had not committed.

## Why the cursor stores an event id

A ledger can contain many events. If the cursor only stored a ledger number, the
indexer would have to choose between re-applying that ledger's events or skipping
the ones it had not reached yet. Storing the event id as well lets it re-read the
ledger and skip exactly what it already applied. Event ids are compared
numerically, part by part, so padding changes in the RPC do not matter.

## Idempotency

Every applied event is inserted into `contract_events` first. If the id is
already there, nothing else happens. This covers duplicate pages after an RPC
failover and replays after a crash.

Subscription updates carry a second guard: `WHERE updated_ledger <= $ledger`. An
event older than the last one applied to that subscription cannot overwrite its
state.

## Events it understands

| Topic | Effect |
|---|---|
| `plan_new` | Creates the merchant and plan. Calls `get_plan` for trial, max cycles and grace. |
| `sub_new` | Creates the subscription. Calls `get_subscription` for status and next charge time. |
| `charged` | Records the charge; sets next charge time; status becomes `active`, or `completed` at max cycles. |
| `chg_fail` | Records the failure; status becomes whatever the contract reported. |
| `paused` / `resumed` | Status change. Resume re-reads the next charge time. |
| `cancelled` | Status `cancelled`, remembers who cancelled. |
| `plan_chg` | Moves the subscription to the new plan. |
| `refunded` | Records the refund. |

Topics it does not know are skipped. The cursor still moves past them.

## Dead letters

An event with a known topic that cannot be decoded (a missing field, a wrong
type) is written to `dead_letter_events` with the raw XDR and the error, and the
indexer moves on. Stopping would block every merchant on one bad event.

To look at them:

```sql
SELECT id, ledger, topic, error, attempts, last_seen
FROM dead_letter_events WHERE resolved_at IS NULL ORDER BY ledger;
```

A dead letter usually means the contract and backend disagree about an event's
shape. Fix the decoder, then replay the affected range (see
[operations.md](operations.md)) and set `resolved_at`.

## When the RPC has moved on

RPC nodes keep a limited window of history (days, not months). If the cursor
points at a ledger the node no longer has, the indexer starts at the oldest
ledger available and logs a warning with both numbers. Events in between are
lost to this indexer; you will need an archive RPC or a full re-index from a
node with longer retention to recover them.

## Empty pages

When a page comes back with fewer events than the limit, everything up to the
RPC's latest ledger has been read, so the cursor jumps there. A full page might
have been cut off, so the cursor only moves to its last event.
