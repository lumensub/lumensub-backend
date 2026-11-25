import { describe, expect, it } from 'vitest';
import { fakeDb } from '../../test/fake-db.js';
import { extractApiKey, generateApiKey, hashApiKey, merchantForKey } from './keys.js';

describe('API keys', () => {
  it('generates a key with a visible prefix and a sha256 hash', () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^lsk_[0-9a-f]{48}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).toHaveLength(64);
  });

  it('reads bearer and x-api-key headers', () => {
    const { key } = generateApiKey();
    expect(extractApiKey({ authorization: `Bearer ${key}` })).toBe(key);
    expect(extractApiKey({ 'x-api-key': key })).toBe(key);
  });

  it('ignores anything that is not a well-formed key', () => {
    expect(extractApiKey({ authorization: 'Bearer nope' })).toBeNull();
    expect(extractApiKey({ authorization: 'Basic abc' })).toBeNull();
    expect(extractApiKey({})).toBeNull();
  });

  it('looks keys up by hash, never by the raw value', async () => {
    const { key } = generateApiKey();
    const db = fakeDb(() => ({ rows: [{ merchant_address: 'GM' }] }));
    await expect(merchantForKey(db, key)).resolves.toBe('GM');
    expect(db.queries[0]?.params).toEqual([hashApiKey(key)]);
    expect(JSON.stringify(db.queries)).not.toContain(key);
  });
});
