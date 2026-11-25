import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

export interface MigrationFile {
  name: string;
  sql: string;
}

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => MIGRATION_NAME.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })));
}

export function pendingMigrations(all: MigrationFile[], applied: Set<string>): MigrationFile[] {
  return all.filter((m) => !applied.has(m.name));
}

/**
 * Applies every migration that has not run yet, each in its own transaction.
 * Migrations are append-only: never edit one that has shipped, add a new file.
 */
export async function migrate(pool: Pool, dir: string, log: (msg: string) => void = console.log): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const pending = pendingMigrations(await readMigrations(dir), new Set(rows.map((r) => r.name)));

  for (const m of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      await client.query('COMMIT');
      log(`applied ${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  if (pending.length === 0) log('database is up to date');
  return pending.map((m) => m.name);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { createPool } = await import('./pool.js');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = createPool(url, 1);
  const dir = fileURLToPath(new URL('../../migrations', import.meta.url));
  try {
    await migrate(pool, dir);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
