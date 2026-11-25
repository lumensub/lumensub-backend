import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { merchantSummary, revenueByDay } from '../../analytics/queries.js';
import type { Queryable } from '../../db/pool.js';
import { parse } from '../errors.js';

const revenueQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const analyticsRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get(
    '/analytics/summary',
    { schema: { tags: ['analytics'], summary: 'MRR per token, subscriptions by status, 30-day churn and revenue' } },
    async (req) => merchantSummary(db, req.merchant),
  );

  app.get(
    '/analytics/revenue',
    { schema: { tags: ['analytics'], summary: 'Successful charges per UTC day and token' } },
    async (req) => {
      const { days } = parse(revenueQuery, req.query);
      return { data: await revenueByDay(db, req.merchant, days) };
    },
  );
};
