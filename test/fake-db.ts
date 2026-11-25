import type { Queryable } from '../src/db/pool.js';

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number } | undefined;

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
