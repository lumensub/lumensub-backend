import type { Queryable } from '../src/db/pool.js';

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number } | undefined;

/** fakeDb plus connect(), so code that opens transactions can run against it. */
export function fakePool(respond: Responder = () => undefined) {
  const db = fakeDb(respond);
  return Object.assign(db, {
    connect: async () => ({ query: db.query, release: () => undefined }),
  }) as unknown as import('../src/db/pool.js').Pool & { queries: RecordedQuery[] };
}

/**
 * A stand-in for pg that records every query and answers with whatever the
 * responder returns. Enough to test the SQL a function issues without a database.
 */
export function fakeDb(respond: Responder = () => undefined): Queryable & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    query: (async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: text, params });
      const res = respond(text, params) ?? {};
      return { rows: res.rows ?? [], rowCount: res.rowCount ?? res.rows?.length ?? 1 };
    }) as unknown as Queryable['query'],
  };
}
