import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pendingMigrations, readMigrations } from './migrate.js';

const dir = fileURLToPath(new URL('../../migrations', import.meta.url));

describe('migrations', () => {
  it('are numbered without gaps or duplicates', async () => {
    const files = await readMigrations(dir);
    const numbers = files.map((f) => Number(f.name.slice(0, 3)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('only returns migrations that have not been applied', async () => {
    const files = await readMigrations(dir);
    const pending = pendingMigrations(files, new Set(['001_merchants.sql', '002_plans.sql']));
    expect(pending[0]?.name).toBe('003_subscriptions.sql');
    expect(pending).toHaveLength(files.length - 2);
  });
});
