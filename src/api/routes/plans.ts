import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { notFound, parse } from '../errors.js';

const idParams = z.object({ id: z.string().regex(/^\d+$/) });
const listQuery = z.object({ active: z.enum(['true', 'false']).optional() });
const patchBody = z.object({ name: z.string().trim().min(1).max(80).nullable() });

const PLAN_COLUMNS = `p.id, p.token, p.amount, p.period_secs, p.trial_secs, p.max_cycles, p.grace_secs,
  p.active, p.name, p.created_ledger, p.created_at`;

export const planRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/plans', { schema: { tags: ['plans'], summary: "List the merchant's plans" } }, async (req) => {
    const q = parse(listQuery, req.query);
    const { rows } = await db.query(
      `SELECT ${PLAN_COLUMNS},
              COUNT(s.id) FILTER (WHERE s.status IN ('trialing', 'active', 'past_due')) AS live_subscriptions
       FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id
       WHERE p.merchant_address = $1 AND ($2::boolean IS NULL OR p.active = $2)
       GROUP BY p.id ORDER BY p.id DESC`,
      [req.merchant, q.active === undefined ? null : q.active === 'true'],
    );
    return { data: rows };
  });

  app.get('/plans/:id', { schema: { tags: ['plans'], summary: 'Get one plan' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(`SELECT ${PLAN_COLUMNS} FROM plans p WHERE p.id = $1 AND p.merchant_address = $2`, [
      id,
      req.merchant,
    ]);
    if (!rows[0]) throw notFound('plan');
    return rows[0];
  });

  // Plans are created on chain. The API only stores a display name next to them.
  app.patch('/plans/:id', { schema: { tags: ['plans'], summary: 'Set the display name of a plan' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(patchBody, req.body);
    const { rows } = await db.query(
      `UPDATE plans p SET name = $3 WHERE p.id = $1 AND p.merchant_address = $2 RETURNING ${PLAN_COLUMNS}`,
      [id, req.merchant, body.name],
    );
    if (!rows[0]) throw notFound('plan');
    return rows[0];
  });
};
