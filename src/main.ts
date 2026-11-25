import { rpc } from '@stellar/stellar-sdk';
import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { loadCursor } from './indexer/indexer.js';
import { createLogger } from './logger.js';

// The API process. It reads from Postgres and never writes to the chain.
// The indexer, keeper and webhook dispatcher run in worker.ts.

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL);
const server = new rpc.Server(config.STELLAR_RPC_URL, { allowHttp: config.STELLAR_RPC_URL.startsWith('http://') });

const redis = config.REDIS_URL ? new (await import('ioredis')).Redis(config.REDIS_URL, { lazyConnect: false }) : undefined;

// Cache the chain tip for a few seconds so /ready does not hit the RPC on every probe.
let tip: { ledger: number; at: number } | null = null;
async function latestLedger(): Promise<number | null> {
  if (tip && Date.now() - tip.at < 5_000) return tip.ledger;
  try {
    const latest = await server.getLatestLedger();
    tip = { ledger: latest.sequence, at: Date.now() };
    return tip.ledger;
  } catch {
    return tip?.ledger ?? null;
  }
}

const app = await buildServer({
  db: pool,
  log,
  readiness: async () => {
    const cursor = await loadCursor(pool);
    const { rows } = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM indexer_cursor WHERE id = 1');
    return { latestLedger: await latestLedger(), indexedLedger: cursor?.ledger ?? null, lastPollAt: rows[0]?.updated_at ?? null };
  },
  rateLimit: { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW, redis },
  webhooks: { allowPrivateTargets: config.WEBHOOK_ALLOW_PRIVATE_TARGETS },
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  await pool.end();
  redis?.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
