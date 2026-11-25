import type { Queryable } from '../db/pool.js';
import type { DomainEvent } from '../stellar/events.js';
import { buildPayload, endpointWants } from './payload.js';

/**
 * Creates one pending delivery per matching endpoint of the merchant. Runs in the
 * same transaction as the indexer, so an event is never applied without its
 * webhooks being queued, or the other way round.
 */
export async function enqueueWebhooks(db: Queryable, merchant: string, event: DomainEvent): Promise<number> {
  const payload = buildPayload(event);
  const { rows } = await db.query<{ id: string; events: string[] }>(
    'SELECT id, events FROM webhook_endpoints WHERE merchant_address = $1 AND active',
    [merchant],
  );
  let queued = 0;
  for (const endpoint of rows) {
    if (!endpointWants(endpoint.events, payload.type)) continue;
    const res = await db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4) ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [endpoint.id, payload.id, payload.type, JSON.stringify(payload)],
    );
    queued += res.rowCount ?? 0;
  }
  return queued;
}
