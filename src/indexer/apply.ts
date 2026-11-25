import type { Queryable } from '../db/pool.js';
import type { OnChainPlan, OnChainSubscription } from '../stellar/chain.js';
import { toJson, type DomainEvent } from '../stellar/events.js';

/** Extra on-chain state the indexer looks up before applying some events. */
export interface Enrichment {
  plan?: OnChainPlan & { id: bigint };
  subscription?: OnChainSubscription;
}

export interface ApplyResult {
  /** False when the event was already in the log, so nothing changed. */
  applied: boolean;
  /** Merchant the event belongs to, for webhook fan-out. */
  merchant: string | null;
}

async function upsertPlan(db: Queryable, plan: OnChainPlan & { id: bigint }, ledger: number): Promise<void> {
  await db.query('INSERT INTO merchants (address) VALUES ($1) ON CONFLICT DO NOTHING', [plan.merchant]);
  await db.query(
    `INSERT INTO plans (id, merchant_address, token, amount, period_secs, trial_secs, max_cycles, grace_secs, active, created_ledger)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       token = EXCLUDED.token, amount = EXCLUDED.amount, period_secs = EXCLUDED.period_secs,
       trial_secs = EXCLUDED.trial_secs, max_cycles = EXCLUDED.max_cycles,
       grace_secs = EXCLUDED.grace_secs, active = EXCLUDED.active`,
    [
      plan.id.toString(),
      plan.merchant,
      plan.token,
      plan.amount.toString(),
      plan.periodSecs.toString(),
      plan.trialSecs.toString(),
      plan.maxCycles,
      plan.graceSecs.toString(),
      plan.active,
      ledger,
    ],
  );
}

/** Updates a subscription, but only if this event is not older than the last one applied. */
async function updateSubscription(db: Queryable, subId: bigint, ledger: number, set: string, params: unknown[]): Promise<void> {
  await db.query(
    `UPDATE subscriptions SET ${set}, updated_ledger = $2, updated_at = now()
     WHERE id = $1 AND updated_ledger <= $2`,
    [subId.toString(), ledger, ...params],
  );
}

/**
 * Applies one event to the read model. Idempotent: the event id goes into
 * contract_events first, and a second attempt at the same id is a no-op.
 * Run it inside a transaction together with the cursor update.
 */
export async function applyEvent(db: Queryable, event: DomainEvent, extra: Enrichment = {}): Promise<ApplyResult> {
  const { id, ledger, ledgerTime, txHash, type, ...body } = event;
  const logged = await db.query(
    `INSERT INTO contract_events (id, ledger, topic, tx_hash, payload, ledger_time)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [id, ledger, type, txHash, JSON.stringify(toJson(body)), ledgerTime],
  );
  if (logged.rowCount === 0) return { applied: false, merchant: null };

  switch (event.type) {
    case 'plan_new': {
      await upsertPlan(
        db,
        extra.plan ?? {
          id: event.planId,
          merchant: event.merchant,
          token: event.token,
          amount: event.amount,
          periodSecs: event.periodSecs,
          trialSecs: 0n,
          maxCycles: 0,
          graceSecs: 0n,
          active: true,
        },
        ledger,
      );
      return { applied: true, merchant: event.merchant };
    }

    case 'sub_new': {
      if (extra.plan) await upsertPlan(db, extra.plan, ledger);
      const sub = extra.subscription;
      await db.query(
        `INSERT INTO subscriptions (id, plan_id, subscriber, status, cycles_charged, next_charge_at, created_ledger, updated_ledger)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (id) DO NOTHING`,
        [
          event.subId.toString(),
          event.planId.toString(),
          event.subscriber,
          sub?.status ?? 'active',
          sub?.cyclesCharged ?? 0,
          sub?.nextChargeAt ?? ledgerTime,
          ledger,
        ],
      );
      break;
    }

    case 'charged': {
      await db.query(
        `INSERT INTO charges (event_id, subscription_id, cycle, amount, fee, keeper_reward, ledger, tx_hash, charged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          event.subId.toString(),
          event.cycle,
          event.amount.toString(),
          event.fee.toString(),
          event.keeperReward.toString(),
          ledger,
          txHash,
          ledgerTime,
        ],
      );
      // A charge clears any keeper backoff. Once max_cycles is reached the
      // subscription is complete; otherwise it is active again.
      await updateSubscription(
        db,
        event.subId,
        ledger,
        `cycles_charged = GREATEST(cycles_charged, $3),
         next_charge_at = $4,
         keeper_failures = 0,
         keeper_retry_at = NULL,
         status = CASE
           WHEN (SELECT max_cycles FROM plans WHERE plans.id = subscriptions.plan_id) BETWEEN 1 AND $3 THEN 'completed'
           ELSE 'active' END`,
        [event.cycle, event.nextChargeAt],
      );
      break;
    }

    case 'chg_fail':
      await db.query(
        `INSERT INTO charge_failures (event_id, subscription_id, reason, status, ledger, failed_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, event.subId.toString(), event.reason, event.status, ledger, ledgerTime],
      );
      await updateSubscription(db, event.subId, ledger, 'status = $3', [event.status]);
      break;

    case 'paused':
      await updateSubscription(db, event.subId, ledger, "status = 'paused'", []);
      break;

    case 'resumed':
      await updateSubscription(
        db,
        event.subId,
        ledger,
        "status = 'active', next_charge_at = COALESCE($3, next_charge_at)",
        [extra.subscription?.nextChargeAt ?? null],
      );
      break;

    case 'cancelled':
      await updateSubscription(db, event.subId, ledger, "status = 'cancelled', cancelled_by = $3", [event.by]);
      break;

    case 'plan_chg':
      if (extra.plan) await upsertPlan(db, extra.plan, ledger);
      await updateSubscription(db, event.subId, ledger, 'plan_id = $3', [event.toPlan.toString()]);
      break;

    case 'refunded':
      await db.query(
        `INSERT INTO refunds (event_id, subscription_id, amount, ledger, refunded_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, event.subId.toString(), event.amount.toString(), ledger, ledgerTime],
      );
      break;
  }

  const owner = await db.query<{ merchant_address: string }>(
    `SELECT p.merchant_address FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`,
    [event.subId.toString()],
  );
  return { applied: true, merchant: owner.rows[0]?.merchant_address ?? null };
}
