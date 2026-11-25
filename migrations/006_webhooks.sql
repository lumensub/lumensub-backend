CREATE TABLE webhook_endpoints (
  id               BIGSERIAL PRIMARY KEY,
  merchant_address TEXT NOT NULL REFERENCES merchants(address) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  secret           TEXT NOT NULL,
  events           TEXT[] NOT NULL DEFAULT '{}',   -- empty means every event
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_address) WHERE active;

CREATE TABLE webhook_deliveries (
  id               BIGSERIAL PRIMARY KEY,
  endpoint_id      BIGINT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');
