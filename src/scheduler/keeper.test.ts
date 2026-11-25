import { Keypair } from '@stellar/stellar-sdk';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeChain } from '../../test/fake-chain.js';
import { fakeDb } from '../../test/fake-db.js';
import { Keeper, keeperRetryDelay } from './keeper.js';

const log = pino({ level: 'silent' });
const opts = { intervalMs: 1_000, batchSize: 10, retryBaseMs: 60_000 };

function setup(rows: Array<{ id: string; keeper_failures: number }>) {
  const db = fakeDb((sql) => (sql.startsWith('SELECT id, keeper_failures') ? { rows } : undefined));
  const chain = new FakeChain();
  const keeper = new Keeper(db, chain, Keypair.random(), opts, log);
  return { db, chain, keeper };
}

describe('Keeper.tick', () => {
  it('charges subscriptions the chain confirms are due', async () => {
    const { db, chain, keeper } = setup([{ id: '1', keeper_failures: 0 }]);
    chain.due.add(1n);
    const result = await keeper.tick();
    expect(result).toEqual({ checked: 1, submitted: 1, notDue: 0, declined: 0, failed: 0 });
    expect(chain.charged).toEqual([1n]);
    const attempt = db.queries.find((q) => q.sql.startsWith('INSERT INTO keeper_attempts'));
    expect(attempt?.params).toEqual(['1', 1, 'submitted', 'tx-1', null]);
  });

  it('skips subscriptions that are not due on chain', async () => {
    const { chain, keeper } = setup([{ id: '2', keeper_failures: 0 }]);
    const result = await keeper.tick();
    expect(result.notDue).toBe(1);
    expect(chain.charged).toEqual([]);
  });

  it('backs off after a failed charge', async () => {
    const { db, chain, keeper } = setup([{ id: '3', keeper_failures: 2 }]);
    chain.due.add(3n);
    chain.chargeResult = () => ({ txHash: 'tx', ok: false, error: 'insufficient allowance' });
    const result = await keeper.tick();
    expect(result.failed).toBe(1);
    const backoff = db.queries.find((q) => q.sql.includes('keeper_failures = $2'));
    expect(backoff?.params[1]).toBe(3);
    expect(Number(backoff?.params[2])).toBeGreaterThanOrEqual(120_000);
  });

  it('backs off when charge returns 0 and the subscription is past due', async () => {
    const { db, chain, keeper } = setup([{ id: '6', keeper_failures: 0 }]);
    chain.due.add(6n);
    chain.chargeResult = () => ({ txHash: 'tx-6', ok: true, amount: 0n });
    chain.subscriptions.set(6n, {
      planId: 1n,
      subscriber: 'GSUB',
      status: 'past_due',
      cyclesCharged: 2,
      nextChargeAt: new Date(0),
    });
    const result = await keeper.tick();
    expect(result).toEqual({ checked: 1, submitted: 0, notDue: 0, declined: 1, failed: 0 });
    const attempt = db.queries.find((q) => q.sql.startsWith('INSERT INTO keeper_attempts'));
    expect(attempt?.params).toEqual(['6', 1, 'declined', 'tx-6', null]);
    expect(db.queries.some((q) => q.sql.includes('keeper_failures = $2'))).toBe(true);
  });

  it('treats a zero charge covered by credit as a normal charge', async () => {
    const { chain, keeper } = setup([{ id: '7', keeper_failures: 0 }]);
    chain.due.add(7n);
    chain.chargeResult = () => ({ txHash: 'tx-7', ok: true, amount: 0n });
    chain.subscriptions.set(7n, {
      planId: 1n,
      subscriber: 'GSUB',
      status: 'active',
      cyclesCharged: 3,
      nextChargeAt: new Date(0),
    });
    const result = await keeper.tick();
    expect(result.submitted).toBe(1);
    expect(result.declined).toBe(0);
  });

  it('records thrown errors as failures without stopping the batch', async () => {
    const { chain, keeper } = setup([
      { id: '4', keeper_failures: 0 },
      { id: '5', keeper_failures: 0 },
    ]);
    chain.due.add(4n).add(5n);
    chain.chargeResult = (id) => {
      if (id === 4n) throw new Error('rpc down');
      return { txHash: 'ok', ok: true };
    };
    const result = await keeper.tick();
    expect(result).toEqual({ checked: 2, submitted: 1, notDue: 0, declined: 0, failed: 1 });
  });
});

describe('keeperRetryDelay', () => {
  it('grows with each failure and is capped', () => {
    expect(keeperRetryDelay(1)).toBeLessThanOrEqual(60_000);
    expect(keeperRetryDelay(3)).toBeGreaterThanOrEqual(120_000);
    expect(keeperRetryDelay(50)).toBeLessThanOrEqual(6 * 3_600_000);
  });
});
