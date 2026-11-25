import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'LumenSub-Signature';

/** Default window for accepting a signature, in seconds. Guards against replays. */
export const DEFAULT_TOLERANCE_SECS = 300;

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

/** Hex HMAC-SHA256 over "<timestamp>.<raw body>". */
export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Builds the header value, e.g. "t=1700000000,v1=5257a8...". */
export function signatureHeader(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (!key || !value) continue;
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

/**
 * Checks a header against the raw request body. This is the same check we ask
 * merchants to run on their side; docs/webhooks.md has a copy they can paste.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  { toleranceSecs = DEFAULT_TOLERANCE_SECS, now = Math.floor(Date.now() / 1000) } = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(now - parsed.timestamp) > toleranceSecs) return false;
  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, body), 'hex');
  return parsed.signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
