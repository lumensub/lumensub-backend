CREATE TABLE charges (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
  cycle           INTEGER NOT NULL,
  amount          NUMERIC(39, 0) NOT NULL,
  fee             NUMERIC(39, 0) NOT NULL DEFAULT 0,
  keeper_reward   NUMERIC(39, 0) NOT NULL DEFAULT 0,
  ledger          BIGINT NOT NULL,
  tx_hash         TEXT,
  charged_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX charges_subscription_idx ON charges (subscription_id, cycle);
CREATE INDEX charges_charged_at_idx ON charges (charged_at);

CREATE TABLE charge_failures (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL,
  ledger          BIGINT NOT NULL,
  failed_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE refunds (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  subscription_id BIGINT NOT NULL REFERENCES subscriptions(id),
  amount          NUMERIC(39, 0) NOT NULL,
  ledger          BIGINT NOT NULL,
  refunded_at     TIMESTAMPTZ NOT NULL
);
