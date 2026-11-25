import { describe, expect, it } from 'vitest';
import { fakeDb } from '../../test/fake-db.js';
import { enqueueWebhooks } from './enqueue.js';

describe('enqueueWebhooks', () => {
  it('queues a delivery only for endpoints that want the event', async () => {
    const db = fakeDb((sql) =>
      sql.startsWith('SELECT id, events FROM webhook_endpoints')
        ? {
            rows: [
              { id: '1', events: [] },
              { id: '2', events: ['subscription.cancelled'] },
              { id: '3', events: ['subscription.paused'] },
            ],
          }
        : undefined,
    );
    const queued = await enqueueWebhooks(db, 'GM', {
      id: 'e9',
      ledger: 1,
      ledgerTime: new Date(0),
      txHash: null,
      type: 'paused',
      subId: 4n,
    });
    expect(queued).toBe(2);
    const inserts = db.queries.filter((q) => q.sql.startsWith('INSERT INTO webhook_deliveries'));
    expect(inserts.map((q) => q.params[0])).toEqual(['1', '3']);
    expect(JSON.parse(inserts[0]!.params[3] as string)).toMatchObject({ type: 'subscription.paused', data: { sub_id: '4' } });
  });
});
