import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { decodeEvent, EventDecodeError, mapEvent, toJson, type EventMeta } from './events.js';

const meta: EventMeta = { id: '0000001-0001', ledger: 1, ledgerTime: new Date(0), txHash: 'abc' };
const merchant = Keypair.random().publicKey();
const subscriber = Keypair.random().publicKey();

describe('mapEvent', () => {
  it('maps a charged event', () => {
    const event = mapEvent(meta, ['charged', 7n], {
      amount: 10_000_000n,
      fee: 100_000n,
      keeper_reward: 10_000n,
      cycle: 3,
      next_charge_at: 1_700_000_000n,
    });
    expect(event).toMatchObject({
      type: 'charged',
      subId: 7n,
      amount: 10_000_000n,
      cycle: 3,
      nextChargeAt: new Date(1_700_000_000_000),
    });
  });

  it('maps a charge failure with the u32 status the contract publishes', () => {
    const event = mapEvent(meta, ['chg_fail', 2n], { reason: 'allowance', status: 2 });
    expect(event).toMatchObject({ type: 'chg_fail', status: 'past_due', reason: 'allowance' });
  });

  it('maps pause and resume without a body', () => {
    expect(mapEvent(meta, ['paused', 4n], undefined)).toMatchObject({ type: 'paused', subId: 4n });
    expect(mapEvent(meta, ['resumed', 4n], undefined)).toMatchObject({ type: 'resumed', subId: 4n });
  });

  it('maps a merchant registration, whose data is the payout address', () => {
    const payout = Keypair.random().publicKey();
    expect(mapEvent(meta, ['merchant', merchant], payout)).toMatchObject({ type: 'merchant', merchant, payout });
  });

  it('maps a plan being switched off or on', () => {
    expect(mapEvent(meta, ['plan_act', 5n], false)).toMatchObject({ type: 'plan_act', planId: 5n, active: false });
    expect(() => mapEvent(meta, ['plan_act', 5n], 'yes')).toThrow(EventDecodeError);
  });

  it('skips the config event', () => {
    expect(mapEvent(meta, ['config'], { fee_bps: 100 })).toBeNull();
  });

  it('ignores topics it does not know', () => {
    expect(mapEvent(meta, ['upgraded'], {})).toBeNull();
    expect(mapEvent(meta, [42], {})).toBeNull();
  });

  it('raises a decode error for a known topic with a bad body', () => {
    expect(() => mapEvent(meta, ['refunded', 1n], { amount: 'lots' })).toThrow(EventDecodeError);
    expect(() => mapEvent(meta, ['sub_new', 1n], { plan_id: 1n })).toThrow(/missing field subscriber/);
  });
});

describe('decodeEvent', () => {
  it('decodes XDR topics and a map body', () => {
    const event = decodeEvent({
      id: meta.id,
      ledger: 12,
      ledgerClosedAt: '2026-01-01T00:00:00Z',
      txHash: 'deadbeef',
      topic: [nativeToScVal('sub_new', { type: 'symbol' }), nativeToScVal(9n, { type: 'u64' })],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: nativeToScVal('plan_id', { type: 'symbol' }), val: nativeToScVal(3n, { type: 'u64' }) }),
        new xdr.ScMapEntry({
          key: nativeToScVal('subscriber', { type: 'symbol' }),
          val: new Address(subscriber).toScVal(),
        }),
      ]),
    });
    expect(event).toMatchObject({ type: 'sub_new', subId: 9n, planId: 3n, subscriber, ledger: 12, txHash: 'deadbeef' });
  });

  it('decodes a plan_new event with an i128 amount', () => {
    const value = nativeToScVal(
      { amount: 25_000_000n, merchant, period_secs: 2_592_000n, token: merchant },
      { type: { amount: ['symbol', 'i128'], merchant: ['symbol', 'address'], period_secs: ['symbol', 'u64'], token: ['symbol', 'address'] } },
    );
    const event = decodeEvent({
      id: '1',
      ledger: 1,
      ledgerClosedAt: '2026-01-01T00:00:00Z',
      topic: [nativeToScVal('plan_new', { type: 'symbol' }), nativeToScVal(1n, { type: 'u64' })],
      value,
    });
    expect(event).toMatchObject({ type: 'plan_new', planId: 1n, amount: 25_000_000n, periodSecs: 2_592_000n, merchant });
  });
});

describe('toJson', () => {
  it('turns bigints into strings', () => {
    expect(toJson({ a: 1n, b: [2n], c: 'x' })).toEqual({ a: '1', b: ['2'], c: 'x' });
  });
});
