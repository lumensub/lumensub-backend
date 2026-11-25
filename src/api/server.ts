import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Queryable } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { Resolver } from '../webhooks/ssrf.js';
import { ApiError, sendError, unauthorized } from './errors.js';
import { extractApiKey, hashApiKey, merchantForKey } from './keys.js';
import { analyticsRoutes } from './routes/analytics.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { chargeRoutes } from './routes/charges.js';
import { healthRoutes, type Readiness } from './routes/health.js';
import { merchantRoutes } from './routes/merchant.js';
import { planRoutes } from './routes/plans.js';
import { publicRoutes } from './routes/public.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { webhookEndpointRoutes } from './routes/webhook-endpoints.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on every /v1 merchant route. */
    merchant: string;
  }
}

export interface ApiDeps {
  db: Queryable;
  log: Logger;
  readiness: Readiness;
  rateLimit: { max: number; timeWindow: string; redis?: Redis };
  webhooks: { allowPrivateTargets: boolean; resolve?: Resolver };
  /** Turn off the Swagger UI, e.g. in tests. The JSON spec stays available. */
  docsUi?: boolean;
  /**
   * Browser origins allowed to call the API, such as the lumensub-app deployment.
   * Empty means no cross-origin access; server-to-server calls are unaffected.
   */
  corsOrigins?: string[];
}

export function merchantOf(req: FastifyRequest): string {
  return req.merchant;
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.log as FastifyBaseLogger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return sendError(reply, new ApiError(429, 'rate_limited', 'too many requests'));
    if (status && status >= 400 && status < 500) {
      return sendError(reply, new ApiError(status, 'bad_request', (err as Error).message));
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, new ApiError(500, 'internal', 'something went wrong on our side'));
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, new ApiError(404, 'not_found', 'no such route')));

  // The dashboard, checkout and portal call this API from the browser.
  await app.register(cors, {
    origin: deps.corsOrigins ?? [],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Api-Key'],
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'LumenSub API',
        version: '1.0.0',
        description: 'Merchant API for subscriptions billed on Stellar. Amounts are strings in the token\'s smallest unit.',
      },
      components: {
        securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'lsk_... API key' } },
      },
    },
  });
  if (deps.docsUi !== false) await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimit.max,
    timeWindow: deps.rateLimit.timeWindow,
    ...(deps.rateLimit.redis ? { redis: deps.rateLimit.redis } : {}),
    // Limit per API key when there is one, so merchants behind one NAT do not share a bucket.
    keyGenerator: (req) => {
      const key = extractApiKey(req.headers);
      return key ? `key:${hashApiKey(key).slice(0, 16)}` : `ip:${req.ip}`;
    },
    allowList: (req) => req.url === '/health' || req.url === '/ready',
  });

  await app.register(healthRoutes, { db: deps.db, readiness: deps.readiness });
  await app.register(publicRoutes, { prefix: '/v1/public', db: deps.db });

  await app.register(
    async (v1) => {
      v1.decorateRequest('merchant', '');
      v1.addHook('preHandler', async (req) => {
        const key = extractApiKey(req.headers);
        const merchant = key ? await merchantForKey(deps.db, key) : null;
        if (!merchant) throw unauthorized();
        req.merchant = merchant;
      });
      await v1.register(merchantRoutes, { db: deps.db });
      await v1.register(apiKeyRoutes, { db: deps.db });
      await v1.register(planRoutes, { db: deps.db });
      await v1.register(subscriptionRoutes, { db: deps.db });
      await v1.register(chargeRoutes, { db: deps.db });
      await v1.register(analyticsRoutes, { db: deps.db });
      await v1.register(webhookEndpointRoutes, { db: deps.db, ...deps.webhooks });
    },
    { prefix: '/v1' },
  );

  return app;
}
