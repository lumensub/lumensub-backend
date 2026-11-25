import { scValToNative } from '@stellar/stellar-sdk';
import type { Logger } from '../logger.js';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { backoffDelay, sleep } from '../lib/backoff.js';
import type { SubscriptionChain } from '../stellar/chain.js';
import { decodeEvent, EventDecodeError, toJson, type DomainEvent, type RawContractEvent } from '../stellar/events.js';
import { enqueueWebhooks } from '../webhooks/enqueue.js';
import { applyEvent, type Enrichment } from './apply.js';
import { advanceCursor, startLedger, unseenEvents, type Cursor } from './cursor.js';

export interface IndexerOptions {
  startLedger: number;
  pageSize: number;
  pollIntervalMs: number;
}

export async function loadCursor(db: Queryable): Promise<Cursor | null> {
  const { rows } = await db.query<{ ledger: string; last_event_id: string | null }>(
    'SELECT ledger, last_event_id FROM indexer_cursor WHERE id = 1',
  );
  const row = rows[0];
  return row ? { ledger: Number(row.ledger), lastEventId: row.last_event_id } : null;
}

async function saveCursor(db: Queryable, cursor: Cursor): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor (id, ledger, last_event_id, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET ledger = EXCLUDED.ledger, last_event_id = EXCLUDED.last_event_id, updated_at = now()`,
    [cursor.ledger, cursor.lastEventId],
  );
}

function topicName(raw: RawContractEvent): string | null {
  try {
    const first = raw.topic[0];
    const value = first ? scValToNative(first) : null;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function deadLetter(db: Queryable, raw: RawContractEvent, error: string): Promise<void> {
  await db.query(
    `INSERT INTO dead_letter_events (id, ledger, topic, payload, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET attempts = dead_letter_events.attempts + 1, error = EXCLUDED.error, last_seen = now()`,
    [
      raw.id,
      raw.ledger,
      topicName(raw),
      JSON.stringify({ topic: raw.topic.map((t) => t.toXDR('base64')), value: raw.value.toXDR('base64') }),
      error,
    ],
  );
}

export class Indexer {
  private stopped = false;
  private readonly controller = new AbortController();
  /** Ledger the RPC reported on the last successful poll, for /ready. */
  lastSeenLedger: number | null = null;
  lastPollAt: Date | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly chain: SubscriptionChain,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
  ) {}

  /** Fetches the on-chain state some events need, before opening a transaction. */
  private async enrich(db: Queryable, event: DomainEvent): Promise<Enrichment> {
    const extra: Enrichment = {};
    const ensurePlan = async (planId: bigint) => {
      const { rowCount } = await db.query('SELECT 1 FROM plans WHERE id = $1', [planId.toString()]);
      if (rowCount) return;
      const plan = await this.chain.getPlan(planId);
      if (plan) extra.plan = { ...plan, id: planId };
    };

    switch (event.type) {
      case 'plan_new': {
        const plan = await this.chain.getPlan(event.planId);
        if (plan) extra.plan = { ...plan, id: event.planId };
        break;
      }
      case 'sub_new':
        await ensurePlan(event.planId);
        extra.subscription = (await this.chain.getSubscription(event.subId)) ?? undefined;
        break;
      case 'plan_chg':
        await ensurePlan(event.toPlan);
        break;
      case 'resumed':
        extra.subscription = (await this.chain.getSubscription(event.subId)) ?? undefined;
        break;
      default:
        break;
    }
    return extra;
  }

  /** Reads one page of events and applies it. Returns how many events were applied. */
  async pollOnce(): Promise<number> {
    const cursor = await loadCursor(this.pool);
    const oldest = await this.chain.oldestLedger();
    const start = startLedger(cursor, this.opts.startLedger, oldest);
    if (start.gap) {
      this.log.warn({ cursorLedger: cursor?.ledger, oldest }, 'RPC no longer has the cursor ledger; some events were missed');
    }

    const page = await this.chain.getEvents(start.ledger, this.opts.pageSize);
    this.lastSeenLedger = page.latestLedger;
    this.lastPollAt = new Date();

    // When the cursor ledger was dropped by the RPC, start over inside the new range.
    const effective = start.gap ? null : cursor;
    const fresh = unseenEvents(page.events, effective);
    const fullPage = page.events.length >= this.opts.pageSize;

    let applied = 0;
    let next = effective;
    for (const raw of fresh) {
      let event: DomainEvent | null;
      try {
        event = decodeEvent(raw);
      } catch (err) {
        const message = err instanceof EventDecodeError ? err.message : String(err);
        this.log.error({ eventId: raw.id, err: message }, 'could not decode event; moved to dead letters');
        await withTransaction(this.pool, async (tx) => {
          await deadLetter(tx, raw, message);
          next = advanceCursor(next, [raw]);
          if (next) await saveCursor(tx, next);
        });
        continue;
      }

      const extra = event ? await this.enrich(this.pool, event) : {};
      await withTransaction(this.pool, async (tx) => {
        if (event) {
          const result = await applyEvent(tx, event, extra);
          if (result.applied) {
            applied++;
            if (result.merchant) await enqueueWebhooks(tx, result.merchant, event);
            this.log.debug({ eventId: event.id, type: event.type, data: toJson(event) }, 'applied event');
          }
        }
        next = advanceCursor(next, [raw]);
        if (next) await saveCursor(tx, next);
      });
    }

    // A page shorter than the limit means everything up to latestLedger has been
    // read, so the cursor can jump there. A full page may have been cut off.
    if (!fullPage) {
      const skipped = advanceCursor(next, [], page.latestLedger);
      if (skipped && skipped !== next) await saveCursor(this.pool, skipped);
    }
    return applied;
  }

  async run(): Promise<void> {
    let failures = 0;
    this.log.info('indexer started');
    while (!this.stopped) {
      try {
        const applied = await this.pollOnce();
        failures = 0;
        if (applied > 0) this.log.info({ applied }, 'indexed events');
        await sleep(this.opts.pollIntervalMs, this.controller.signal);
      } catch (err) {
        failures++;
        const delay = backoffDelay(failures, { baseMs: this.opts.pollIntervalMs, maxMs: 5 * 60_000 });
        this.log.error({ err, failures, retryInMs: delay }, 'indexer poll failed');
        await sleep(delay, this.controller.signal);
      }
    }
    this.log.info('indexer stopped');
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
