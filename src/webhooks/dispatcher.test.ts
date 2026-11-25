import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '../db/pool.js';
import { nextDeliveryState, WebhookDispatcher } from './dispatcher.js';
import { verifySignature } from './signature.js';

describe('nextDeliveryState', () => {
  const opts = { maxAttempts: 3, retryBaseMs: 1_000 };

  it('succeeds on a 2xx', () => {
    expect(nextDeliveryState(0, { ok: true }, opts)).toEqual({ status: 'succeeded', attempts: 1 });
  });

  it('retries with a growing delay', () => {
    const first = nextDeliveryState(0, { ok: false }, opts);
    const second = nextDeliveryState(1, { ok: false }, opts);
    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    if (first.status === 'failed' && second.status === 'failed') {
      expect(first.retryInMs).toBeGreaterThanOrEqual(500);
      expect(second.retryInMs).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('gives up after maxAttempts', () => {
    expect(nextDeliveryState(2, { ok: false }, opts)).toEqual({ status: 'dead', attempts: 3 });
  });

  it('gives up straight away on a permanent failure', () => {
    expect(nextDeliveryState(0, { ok: false, permanent: true }, opts)).toEqual({ status: 'dead', attempts: 1 });
  });
});

describe('WebhookDispatcher.send', () => {
  const delivery = {
    id: '77',
    event_id: 'e1',
    event_type: 'subscription.charged',
    payload: { id: 'e1', type: 'subscription.charged' },
    attempts: 0,
    url: 'https://hooks.example.com/in',
    secret: 'whsec_abc',
  };
  const make = (fetchImpl: typeof fetch) =>
    new WebhookDispatcher({} as Pool, {
      timeoutMs: 1_000,
      maxAttempts: 5,
      allowPrivateTargets: false,
      fetch: fetchImpl,
      resolve: async () => ['93.184.216.34'],
    }, pino({ level: 'silent' }));

  it('posts a signed body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await make(fetchMock as unknown as typeof fetch).send(delivery);
    expect(result).toEqual({ ok: true, statusCode: 204 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['LumenSub-Event']).toBe('subscription.charged');
    expect(verifySignature('whsec_abc', headers['LumenSub-Signature']!, init.body as string)).toBe(true);
    expect(init.redirect).toBe('manual');
  });

  it('treats a 500 as a failure', async () => {
    const result = await make((async () => new Response('', { status: 500 })) as typeof fetch).send(delivery);
    expect(result).toEqual({ ok: false, statusCode: 500 });
  });

  it('marks unsafe targets as permanent failures without calling fetch', async () => {
    const fetchMock = vi.fn();
    const result = await make(fetchMock as unknown as typeof fetch).send({ ...delivery, url: 'https://10.0.0.1/' });
    expect(result.permanent).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
