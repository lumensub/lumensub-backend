import { describe, expect, it } from 'vitest';
import { advanceCursor, compareEventIds, startLedger, unseenEvents } from './cursor.js';

const ev = (ledger: number, index: number) => ({
  ledger,
  id: `${String(BigInt(ledger) << 32n).padStart(19, '0')}-${String(index).padStart(10, '0')}`,
});

describe('compareEventIds', () => {
  it('orders by TOID then index', () => {
    expect(compareEventIds(ev(5, 1).id, ev(5, 2).id)).toBe(-1);
    expect(compareEventIds(ev(6, 0).id, ev(5, 9).id)).toBe(1);
    expect(compareEventIds(ev(5, 3).id, ev(5, 3).id)).toBe(0);
  });

  it('does not depend on padding', () => {
    expect(compareEventIds('10-2', '0000000009-0000000099')).toBe(1);
  });
});

describe('startLedger', () => {
  it('uses the configured start when there is no cursor', () => {
    expect(startLedger(null, 500, 100)).toEqual({ ledger: 500, gap: false });
  });

  it('starts at the oldest available ledger when nothing is configured', () => {
    expect(startLedger(null, 0, 100)).toEqual({ ledger: 100, gap: false });
  });

  it('re-reads the cursor ledger', () => {
    expect(startLedger({ ledger: 700, lastEventId: 'x' }, 500, 100)).toEqual({ ledger: 700, gap: false });
  });

  it('reports a gap when the RPC has dropped the cursor ledger', () => {
    expect(startLedger({ ledger: 50, lastEventId: null }, 0, 100)).toEqual({ ledger: 100, gap: true });
  });
});

describe('unseenEvents', () => {
  it('keeps later events in the cursor ledger and drops earlier ones', () => {
    const events = [ev(10, 1), ev(10, 2), ev(10, 3), ev(11, 0)];
    const cursor = { ledger: 10, lastEventId: ev(10, 2).id };
    expect(unseenEvents(events, cursor)).toEqual([ev(10, 3), ev(11, 0)]);
  });

  it('drops events from ledgers before the cursor', () => {
    expect(unseenEvents([ev(9, 5)], { ledger: 10, lastEventId: null })).toEqual([]);
  });
});

describe('advanceCursor', () => {
  it('moves to the last processed event', () => {
    expect(advanceCursor(null, [ev(3, 0), ev(4, 1)])).toEqual({ ledger: 4, lastEventId: ev(4, 1).id });
  });

  it('never moves backwards', () => {
    const cursor = { ledger: 20, lastEventId: ev(20, 4).id };
    expect(advanceCursor(cursor, [ev(19, 9), ev(20, 1)])).toBe(cursor);
  });

  it('skips ahead to the latest ledger when a page is empty', () => {
    expect(advanceCursor({ ledger: 20, lastEventId: ev(20, 4).id }, [], 25)).toEqual({ ledger: 25, lastEventId: null });
  });
});
