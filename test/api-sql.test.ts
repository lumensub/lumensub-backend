import { Keypair } from '@stellar/stellar-sdk';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey } from '../src/api/keys.js';
import { buildServer } from '../src/api/server.js';
import type { Queryable } from '../src/db/pool.js';
import { applyEvent } from '../src/indexer/apply.js';
import { Keeper } from '../src/scheduler/keeper.js';
import { FakeChain } from './fake-chain.js';
import { migratedDb } from './pglite.js';

const MERCHANT = 'G' + 'A'.repeat(55);
const SUBSCRIBER = 'G' + 'B'.repeat(55);
const log = pino({ level: 'silent' });

let db: Queryable;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildServer>>;
let auth: { authorization: string };

beforeAll(async () => {
  const handle = await migratedDb();
  db = handle.db;
  close = () => handle.pg.close();

  const meta = (id: string, ledger: number) => ({ id, ledger, ledgerTime: new Date('2026-01-01T00:00:00Z'), txHash: null });
  await applyEvent(db, { ...meta('p1', 1), type: 'plan_new', planId: 1n, merchant: MERCHANT, token: 'CUSDC', amount: 5_000_000n, periodSecs: 2_592_000n });
  for (const id of [1n, 2n, 3n]) {
    await applyEvent(
      db,
      { ...meta(`s${id}`, 2), type: 'sub_new', subId: id, planId: 1n, subscriber: SUBSCRIBER },
      { subscription: { planId: 1n, subscriber: SUBSCRIBER, status: 'active', cyclesCharged: 1, nextChargeAt: new Date('2026-01-31T00:00:00Z') } },
    );
  }
  await applyEvent(db, {
    ...meta('c1', 3),
    type: 'charged',
    subId: 1n,
    amount: 5_000_000n,
    fee: 50_000n,
    keeperReward: 5_000n,
    cycle: 2,
    nextChargeAt: new Date('2026-03-02T00:00:00Z'),
  });

  const key = await createApiKey(db, MERCHANT, 'tests');
  auth = { authorization: `Bearer ${key.key}` };
  app = await buildServer({
    db,
    log,
    readiness: async () => ({ latestLedger: 3, indexedLedger: 3, lastPollAt: new Date() }),
    rateLimit: { max: 1000, timeWindow: '1 minute' },
    webhooks: { allowPrivateTargets: false, resolve: async () => ['93.184.216.34'] },
    docsUi: false,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

describe('API routes against a migrated database', () => {
  it('lists plans with live subscription counts', async () => {
    const res = await app.inject({ url: '/v1/plans', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ id: '1', amount: '5000000', live_subscriptions: '3' })]);
  });

  it('pages through subscriptions', async () => {
    const first = await app.inject({ url: '/v1/subscriptions?limit=2', headers: auth });
    expect(first.json().data.map((s: { id: string }) => s.id)).toEqual(['3', '2']);
    const second = await app.inject({ url: `/v1/subscriptions?limit=2&cursor=${first.json().next_cursor}`, headers: auth });
    expect(second.json()).toEqual({ data: [expect.objectContaining({ id: '1' })], next_cursor: null });
  });

  it('filters subscriptions by status and subscriber', async () => {
    const res = await app.inject({ url: `/v1/subscriptions?status=active&subscriber=${SUBSCRIBER}`, headers: auth });
    expect(res.json().data).toHaveLength(3);
  });

  it('returns charge history and charge listings', async () => {
    const history = await app.inject({ url: '/v1/subscriptions/1/charges', headers: auth });
    expect(history.json().charges).toEqual([expect.objectContaining({ cycle: 2, amount: '5000000' })]);
    const all = await app.inject({ url: '/v1/charges?from=2025-12-01T00:00:00Z', headers: auth });
    expect(all.json().data).toHaveLength(1);
  });

  it('computes analytics', async () => {
    const res = await app.inject({ url: '/v1/analytics/summary', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().mrr).toEqual({ CUSDC: '15000000' });
  });

  it('serves public routes', async () => {
    const plan = await app.inject({ url: '/v1/public/plans/1' });
    expect(plan.json()).toMatchObject({ id: '1', merchant_address: MERCHANT });
    const subs = await app.inject({ url: `/v1/public/subscribers/${SUBSCRIBER}/subscriptions` });
    expect(subs.json().data).toHaveLength(3);
  });

  it('creates, lists and retries webhook deliveries', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: auth,
      payload: { url: 'https://hooks.example.com/in', events: ['subscription.charged'] },
    });
    expect(created.statusCode).toBe(201);
    const endpointId = created.json().id;
    await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, status) VALUES ($1, 'c1', 'subscription.charged', '{}', 'dead')`,
      [endpointId],
    );
    const list = await app.inject({ url: `/v1/webhook-endpoints/${endpointId}/deliveries`, headers: auth });
    const deliveryId = list.json().data[0].id;
    const retry = await app.inject({ method: 'POST', url: `/v1/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/retry`, headers: auth });
    expect(retry.statusCode).toBe(202);
    const again = await app.inject({ method: 'POST', url: `/v1/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/retry`, headers: auth });
    expect(again.statusCode).toBe(404);
  });

  it('manages API keys', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: auth, payload: { name: 'ci' } });
    expect(created.json().key).toMatch(/^lsk_/);
    const del = await app.inject({ method: 'DELETE', url: `/v1/api-keys/${created.json().id}`, headers: auth });
    expect(del.statusCode).toBe(204);
  });

  it("lets the keeper find and back off due subscriptions", async () => {
    const chain = new FakeChain();
    chain.due.add(2n);
    chain.chargeResult = () => ({ txHash: 'tx', ok: false, error: 'insufficient allowance' });
    const keeper = new Keeper(db, chain, Keypair.random(), { intervalMs: 1_000, batchSize: 10 }, log);
    const result = await keeper.tick(new Date('2026-02-01T00:00:00Z'));
    expect(result).toEqual({ checked: 2, submitted: 0, notDue: 1, declined: 0, failed: 1 });
    const { rows } = await db.query<{ keeper_failures: number }>('SELECT keeper_failures FROM subscriptions WHERE id = 2');
    expect(rows[0]?.keeper_failures).toBe(1);
  });
});
