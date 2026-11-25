import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SUBSCRIPTION_CONTRACT_ID: 'C' + 'A'.repeat(55),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(8080);
    expect(config.KEEPER_ENABLED).toBe(false);
    expect(config.WEBHOOK_MAX_ATTEMPTS).toBe(8);
  });

  it('rejects a malformed contract id', () => {
    expect(() => loadConfig({ ...base, SUBSCRIPTION_CONTRACT_ID: 'GABC' })).toThrow(
      /SUBSCRIPTION_CONTRACT_ID/,
    );
  });

  it('requires a keeper secret when the keeper is enabled', () => {
    expect(() => loadConfig({ ...base, KEEPER_ENABLED: 'true' })).toThrow(/KEEPER_SECRET/);
  });

  it('parses boolean flags', () => {
    const config = loadConfig({ ...base, WEBHOOK_ALLOW_PRIVATE_TARGETS: '1' });
    expect(config.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(true);
  });
});
