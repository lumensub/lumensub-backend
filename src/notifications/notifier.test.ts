import { describe, expect, it, vi } from 'vitest';
import { EmailNotifier, notificationFor } from './notifier.js';

const meta = { id: 'e', ledger: 1, ledgerTime: new Date(0), txHash: null };

describe('notificationFor', () => {
  it('notifies on failed charges and cancellations', () => {
    expect(
      notificationFor({ ...meta, type: 'chg_fail', subId: 5n, reason: 'allowance', status: 'past_due' }, 'GM'),
    ).toMatchObject({ kind: 'charge_failed', subscriptionId: '5', text: expect.stringContaining('past due') });
    expect(notificationFor({ ...meta, type: 'cancelled', subId: 6n, by: 'GSUB' }, 'GM')?.kind).toBe(
      'subscription_cancelled',
    );
  });

  it('stays quiet for routine events', () => {
    expect(notificationFor({ ...meta, type: 'paused', subId: 1n }, 'GM')).toBeNull();
  });
});

describe('EmailNotifier', () => {
  it('skips merchants without an address', async () => {
    const transport = vi.fn(async () => undefined);
    const notifier = new EmailNotifier(transport, async (m) => (m === 'GM' ? 'ops@example.com' : null));
    const base = { kind: 'charge_failed' as const, subscriptionId: '1', subject: 's', text: 't' };
    await notifier.send({ ...base, merchant: 'GOTHER' });
    await notifier.send({ ...base, merchant: 'GM' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith({ to: 'ops@example.com', subject: 's', text: 't' });
  });
});
