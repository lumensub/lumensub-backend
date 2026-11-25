-- One row per charge() the keeper submitted, whatever the outcome. The indexed
-- charged / chg_fail events are the source of truth; this table is for operators.
CREATE TABLE keeper_attempts (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
  attempt         INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('submitted', 'not_due', 'failed')),
  tx_hash         TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX keeper_attempts_sub_idx ON keeper_attempts (subscription_id, created_at DESC);

-- Backoff state so a subscription that keeps failing is not retried every tick.
ALTER TABLE subscriptions
  ADD COLUMN keeper_retry_at TIMESTAMPTZ,
  ADD COLUMN keeper_failures INTEGER NOT NULL DEFAULT 0;
