import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { notFound, parse } from '../errors.js';

const idParams = z.object({ id: z.string().regex(/^\d+$/) });
const addressParams = z.object({ address: z.string().regex(/^G[A-Z2-7]{55}$/) });

/**
 * Read-only routes for the checkout page and the subscriber portal. Everything
 * here is already public on chain; we just serve it faster than an RPC can.
 */
export const publicRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/plans/:id', { schema: { tags: ['public'], summary: 'Plan details for a checkout page' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT p.id, p.token, p.amount, p.period_secs, p.trial_secs, p.max_cycles, p.active, p.name,
              p.merchant_address, m.display_name AS merchant_name
       FROM plans p LEFT JOIN merchants m ON m.address = p.merchant_address WHERE p.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('plan');
    return rows[0];
  });

  app.get(
    '/subscribers/:address/subscriptions',
    { schema: { tags: ['public'], summary: "A wallet's subscriptions, for the subscriber portal" } },
    async (req) => {
      const { address } = parse(addressParams, req.params);
      const { rows } = await db.query(
        `SELECT s.id, s.plan_id, s.status, s.cycles_charged, s.next_charge_at, s.created_at,
                p.token, p.amount, p.period_secs, p.name AS plan_name,
                p.merchant_address, m.display_name AS merchant_name
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id LEFT JOIN merchants m ON m.address = p.merchant_address
         WHERE s.subscriber = $1 ORDER BY s.id DESC LIMIT 200`,
        [address],
      );
      return { data: rows };
    },
  );
};
