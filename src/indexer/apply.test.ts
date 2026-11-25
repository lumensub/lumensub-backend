import { describe, expect, it } from 'vitest';
import { fakeDb } from '../../test/fake-db.js';
import type { DomainEvent } from '../stellar/events.js';
import { applyEvent } from './apply.js';

const meta = { id: 'evt-1', ledger: 100, ledgerTime: new Date('2026-01-01T00:00:00Z'), txHash: 'aa' };

describe('applyEvent', () => {
  it('does nothing else when the event is already logged', async () => {
    const db = fakeDb((sql) => (sql.startsWith('INSERT INTO contract_events') ? { rowCount: 0 } : undefined));
    const result = await applyEvent(db, { ...meta, type: 'paused', subId: 1n });
    expect(result).toEqual({ applied: false, merchant: null });
    expect(db.queries).toHaveLength(1);
  });

  it('creates the merchant and plan for plan_new', async () => {
    const db = fakeDb();
    const event: DomainEvent = {
      ...meta,
      type: 'plan_new',
      planId: 5n,
      merchant: 'GMERCHANT',
      token: 'CTOKEN',
      amount: 10n,
      periodSecs: 60n,
    };
    const result = await applyEvent(db, event);
    expect(result).toEqual({ applied: true, merchant: 'GMERCHANT' });
    expect(db.queries.map((q) => q.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO contract_events',
      'INSERT INTO merchants',
      'INSERT INTO plans',
    ]);
  });

  it('records a charge and updates the subscription only if the event is newer', async () => {
    const db = fakeDb((sql) =>
      sql.startsWith('SELECT p.merchant_address') ? { rows: [{ merchant_address: 'GM' }] } : undefined,
    );
    const result = await applyEvent(db, {
      ...meta,
      type: 'charged',
      subId: 3n,
      amount: 100n,
      fee: 1n,
      keeperReward: 1n,
      cycle: 2,
      nextChargeAt: new Date('2026-02-01T00:00:00Z'),
    });
    expect(result.merchant).toBe('GM');
    const update = db.queries.find((q) => q.sql.startsWith('UPDATE subscriptions'));
    expect(update?.sql).toContain('updated_ledger <= $2');
    expect(update?.params.slice(0, 3)).toEqual(['3', 100, 2]);
  });

  it('stores the status reported by a failed charge', async () => {
    const db = fakeDb();
    await applyEvent(db, { ...meta, type: 'chg_fail', subId: 9n, reason: 'allowance', status: 'past_due' });
    const update = db.queries.find((q) => q.sql.startsWith('UPDATE subscriptions'));
    expect(update?.params).toEqual(['9', 100, 'past_due']);
  });
});
