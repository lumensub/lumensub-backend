CREATE TABLE subscriptions (
  id              BIGINT PRIMARY KEY,            -- sub_id from the contract
  plan_id         BIGINT NOT NULL REFERENCES plans(id),
  subscriber      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'trialing', 'active', 'past_due', 'paused',
                    'cancelled', 'lapsed', 'completed')),
  cycles_charged  INTEGER NOT NULL DEFAULT 0,
  next_charge_at  TIMESTAMPTZ,
  cancelled_by    TEXT,
  created_ledger  BIGINT NOT NULL,
  updated_ledger  BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_plan_idx ON subscriptions (plan_id);
CREATE INDEX subscriptions_subscriber_idx ON subscriptions (subscriber);
-- The keeper scans this index for work.
CREATE INDEX subscriptions_due_idx ON subscriptions (next_charge_at)
  WHERE status IN ('trialing', 'active', 'past_due');
