import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { parse } from '../errors.js';
import { page, pageQuery } from '../pagination.js';

const listQuery = pageQuery.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const chargeRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/charges', { schema: { tags: ['charges'], summary: 'Successful charges across all plans, newest first' } }, async (req) => {
    const q = parse(listQuery, req.query);
    const { rows } = await db.query<{ id: string }>(
      `SELECT c.id, c.subscription_id, s.plan_id, p.token, c.cycle, c.amount, c.fee, c.keeper_reward,
              c.ledger, c.tx_hash, c.charged_at
       FROM charges c JOIN subscriptions s ON s.id = c.subscription_id JOIN plans p ON p.id = s.plan_id
       WHERE p.merchant_address = $1
         AND ($2::timestamptz IS NULL OR c.charged_at >= $2)
         AND ($3::timestamptz IS NULL OR c.charged_at < $3)
         AND ($4::bigint IS NULL OR c.id < $4)
       ORDER BY c.id DESC LIMIT $5`,
      [req.merchant, q.from ?? null, q.to ?? null, q.cursor ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  });

  app.get('/refunds', { schema: { tags: ['charges'], summary: 'Refunds issued, newest first' } }, async (req) => {
    const q = parse(pageQuery, req.query);
    const { rows } = await db.query<{ id: string }>(
      `SELECT r.id, r.subscription_id, p.token, r.amount, r.ledger, r.refunded_at
       FROM refunds r JOIN subscriptions s ON s.id = r.subscription_id JOIN plans p ON p.id = s.plan_id
       WHERE p.merchant_address = $1 AND ($2::bigint IS NULL OR r.id < $2)
       ORDER BY r.id DESC LIMIT $3`,
      [req.merchant, q.cursor ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  });
};
