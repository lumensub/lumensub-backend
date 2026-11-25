import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { merchantSummary } from '../src/analytics/queries.js';
import { createApiKey, merchantForKey } from '../src/api/keys.js';
import type { Queryable } from '../src/db/pool.js';
import { applyEvent } from '../src/indexer/apply.js';
import { enqueueWebhooks } from '../src/webhooks/enqueue.js';
import { migratedDb } from './pglite.js';

const MERCHANT = 'G' + 'M'.repeat(55);
const SUBSCRIBER = 'G' + 'S'.repeat(55);
const t = (iso: string) => new Date(iso);

let db: Queryable;
let close: () => Promise<void>;

beforeAll(async () => {
  const handle = await migratedDb();
  db = handle.db;
  close = () => handle.pg.close();
}, 60_000);

afterAll(async () => {
  await close?.();
});

const meta = (id: string, ledger: number, iso = '2026-01-01T00:00:00Z') => ({ id, ledger, ledgerTime: t(iso), txHash: `tx-${id}` });

describe('SQL against a migrated database', () => {
  it('indexes a plan, a subscription and its charges', async () => {
    await applyEvent(db, {
      ...meta('e1', 10),
      type: 'plan_new',
      planId: 1n,
      merchant: MERCHANT,
      token: 'CUSDC',
      amount: 10_000_000n,
      periodSecs: 2_592_000n,
    });
    await applyEvent(
      db,
      { ...meta('e2', 11), type: 'sub_new', subId: 1n, planId: 1n, subscriber: SUBSCRIBER },
      { subscription: { planId: 1n, subscriber: SUBSCRIBER, status: 'active', cyclesCharged: 1, nextChargeAt: t('2026-01-31T00:00:00Z') } },
    );
    const charged = await applyEvent(db, {
      ...meta('e3', 50, '2026-01-31T00:00:05Z'),
      type: 'charged',
      subId: 1n,
      amount: 10_000_000n,
      fee: 100_000n,
      keeperReward: 10_000n,
      cycle: 2,
      nextChargeAt: t('2026-03-02T00:00:00Z'),
    });
    expect(charged).toEqual({ applied: true, merchant: MERCHANT });

    const { rows } = await db.query<{ status: string; cycles_charged: number; updated_ledger: string }>(
      'SELECT status, cycles_charged, updated_ledger FROM subscriptions WHERE id = 1',
    );
    expect(rows[0]).toMatchObject({ status: 'active', cycles_charged: 2, updated_ledger: '50' });
  });

  it('ignores a replayed event', async () => {
    const again = await applyEvent(db, { ...meta('e3', 50), type: 'paused', subId: 1n });
    expect(again.applied).toBe(false);
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*) AS n FROM charges');
    expect(rows[0]?.n).toBe('1');
  });

  it('does not let an older event overwrite newer state', async () => {
    await applyEvent(db, { ...meta('e4', 60), type: 'cancelled', subId: 1n, by: SUBSCRIBER });
    await applyEvent(db, { ...meta('e0-late', 40), type: 'resumed', subId: 1n });
    const { rows } = await db.query<{ status: string }>('SELECT status FROM subscriptions WHERE id = 1');
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('marks a subscription completed when max_cycles is reached', async () => {
    await db.query('UPDATE plans SET max_cycles = 3 WHERE id = 1');
    await applyEvent(
      db,
      { ...meta('e5', 70), type: 'sub_new', subId: 2n, planId: 1n, subscriber: SUBSCRIBER },
      { subscription: { planId: 1n, subscriber: SUBSCRIBER, status: 'active', cyclesCharged: 2, nextChargeAt: t('2026-02-01T00:00:00Z') } },
    );
    await applyEvent(db, {
      ...meta('e6', 71),
      type: 'charged',
      subId: 2n,
      amount: 1n,
      fee: 0n,
      keeperReward: 0n,
      cycle: 3,
      nextChargeAt: t('2026-03-01T00:00:00Z'),
    });
    const { rows } = await db.query<{ status: string }>('SELECT status FROM subscriptions WHERE id = 2');
    expect(rows[0]?.status).toBe('completed');
  });

  it('issues and resolves API keys', async () => {
    const created = await createApiKey(db, MERCHANT, 'tests');
    await expect(merchantForKey(db, created.key)).resolves.toBe(MERCHANT);
    await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [created.id]);
    await expect(merchantForKey(db, created.key)).resolves.toBeNull();
  });

  it('queues one webhook delivery per matching endpoint, once', async () => {
    await db.query(`INSERT INTO webhook_endpoints (merchant_address, url, secret, events) VALUES ($1, 'https://a.example', 's', '{}')`, [
      MERCHANT,
    ]);
    const event = { ...meta('e7', 80), type: 'paused' as const, subId: 2n };
    expect(await enqueueWebhooks(db, MERCHANT, event)).toBe(1);
    expect(await enqueueWebhooks(db, MERCHANT, event)).toBe(0);
  });

  it('computes the merchant summary', async () => {
    const summary = await merchantSummary(db, MERCHANT, t('2026-02-15T00:00:00Z'));
    expect(summary.subscriptions).toEqual({ cancelled: 1, completed: 1 });
    expect(summary.mrr).toEqual({});
    expect(Array.isArray(summary.revenue30d)).toBe(true);
  });
});
