-- Merchants are registered on chain with register_merchant. The indexer adds a row
-- the first time it sees a plan from a merchant; payout_address is filled in from
-- get_merchant when it is first needed. The API adds display metadata and API keys.
CREATE TABLE merchants (
  address           TEXT PRIMARY KEY,
  payout_address    TEXT,
  display_name      TEXT,
  registered_ledger BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id               BIGSERIAL PRIMARY KEY,
  merchant_address TEXT NOT NULL REFERENCES merchants(address) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  key_prefix       TEXT NOT NULL,
  key_hash         TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ
);

CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_address) WHERE revoked_at IS NULL;
