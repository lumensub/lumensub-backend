import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { notFound, parse } from '../errors.js';
import { createApiKey } from '../keys.js';

const createBody = z.object({ name: z.string().trim().min(1).max(60) });
const idParams = z.object({ id: z.string().regex(/^\d+$/) });

export const apiKeyRoutes: FastifyPluginAsync<{ db: Queryable }> = async (app, { db }) => {
  app.get('/api-keys', { schema: { tags: ['api keys'], summary: 'List API keys (prefixes only)' } }, async (req) => {
    const { rows } = await db.query(
      `SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys
       WHERE merchant_address = $1 AND revoked_at IS NULL ORDER BY id DESC`,
      [req.merchant],
    );
    return { data: rows };
  });

  app.post('/api-keys', { schema: { tags: ['api keys'], summary: 'Create an API key. The key is only shown in this response.' } }, async (req, reply) => {
    const { name } = parse(createBody, req.body);
    const created = await createApiKey(db, req.merchant, name);
    return reply.status(201).send({ id: created.id, name, key: created.key, key_prefix: created.prefix });
  });

  app.delete('/api-keys/:id', { schema: { tags: ['api keys'], summary: 'Revoke an API key' } }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { rowCount } = await db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND merchant_address = $2 AND revoked_at IS NULL',
      [id, req.merchant],
    );
    if (!rowCount) throw notFound('API key');
    return reply.status(204).send();
  });
};
