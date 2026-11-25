-- charge() does not fail when the subscriber cannot pay. It returns 0, publishes
-- chg_fail and leaves the subscription past due. The keeper records that as
-- 'declined' so operators can tell it apart from a transaction that never landed.
ALTER TABLE keeper_attempts DROP CONSTRAINT keeper_attempts_outcome_check;
ALTER TABLE keeper_attempts
  ADD CONSTRAINT keeper_attempts_outcome_check
  CHECK (outcome IN ('submitted', 'not_due', 'failed', 'declined'));
