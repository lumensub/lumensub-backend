import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, generateSecret, parseSignatureHeader, signatureHeader, verifySignature } from './signature.js';

const secret = 'whsec_test';
const body = '{"id":"e1","type":"subscription.charged"}';

describe('webhook signatures', () => {
  it('is a hex HMAC-SHA256 of "timestamp.body"', () => {
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex');
    expect(computeSignature(secret, 1_700_000_000, body)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips through the header', () => {
    const header = signatureHeader(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, header, body, { now: 1_700_000_010 })).toBe(true);
  });

  it('rejects a changed body or the wrong secret', () => {
    const header = signatureHeader(secret, body, 1_700_000_000);
    expect(verifySignature(secret, header, body + ' ', { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature('whsec_other', header, body, { now: 1_700_000_000 })).toBe(false);
  });

  it('rejects old timestamps', () => {
    const header = signatureHeader(secret, body, 1_700_000_000);
    expect(verifySignature(secret, header, body, { now: 1_700_000_000 + 301 })).toBe(false);
  });

  it('ignores malformed parts', () => {
    expect(parseSignatureHeader('garbage')).toBeNull();
    expect(parseSignatureHeader('t=1,v1=nothex')).toBeNull();
    expect(parseSignatureHeader(`t=1, v0=abc, v1=${'a'.repeat(64)}`)).toEqual({ timestamp: 1, signatures: ['a'.repeat(64)] });
  });

  it('generates distinct secrets', () => {
    expect(generateSecret()).not.toBe(generateSecret());
    expect(generateSecret()).toMatch(/^whsec_[0-9a-f]{48}$/);
  });
});
