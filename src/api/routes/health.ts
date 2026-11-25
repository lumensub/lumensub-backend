import type { FastifyPluginAsync } from 'fastify';
import type { Queryable } from '../../db/pool.js';

export interface ReadinessReport {
  /** Ledger the RPC reported on the indexer's last poll. */
  latestLedger: number | null;
  /** Ledger the indexer has fully applied. */
  indexedLedger: number | null;
  lastPollAt: Date | null;
}

export type Readiness = () => Promise<ReadinessReport>;

/** How far behind the indexer may fall before /ready reports not ready. */
export const MAX_LAG_LEDGERS = 120; // about ten minutes of 5 s ledgers

export const healthRoutes: FastifyPluginAsync<{ db: Queryable; readiness: Readiness }> = async (app, { db, readiness }) => {
  // Liveness: the process is up. No dependencies, so it never flaps.
  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  // Readiness: the database answers and the indexer is close to the chain tip.
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    let database = true;
    try {
      await db.query('SELECT 1');
    } catch {
      database = false;
    }
    const report = await readiness().catch(() => null);
    const lag =
      report?.latestLedger != null && report.indexedLedger != null ? report.latestLedger - report.indexedLedger : null;
    const indexer = lag !== null && lag <= MAX_LAG_LEDGERS;
    const ready = database && indexer;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database,
        indexer: { ok: indexer, lag_ledgers: lag, last_poll_at: report?.lastPollAt?.toISOString() ?? null },
      },
    });
  });
};
