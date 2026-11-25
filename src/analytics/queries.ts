import type { Queryable } from '../db/pool.js';
import { churnRate, monthlyRecurringRevenue } from './metrics.js';

export interface MerchantSummary {
  mrr: Record<string, string>;
  subscriptions: Record<string, number>;
  churn30d: number;
  revenue30d: Array<{ plan_id: string; token: string; charges: number; gross: string; fees: string }>;
}

export async function merchantSummary(db: Queryable, merchant: string, now: Date = new Date()): Promise<MerchantSummary> {
  const windowStart = new Date(now.getTime() - 30 * 86_400_000);

  const lines = await db.query<{ token: string; amount: string; period_secs: string; active: string }>(
    `SELECT p.token, p.amount, p.period_secs, COUNT(s.id) AS active
     FROM plans p JOIN subscriptions s ON s.plan_id = p.id AND s.status IN ('active', 'past_due')
     WHERE p.merchant_address = $1
     GROUP BY p.id`,
    [merchant],
  );
  const mrr = monthlyRecurringRevenue(
    lines.rows.map((r) => ({
      token: r.token,
      amount: BigInt(r.amount),
      periodSecs: BigInt(r.period_secs),
      activeCount: Number(r.active),
    })),
  );

  const byStatus = await db.query<{ status: string; n: string }>(
    `SELECT s.status, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE p.merchant_address = $1 GROUP BY s.status`,
    [merchant],
  );

  // Live at the window start: created before it and not ended before it.
  const churn = await db.query<{ live: string; ended: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE s.created_at < $2 AND NOT (s.status IN ('cancelled', 'lapsed') AND s.updated_at < $2))
         AS live,
       COUNT(*) FILTER (WHERE s.created_at < $2 AND s.status IN ('cancelled', 'lapsed') AND s.updated_at >= $2)
         AS ended
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE p.merchant_address = $1`,
    [merchant, windowStart],
  );

  const revenue = await db.query<{ plan_id: string; token: string; charges: string; gross: string; fees: string }>(
    `SELECT p.id AS plan_id, p.token, COUNT(c.id) AS charges,
            COALESCE(SUM(c.amount), 0) AS gross, COALESCE(SUM(c.fee + c.keeper_reward), 0) AS fees
     FROM charges c JOIN subscriptions s ON s.id = c.subscription_id JOIN plans p ON p.id = s.plan_id
     WHERE p.merchant_address = $1 AND c.charged_at >= $2
     GROUP BY p.id, p.token ORDER BY gross DESC`,
    [merchant, windowStart],
  );

  const churnRow = churn.rows[0];
  return {
    mrr: Object.fromEntries(Object.entries(mrr).map(([token, v]) => [token, v.toString()])),
    subscriptions: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)])),
    churn30d: churnRate(Number(churnRow?.live ?? 0), Number(churnRow?.ended ?? 0)),
    revenue30d: revenue.rows.map((r) => ({ ...r, charges: Number(r.charges) })),
  };
}

export interface RevenueDay {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  token: string;
  charges: number;
  gross: string;
}

/**
 * Successful charges per UTC day and token over the last `days` days. Days with no
 * charges are left out; the caller fills gaps if it wants a continuous series.
 */
export async function revenueByDay(db: Queryable, merchant: string, days: number, now: Date = new Date()): Promise<RevenueDay[]> {
  const { rows } = await db.query<RevenueDay>(
    `SELECT to_char(c.charged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, p.token,
            COUNT(*)::int AS charges, SUM(c.amount)::text AS gross
     FROM charges c JOIN subscriptions s ON s.id = c.subscription_id JOIN plans p ON p.id = s.plan_id
     WHERE p.merchant_address = $1 AND c.charged_at >= $2::timestamptz - $3::int * interval '1 day'
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [merchant, now, days],
  );
  return rows;
}
