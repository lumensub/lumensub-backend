import type { Pool } from '../db/pool.js';
import { backoffDelay, sleep } from '../lib/backoff.js';
import type { Logger } from '../logger.js';
import { SIGNATURE_HEADER, signatureHeader } from './signature.js';
import { assertPublicUrl, UnsafeWebhookTargetError, type Resolver } from './ssrf.js';

export interface DispatcherOptions {
  timeoutMs: number;
  maxAttempts: number;
  allowPrivateTargets: boolean;
  batchSize?: number;
  idleMs?: number;
  /** Base delay between attempts. Attempt n waits about base * 2^(n-1). */
  retryBaseMs?: number;
  fetch?: typeof fetch;
  resolve?: Resolver;
}

export type DeliveryOutcome =
  | { status: 'succeeded'; attempts: number }
  | { status: 'failed'; attempts: number; retryInMs: number }
  | { status: 'dead'; attempts: number };

/**
 * What happens to a delivery after an attempt. A 2xx is success. Anything else is
 * retried with backoff until maxAttempts, then the delivery is marked dead. An
 * unsafe target is dead straight away: retrying will not make it safe.
 */
export function nextDeliveryState(
  previousAttempts: number,
  result: { ok: boolean; permanent?: boolean },
  { maxAttempts, retryBaseMs = 30_000 }: { maxAttempts: number; retryBaseMs?: number },
): DeliveryOutcome {
  const attempts = previousAttempts + 1;
  if (result.ok) return { status: 'succeeded', attempts };
  if (result.permanent || attempts >= maxAttempts) return { status: 'dead', attempts };
  return { status: 'failed', attempts, retryInMs: backoffDelay(attempts, { baseMs: retryBaseMs, maxMs: 6 * 3_600_000 }) };
}

interface DueDelivery {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

export class WebhookDispatcher {
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(
    private readonly pool: Pool,
    private readonly opts: DispatcherOptions,
    private readonly log: Logger,
  ) {}

  /** Sends one delivery. Returns whether the endpoint accepted it. */
  async send(d: DueDelivery): Promise<{ ok: boolean; permanent?: boolean; statusCode?: number; error?: string }> {
    try {
      await assertPublicUrl(d.url, { allowPrivate: this.opts.allowPrivateTargets, resolve: this.opts.resolve });
    } catch (err) {
      if (err instanceof UnsafeWebhookTargetError) return { ok: false, permanent: true, error: err.message };
      throw err;
    }

    const body = JSON.stringify(d.payload);
    const doFetch = this.opts.fetch ?? fetch;
    try {
      const res = await doFetch(d.url, {
        method: 'POST',
        redirect: 'manual', // a redirect could point somewhere we just refused to call
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LumenSub-Webhooks/1',
          [SIGNATURE_HEADER]: signatureHeader(d.secret, body),
          'LumenSub-Event': d.event_type,
          'LumenSub-Delivery': d.id,
        },
        body,
      });
      return { ok: res.status >= 200 && res.status < 300, statusCode: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Claims a batch of due deliveries and attempts each one. Returns the batch size. */
  async tick(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // SKIP LOCKED lets several workers share the queue without sending twice.
      const { rows } = await client.query<DueDelivery>(
        `SELECT d.id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at <= now() AND e.active
         ORDER BY d.next_attempt_at
         LIMIT $1
         FOR UPDATE OF d SKIP LOCKED`,
        [this.opts.batchSize ?? 25],
      );

      for (const d of rows) {
        const result = await this.send(d);
        const next = nextDeliveryState(d.attempts, result, {
          maxAttempts: this.opts.maxAttempts,
          retryBaseMs: this.opts.retryBaseMs,
        });
        await client.query(
          `UPDATE webhook_deliveries SET
             status = $2, attempts = $3,
             next_attempt_at = now() + $4::bigint * interval '1 millisecond',
             last_status_code = $5, last_error = $6, updated_at = now()
           WHERE id = $1`,
          [
            d.id,
            next.status,
            next.attempts,
            next.status === 'failed' ? String(next.retryInMs) : '0',
            result.statusCode ?? null,
            result.error ?? null,
          ],
        );
        const level = next.status === 'dead' ? 'warn' : 'debug';
        this.log[level]({ deliveryId: d.id, eventType: d.event_type, ...next, statusCode: result.statusCode }, 'webhook attempt');
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async run(): Promise<void> {
    this.log.info('webhook dispatcher started');
    let failures = 0;
    while (!this.stopped) {
      try {
        const handled = await this.tick();
        failures = 0;
        if (handled === 0) await sleep(this.opts.idleMs ?? 2_000, this.controller.signal);
      } catch (err) {
        failures++;
        this.log.error({ err }, 'webhook dispatcher tick failed');
        await sleep(backoffDelay(failures, { baseMs: 1_000, maxMs: 60_000 }), this.controller.signal);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
