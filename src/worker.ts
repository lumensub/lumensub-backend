import { Keypair } from '@stellar/stellar-sdk';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { Indexer } from './indexer/indexer.js';
import { createLogger } from './logger.js';
import { LogNotifier } from './notifications/notifier.js';
import { Keeper } from './scheduler/keeper.js';
import { LeaderLock } from './scheduler/leader.js';
import { SorobanChain } from './stellar/chain.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';

// The background process: indexer, webhook dispatcher and (optionally) keeper.
// Run one or more of these next to the API. Only one keeper is active at a time.

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, 5);

const chain = new SorobanChain({
  rpcUrl: config.STELLAR_RPC_URL,
  networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  contractId: config.SUBSCRIPTION_CONTRACT_ID,
});

const indexer = new Indexer(
  pool,
  chain,
  {
    startLedger: config.INDEXER_START_LEDGER,
    pageSize: config.INDEXER_PAGE_SIZE,
    pollIntervalMs: config.INDEXER_POLL_INTERVAL_MS,
  },
  log.child({ component: 'indexer' }),
  new LogNotifier(log.child({ component: 'notifications' })),
);

const dispatcher = new WebhookDispatcher(
  pool,
  {
    timeoutMs: config.WEBHOOK_TIMEOUT_MS,
    maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
    allowPrivateTargets: config.WEBHOOK_ALLOW_PRIVATE_TARGETS,
  },
  log.child({ component: 'webhooks' }),
);

const keeper =
  config.KEEPER_ENABLED && config.KEEPER_SECRET
    ? new Keeper(
        pool,
        chain,
        Keypair.fromSecret(config.KEEPER_SECRET),
        { intervalMs: config.KEEPER_INTERVAL_MS, batchSize: config.KEEPER_BATCH_SIZE },
        log.child({ component: 'keeper' }),
        new LeaderLock(pool),
      )
    : null;

const loops = [indexer.run(), dispatcher.run(), ...(keeper ? [keeper.run()] : [])];
if (!keeper) log.info('keeper disabled (KEEPER_ENABLED=false)');

const shutdown = async (signal: string) => {
  log.info({ signal }, 'stopping worker');
  indexer.stop();
  dispatcher.stop();
  keeper?.stop();
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await Promise.allSettled(loops);
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
