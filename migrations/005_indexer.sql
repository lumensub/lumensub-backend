-- A single row tracking how far the indexer has read. last_event_id lets the
-- indexer resume inside a ledger without skipping or repeating events.
CREATE TABLE indexer_cursor (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ledger         BIGINT NOT NULL,
  last_event_id  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw copy of every contract event we have applied. Useful for replays and audits.
CREATE TABLE contract_events (
  id           TEXT PRIMARY KEY,
  ledger       BIGINT NOT NULL,
  topic        TEXT NOT NULL,
  tx_hash      TEXT,
  payload      JSONB NOT NULL,
  ledger_time  TIMESTAMPTZ NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX contract_events_ledger_idx ON contract_events (ledger);

-- Events that could not be decoded or applied. They are kept for inspection and
-- retried by hand; the indexer does not stop on them.
CREATE TABLE dead_letter_events (
  id           TEXT PRIMARY KEY,
  ledger       BIGINT NOT NULL,
  topic        TEXT,
  payload      JSONB NOT NULL,
  error        TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
