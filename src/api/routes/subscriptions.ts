import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { SUBSCRIPTION_STATUSES } from '../../stellar/status.js';
import { notFound, parse } from '../errors.js';
import { page, pageQuery } from '../pagination.js';

const idParams = z.object({ id: z.string().regex(/^\d+$/) });
const listQuery = pageQuery.extend({
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  plan_id: z.string().regex(/^\d+$/).optional(),
  subscriber: z.string().regex(/^G[A-Z2-7]{55}$/).optional(),
});

const SUB_COLUMNS = `s.id, s.plan_id, s.subscriber, s.status, s.cycles_charged, s.next_charge_at,
  s.cancelled_by, s.created_ledger, s.created_at, s.updated_at`;

export const subscriptionRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/subscriptions', { schema: { tags: ['subscriptions'], summary: 'List subscriptions, newest first' } }, async (req) => {
    const q = parse(listQuery, req.query);
    const { rows } = await db.query<{ id: string }>(
      `SELECT ${SUB_COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE p.merchant_address = $1
         AND ($2::text IS NULL OR s.status = $2)
         AND ($3::bigint IS NULL OR s.plan_id = $3)
         AND ($4::text IS NULL OR s.subscriber = $4)
         AND ($5::bigint IS NULL OR s.id < $5)
       ORDER BY s.id DESC LIMIT $6`,
      [req.merchant, q.status ?? null, q.plan_id ?? null, q.subscriber ?? null, q.cursor ?? null, q.limit + 1],
    );
    return page(rows, q.limit);
  });

  app.get('/subscriptions/:id', { schema: { tags: ['subscriptions'], summary: 'Get one subscription' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT ${SUB_COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.id = $1 AND p.merchant_address = $2`,
      [id, req.merchant],
    );
    if (!rows[0]) throw notFound('subscription');
    return rows[0];
  });

  app.get('/subscriptions/:id/charges', { schema: { tags: ['subscriptions'], summary: 'Charge history of a subscription' } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const owned = await db.query(
      'SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1 AND p.merchant_address = $2',
      [id, req.merchant],
    );
    if (!owned.rowCount) throw notFound('subscription');
    const charges = await db.query(
      `SELECT id, cycle, amount, fee, keeper_reward, ledger, tx_hash, charged_at
       FROM charges WHERE subscription_id = $1 ORDER BY cycle`,
      [id],
    );
    const failures = await db.query(
      'SELECT id, reason, status, ledger, failed_at FROM charge_failures WHERE subscription_id = $1 ORDER BY id',
      [id],
    );
    return { charges: charges.rows, failures: failures.rows };
  });
};
