import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeDb } from '../../test/fake-db.js';
import { generateApiKey, hashApiKey } from './keys.js';
import { buildServer } from './server.js';
import type { ReadinessReport } from './routes/health.js';

const { key } = generateApiKey();
const MERCHANT = 'G' + 'M'.repeat(55);

type Respond = Parameters<typeof fakeDb>[0];

function withAuth(respond: Respond = () => undefined): Respond {
  return (sql, params) => {
    if (sql.startsWith('UPDATE api_keys SET last_used_at')) {
      return params[0] === hashApiKey(key) ? { rows: [{ merchant_address: MERCHANT }] } : { rows: [] };
    }
    return respond?.(sql, params);
  };
}

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(respond?: Respond, readiness?: ReadinessReport) {
  const db = fakeDb(withAuth(respond));
  app = await buildServer({
    db,
    log: pino({ level: 'silent' }),
    readiness: async () => readiness ?? { latestLedger: 100, indexedLedger: 99, lastPollAt: new Date() },
    rateLimit: { max: 1000, timeWindow: '1 minute' },
    webhooks: { allowPrivateTargets: false, resolve: async () => ['93.184.216.34'] },
    docsUi: false,
    corsOrigins: ['http://localhost:3000'],
  });
  return { app, db };
}

const auth = { authorization: `Bearer ${key}` };

describe('CORS', () => {
  it('lets the configured app origin call the API from a browser', async () => {
    const { app } = await make();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/plans',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(String(preflight.headers['access-control-allow-headers'])).toMatch(/Authorization/);
  });

  it('gives other origins no CORS headers', async () => {
    const { app } = await make();
    const res = await app.inject({ url: '/health', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API', () => {
  it('answers /health without auth', async () => {
    const { app } = await make();
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports not ready when the indexer lags', async () => {
    const { app } = await make(undefined, { latestLedger: 1_000, indexedLedger: 10, lastPollAt: null });
    const res = await app.inject({ url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.indexer).toMatchObject({ ok: false, lag_ledgers: 990 });
  });

  it('rejects merchant routes without a valid key', async () => {
    const { app } = await make();
    const missing = await app.inject({ url: '/v1/plans' });
    const wrong = await app.inject({ url: '/v1/plans', headers: { authorization: `Bearer ${generateApiKey().key}` } });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: { code: 'unauthorized', message: 'a valid API key is required' } });
  });

  it("scopes plan queries to the key's merchant", async () => {
    const { app, db } = await make((sql) => (sql.includes('FROM plans p LEFT JOIN') ? { rows: [{ id: '1' }] } : undefined));
    const res = await app.inject({ url: '/v1/plans', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [{ id: '1' }] });
    const query = db.queries.find((q) => q.sql.includes('FROM plans p LEFT JOIN'));
    expect(query?.params[0]).toBe(MERCHANT);
  });

  it('returns the error envelope for unknown records and bad input', async () => {
    const { app } = await make(() => ({ rows: [] }));
    const missing = await app.inject({ url: '/v1/subscriptions/42', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const bad = await app.inject({ url: '/v1/subscriptions?status=frozen', headers: auth });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
  });

  it('paginates subscriptions', async () => {
    const rows = [{ id: '30' }, { id: '29' }, { id: '28' }];
    const { app } = await make((sql) => (sql.startsWith('SELECT s.id') ? { rows } : undefined));
    const res = await app.inject({ url: '/v1/subscriptions?limit=2', headers: auth });
    expect(res.json()).toEqual({ data: [{ id: '30' }, { id: '29' }], next_cursor: '29' });
  });

  it('refuses webhook endpoints on private addresses', async () => {
    const { app } = await make();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: auth,
      payload: { url: 'https://127.0.0.1/hook' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('unsafe_url');
  });

  it('returns the signing secret once when an endpoint is created', async () => {
    const { app } = await make((sql) => {
      if (sql.startsWith('SELECT COUNT(*) AS n')) return { rows: [{ n: '0' }] };
      if (sql.startsWith('INSERT INTO webhook_endpoints')) return { rows: [{ id: '1', url: 'https://hooks.example.com/x' }] };
      return undefined;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: auth,
      payload: { url: 'https://hooks.example.com/x', events: ['subscription.charged'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toMatch(/^whsec_/);
  });

  it('serves public plan details without auth', async () => {
    const { app } = await make((sql) => (sql.includes('merchant_name') ? { rows: [{ id: '7', amount: '100' }] } : undefined));
    const res = await app.inject({ url: '/v1/public/plans/7' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: '7', amount: '100' });
  });

  it('publishes an OpenAPI document', async () => {
    const { app } = await make();
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain('/v1/subscriptions');
  });
});
