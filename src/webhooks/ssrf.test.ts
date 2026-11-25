import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress, UnsafeWebhookTargetError } from './ssrf.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  const resolveTo = (addresses: string[]) => async () => addresses;

  it('accepts an https URL that resolves to public addresses', async () => {
    const url = await assertPublicUrl('https://hooks.example.com/lumensub', { resolve: resolveTo(['93.184.216.34']) });
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('rejects plain http', async () => {
    await expect(assertPublicUrl('http://hooks.example.com', { resolve: resolveTo(['93.184.216.34']) })).rejects.toThrow(
      /https/,
    );
  });

  it('rejects a host if any resolved address is private', async () => {
    await expect(
      assertPublicUrl('https://sneaky.example.com', { resolve: resolveTo(['93.184.216.34', '10.0.0.5']) }),
    ).rejects.toBeInstanceOf(UnsafeWebhookTargetError);
  });

  it('rejects literal private and bracketed IPv6 hosts', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('https://[::1]/hook')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('https://[::ffff:127.0.0.1]/hook')).rejects.toThrow(/private/);
  });

  it('rejects localhost names and embedded credentials', async () => {
    await expect(assertPublicUrl('https://localhost/hook')).rejects.toThrow(/not a public host/);
    await expect(assertPublicUrl('https://user:pw@example.com/')).rejects.toThrow(/credentials/);
  });

  it('allows anything when private targets are enabled for local development', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:3000/hook', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });
});
