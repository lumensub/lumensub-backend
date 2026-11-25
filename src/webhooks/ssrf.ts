import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeWebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeWebhookTargetError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

function v4Blocked(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

/** True for loopback, private, link-local and other addresses a webhook must never reach. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family !== 6) return true; // not an IP at all: refuse rather than guess

  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped addresses: "::ffff:127.0.0.1", which URL parsing rewrites as "::ffff:7f00:1".
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return v4Blocked(mapped[1]);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return v4Blocked(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((r) => r.address);

/**
 * Rejects URLs that point at internal infrastructure. Every resolved address is
 * checked, not just the first. Call it at registration and again before each send,
 * because DNS can change between the two.
 */
export async function assertPublicUrl(
  raw: string,
  { allowPrivate = false, resolve = defaultResolver }: { allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookTargetError('not a valid URL');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeWebhookTargetError('webhook URLs must use https');
  }
  if (url.username || url.password) throw new UnsafeWebhookTargetError('credentials in the URL are not allowed');
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeWebhookTargetError(`${host} is not a public host`);
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new UnsafeWebhookTargetError(`could not resolve ${host}`);
  const bad = addresses.find(isPrivateAddress);
  if (bad) throw new UnsafeWebhookTargetError(`${host} resolves to a private address (${bad})`);
  return url;
}
