import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '../src/db/pool.js';
import { readMigrations } from '../src/db/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * A real Postgres (compiled to WASM) with every migration applied. Lets tests run
 * the actual SQL without a database server.
 */
export async function migratedDb(): Promise<{ db: Queryable; pg: PGlite }> {
  // Match src/db/pool.ts: int8 (20) and numeric (1700) come back as strings.
  const pg = new PGlite({ parsers: { 20: (v: string) => v, 1700: (v: string) => v } });
  for (const m of await readMigrations(migrationsDir)) {
    await pg.exec(m.sql);
  }
  const db = {
    query: (async (sql: string, params: unknown[] = []) => {
      const res = await pg.query(sql, params as never[]);
      const rows = (res.rows as Record<string, unknown>[]).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
      );
      // pg reports the row count for SELECTs too; PGlite reports 0 there, so fall back to rows.
      return { rows, rowCount: res.affectedRows ? res.affectedRows : rows.length };
    }) as unknown as Queryable['query'],
  };
  return { db, pg };
}
