import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { ALL_WEBHOOK_EVENT_TYPES } from '../../webhooks/payload.js';
import { generateSecret } from '../../webhooks/signature.js';
import { assertPublicUrl, UnsafeWebhookTargetError, type Resolver } from '../../webhooks/ssrf.js';
import { ApiError, notFound, parse } from '../errors.js';

const MAX_ENDPOINTS = 10;

const createBody = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]])).max(20).default([]),
});
const idParams = z.object({ id: z.string().regex(/^\d+$/) });
const deliveryParams = idParams.extend({ deliveryId: z.string().regex(/^\d+$/) });

interface Options {
  db: Queryable;
  allowPrivateTargets: boolean;
  resolve?: Resolver;
}

export const webhookEndpointRoutes: FastifyPluginAsync<Options> = async (app, { db, allowPrivateTargets, resolve }) => {
  app.get('/webhook-endpoints', { schema: { tags: ['webhooks'], summary: 'List webhook endpoints' } }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at FROM webhook_endpoints
       WHERE merchant_address = $1 ORDER BY id`,
      [req.merchant],
    );
    return { data: rows };
  });

  app.post('/webhook-endpoints', { schema: { tags: ['webhooks'], summary: 'Add an endpoint. The signing secret is only returned here.' } }, async (req, reply) => {
    const body = parse(createBody, req.body);
    try {
      await assertPublicUrl(body.url, { allowPrivate: allowPrivateTargets, resolve });
    } catch (err) {
      if (err instanceof UnsafeWebhookTargetError) throw new ApiError(422, 'unsafe_url', err.message);
      throw err;
    }
    const count = await db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM webhook_endpoints WHERE merchant_address = $1 AND active',
      [req.merchant],
    );
    if (Number(count.rows[0]?.n ?? 0) >= MAX_ENDPOINTS) {
      throw new ApiError(409, 'limit_reached', `a merchant can have at most ${MAX_ENDPOINTS} active endpoints`);
    }
    const secret = generateSecret();
    const { rows } = await db.query(
      `INSERT INTO webhook_endpoints (merchant_address, url, secret, events)
       VALUES ($1, $2, $3, $4) RETURNING id, url, events, active, created_at`,
      [req.merchant, body.url, secret, body.events],
    );
    return reply.status(201).send({ ...rows[0], secret });
  });

  app.delete('/webhook-endpoints/:id', { schema: { tags: ['webhooks'], summary: 'Disable an endpoint' } }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { rowCount } = await db.query(
      'UPDATE webhook_endpoints SET active = false WHERE id = $1 AND merchant_address = $2 AND active',
      [id, req.merchant],
    );
    if (!rowCount) throw notFound('webhook endpoint');
    return reply.status(204).send();
  });

  app.get('/webhook-endpoints/:id/deliveries', { schema: { tags: ['webhooks'], summary: 'Recent deliveries to an endpoint' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT d.id, d.event_id, d.event_type, d.status, d.attempts, d.next_attempt_at,
              d.last_status_code, d.last_error, d.created_at, d.updated_at
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE e.id = $1 AND e.merchant_address = $2 ORDER BY d.id DESC LIMIT 100`,
      [id, req.merchant],
    );
    return { data: rows };
  });

  app.post(
    '/webhook-endpoints/:id/deliveries/:deliveryId/retry',
    { schema: { tags: ['webhooks'], summary: 'Send a failed or dead delivery again now' } },
    async (req, reply) => {
      const { id, deliveryId } = parse(deliveryParams, req.params);
      const { rowCount } = await db.query(
        `UPDATE webhook_deliveries d SET status = 'pending', next_attempt_at = now(), updated_at = now()
         FROM webhook_endpoints e
         WHERE d.id = $1 AND d.endpoint_id = e.id AND e.id = $2 AND e.merchant_address = $3
           AND d.status IN ('failed', 'dead')`,
        [deliveryId, id, req.merchant],
      );
      if (!rowCount) throw notFound('retryable delivery');
      return reply.status(202).send({ status: 'queued' });
    },
  );
};
