import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

const KEY_PATTERN = /^lsk_[0-9a-f]{48}$/;

export interface NewApiKey {
  /** The full key. Shown once, never stored. */
  key: string;
  prefix: string;
  hash: string;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): NewApiKey {
  const key = `lsk_${randomBytes(24).toString('hex')}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

/** Reads the key from "Authorization: Bearer lsk_..." or "X-Api-Key: lsk_...". */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  const raw =
    typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : typeof headers['x-api-key'] === 'string'
        ? headers['x-api-key'].trim()
        : null;
  return raw && KEY_PATTERN.test(raw) ? raw : null;
}

/**
 * Looks up the merchant for a key. Only the hash is stored, so a database leak
 * does not hand out working keys. Updates last_used_at as a side effect.
 */
export async function merchantForKey(db: Queryable, key: string): Promise<string | null> {
  const { rows } = await db.query<{ merchant_address: string }>(
    `UPDATE api_keys SET last_used_at = now()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING merchant_address`,
    [hashApiKey(key)],
  );
  return rows[0]?.merchant_address ?? null;
}

export async function createApiKey(db: Queryable, merchant: string, name: string): Promise<NewApiKey & { id: string }> {
  const key = generateApiKey();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (merchant_address, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [merchant, name, key.prefix, key.hash],
  );
  return { ...key, id: rows[0]!.id };
}
