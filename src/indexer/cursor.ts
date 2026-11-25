export interface Cursor {
  ledger: number;
  lastEventId: string | null;
}

/**
 * Soroban event ids look like "0000012345678901234-0000000002": a zero-padded
 * TOID and an index inside it. Compare them numerically, part by part, so we do
 * not depend on the padding staying the same.
 */
export function compareEventIds(a: string, b: string): number {
  const pa = a.split('-');
  const pb = b.split('-');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = BigInt(pa[i] ?? '0');
    const y = BigInt(pb[i] ?? '0');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Where the next getEvents call should start. We re-read the cursor's ledger
 * (events after lastEventId in that ledger may not have been seen yet) unless the
 * RPC no longer keeps it, in which case we start from the oldest ledger it has.
 */
export function startLedger(cursor: Cursor | null, configuredStart: number, oldestAvailable: number): {
  ledger: number;
  gap: boolean;
} {
  const wanted = cursor ? cursor.ledger : configuredStart;
  if (wanted === 0) return { ledger: oldestAvailable, gap: false };
  if (wanted < oldestAvailable) return { ledger: oldestAvailable, gap: true };
  return { ledger: wanted, gap: false };
}

/** Drops events at or before the cursor, so a re-read ledger is not applied twice. */
export function unseenEvents<T extends { id: string; ledger: number }>(events: T[], cursor: Cursor | null): T[] {
  if (!cursor) return events;
  return events.filter((e) => {
    if (e.ledger > cursor.ledger) return true;
    if (e.ledger < cursor.ledger) return false;
    return cursor.lastEventId === null || compareEventIds(e.id, cursor.lastEventId) > 0;
  });
}

/**
 * Moves the cursor to the last processed event. It never moves backwards: if the
 * RPC hands us an older page (failover to a node that is behind), the cursor stays.
 */
export function advanceCursor(cursor: Cursor | null, processed: { id: string; ledger: number }[], latestLedger?: number): Cursor | null {
  let next = cursor;
  for (const e of processed) {
    if (
      !next ||
      e.ledger > next.ledger ||
      (e.ledger === next.ledger && (next.lastEventId === null || compareEventIds(e.id, next.lastEventId) > 0))
    ) {
      next = { ledger: e.ledger, lastEventId: e.id };
    }
  }
  // With nothing new, we can still skip ahead to the ledger the RPC has reached,
  // but only past ledgers we know are fully read.
  if (latestLedger !== undefined && processed.length === 0 && (!next || latestLedger > next.ledger)) {
    next = { ledger: latestLedger, lastEventId: null };
  }
  return next;
}
