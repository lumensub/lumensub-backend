import type { FastifyPluginAsync } from 'fastify';
import { merchantSummary } from '../../analytics/queries.js';
import type { Queryable } from '../../db/pool.js';

export const analyticsRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get(
    '/analytics/summary',
    { schema: { tags: ['analytics'], summary: 'MRR per token, subscriptions by status, 30-day churn and revenue' } },
    async (req) => merchantSummary(db, req.merchant),
  );
};
