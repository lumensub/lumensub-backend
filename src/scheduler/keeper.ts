import type { Keypair } from '@stellar/stellar-sdk';
import type { Queryable } from '../db/pool.js';
import { backoffDelay, sleep } from '../lib/backoff.js';
import type { Logger } from '../logger.js';
import type { SubscriptionChain } from '../stellar/chain.js';
import { CHARGEABLE_STATUSES } from '../stellar/status.js';
import type { LeaderLock } from './leader.js';

export interface KeeperOptions {
  intervalMs: number;
  batchSize: number;
  /** First retry delay after a failed charge. Grows exponentially per failure. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface KeeperTickResult {
  checked: number;
  submitted: number;
  notDue: number;
  failed: number;
}

interface DueRow {
  id: string;
  keeper_failures: number;
}

export function keeperRetryDelay(failures: number, opts: Pick<KeeperOptions, 'retryBaseMs' | 'retryMaxMs'> = {}): number {
  return backoffDelay(Math.max(1, failures), {
    baseMs: opts.retryBaseMs ?? 60_000,
    maxMs: opts.retryMaxMs ?? 6 * 3_600_000,
  });
}

/**
 * Submits charge() for subscriptions the read model says are due. The chain is the
 * source of truth: we ask is_due() first, because the indexer can lag a few ledgers
 * behind and charging a subscription that is not due wastes fees.
 *
 * Results are not written back here. The charged / chg_fail events come back
 * through the indexer like any other event.
 */
export class Keeper {
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(
    private readonly db: Queryable,
    private readonly chain: SubscriptionChain,
    private readonly keeper: Keypair,
    private readonly opts: KeeperOptions,
    private readonly log: Logger,
    private readonly leader?: LeaderLock,
  ) {}

  async dueSubscriptions(now: Date = new Date()): Promise<DueRow[]> {
    const { rows } = await this.db.query<DueRow>(
      `SELECT id, keeper_failures FROM subscriptions
       WHERE status = ANY($1) AND next_charge_at <= $2
         AND (keeper_retry_at IS NULL OR keeper_retry_at <= $2)
       ORDER BY next_charge_at
       LIMIT $3`,
      [CHARGEABLE_STATUSES, now, this.opts.batchSize],
    );
    return rows;
  }

  private async record(subId: string, attempt: number, outcome: string, txHash: string | null, error: string | null) {
    await this.db.query(
      `INSERT INTO keeper_attempts (subscription_id, attempt, outcome, tx_hash, error) VALUES ($1, $2, $3, $4, $5)`,
      [subId, attempt, outcome, txHash, error],
    );
  }

  private async backOff(subId: string, failures: number) {
    const delayMs = keeperRetryDelay(failures, this.opts);
    await this.db.query(
      `UPDATE subscriptions SET keeper_failures = $2, keeper_retry_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1`,
      [subId, failures, String(delayMs)],
    );
    return delayMs;
  }

  async tick(now: Date = new Date()): Promise<KeeperTickResult> {
    const result: KeeperTickResult = { checked: 0, submitted: 0, notDue: 0, failed: 0 };
    for (const row of await this.dueSubscriptions(now)) {
      if (this.stopped) break;
      result.checked++;
      const subId = BigInt(row.id);
      const attempt = row.keeper_failures + 1;
      try {
        if (!(await this.chain.isDue(subId))) {
          // The read model is behind. Check again after one interval.
          result.notDue++;
          await this.record(row.id, attempt, 'not_due', null, null);
          await this.db.query(
            `UPDATE subscriptions SET keeper_retry_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, String(this.opts.intervalMs)],
          );
          continue;
        }
        const charge = await this.chain.charge(this.keeper, subId);
        if (charge.ok) {
          result.submitted++;
          await this.record(row.id, attempt, 'submitted', charge.txHash, null);
          // Hold off until the indexer has seen the charged event and moved next_charge_at.
          await this.db.query(
            `UPDATE subscriptions SET keeper_retry_at = now() + ($2 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, String(this.opts.intervalMs * 4)],
          );
        } else {
          result.failed++;
          await this.record(row.id, attempt, 'failed', charge.txHash, charge.error ?? null);
          const retryInMs = await this.backOff(row.id, attempt);
          this.log.warn({ subId: row.id, attempt, error: charge.error, retryInMs }, 'charge failed');
        }
      } catch (err) {
        result.failed++;
        const message = (err as Error).message;
        await this.record(row.id, attempt, 'failed', null, message);
        const retryInMs = await this.backOff(row.id, attempt);
        this.log.warn({ subId: row.id, attempt, err: message, retryInMs }, 'charge errored');
      }
    }
    return result;
  }

  async run(): Promise<void> {
    this.log.info({ keeper: this.keeper.publicKey() }, 'keeper started');
    while (!this.stopped) {
      try {
        if (this.leader && !(await this.leader.acquire())) {
          this.log.debug('another keeper holds the lock; standing by');
        } else {
          const result = await this.tick();
          if (result.checked > 0) this.log.info(result, 'keeper tick');
        }
      } catch (err) {
        this.log.error({ err }, 'keeper tick failed');
      }
      await sleep(this.opts.intervalMs, this.controller.signal);
    }
    await this.leader?.release();
    this.log.info('keeper stopped');
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
