import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { notFound, parse } from '../errors.js';

const patchBody = z.object({ display_name: z.string().trim().min(1).max(80).nullable() });

export const merchantRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/merchant', { schema: { tags: ['merchant'], summary: 'The merchant this API key belongs to' } }, async (req) => {
    const { rows } = await db.query(
      `SELECT address, payout_address, display_name, created_at,
              (SELECT COUNT(*) FROM plans WHERE merchant_address = m.address) AS plan_count
       FROM merchants m WHERE address = $1`,
      [req.merchant],
    );
    if (!rows[0]) throw notFound('merchant');
    return rows[0];
  });

  app.patch('/merchant', { schema: { tags: ['merchant'], summary: 'Update display details' } }, async (req) => {
    const body = parse(patchBody, req.body);
    const { rows } = await db.query(
      'UPDATE merchants SET display_name = $2 WHERE address = $1 RETURNING address, payout_address, display_name, created_at',
      [req.merchant, body.display_name],
    );
    return rows[0];
  });
};
