import { describe, expect, it } from 'vitest';
import { buildPayload, endpointWants } from './payload.js';

describe('buildPayload', () => {
  it('uses snake_case keys and string amounts', () => {
    const payload = buildPayload({
      id: 'e1',
      ledger: 99,
      ledgerTime: new Date('2026-03-01T12:00:00Z'),
      txHash: 'ff',
      type: 'charged',
      subId: 12n,
      amount: 50_000_000n,
      fee: 250_000n,
      keeperReward: 50_000n,
      cycle: 2,
      nextChargeAt: new Date('2026-04-01T12:00:00Z'),
    });
    expect(payload).toEqual({
      id: 'e1',
      type: 'subscription.charged',
      created_at: '2026-03-01T12:00:00.000Z',
      ledger: 99,
      tx_hash: 'ff',
      data: {
        sub_id: '12',
        amount: '50000000',
        fee: '250000',
        keeper_reward: '50000',
        cycle: 2,
        next_charge_at: '2026-04-01T12:00:00.000Z',
      },
    });
  });
});

describe('endpointWants', () => {
  it('treats an empty filter as all events', () => {
    expect(endpointWants([], 'plan.created')).toBe(true);
  });

  it('matches listed events only', () => {
    expect(endpointWants(['subscription.charged'], 'subscription.charged')).toBe(true);
    expect(endpointWants(['subscription.charged'], 'subscription.cancelled')).toBe(false);
  });
});
