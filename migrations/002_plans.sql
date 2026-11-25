CREATE TABLE plans (
  id               BIGINT PRIMARY KEY,           -- plan_id from the contract
  merchant_address TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount           NUMERIC(39, 0) NOT NULL CHECK (amount > 0),
  period_secs      BIGINT NOT NULL CHECK (period_secs > 0),
  trial_secs       BIGINT NOT NULL DEFAULT 0,
  max_cycles       INTEGER NOT NULL DEFAULT 0,   -- 0 means no limit
  grace_secs       BIGINT NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT true,
  name             TEXT,
  created_ledger   BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plans_merchant_idx ON plans (merchant_address);
