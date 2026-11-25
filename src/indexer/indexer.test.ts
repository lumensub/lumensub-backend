import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeChain } from '../../test/fake-chain.js';
import { fakePool } from '../../test/fake-db.js';
import type { RawContractEvent } from '../stellar/events.js';
import { Indexer } from './indexer.js';

const log = pino({ level: 'silent' });
const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });

function pausedEvent(ledger: number, index: number, subId: bigint): RawContractEvent {
  return {
    id: `${ledger}-${index}`,
    ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    txHash: 'tx',
    topic: [sym('paused'), nativeToScVal(subId, { type: 'u64' })],
    value: xdr.ScVal.scvVoid(),
  };
}

function brokenEvent(ledger: number, index: number): RawContractEvent {
  return {
    id: `${ledger}-${index}`,
    ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    topic: [sym('refunded'), nativeToScVal(1n, { type: 'u64' })],
    value: nativeToScVal({ amount: 'not a number' }),
  };
}

function setup(cursor: { ledger: string; last_event_id: string | null } | null) {
  const pool = fakePool((sql) => {
    if (sql.startsWith('SELECT ledger, last_event_id FROM indexer_cursor')) return { rows: cursor ? [cursor] : [] };
    return undefined;
  });
  const chain = new FakeChain();
  chain.oldest = 10;
  const indexer = new Indexer(pool, chain, { startLedger: 0, pageSize: 100, pollIntervalMs: 1_000 }, log);
  return { pool, chain, indexer };
}

const cursorWrites = (queries: { sql: string; params: unknown[] }[]) =>
  queries.filter((q) => q.sql.startsWith('INSERT INTO indexer_cursor')).map((q) => q.params);

describe('Indexer.pollOnce', () => {
  it('applies new events and moves the cursor after each one', async () => {
    const { pool, chain, indexer } = setup(null);
    chain.pages.push({ events: [pausedEvent(12, 1, 5n), pausedEvent(13, 1, 6n)], latestLedger: 13 });
    const applied = await indexer.pollOnce();
    expect(applied).toBe(2);
    expect(cursorWrites(pool.queries)).toEqual([
      [12, '12-1'],
      [13, '13-1'],
    ]);
    expect(indexer.lastSeenLedger).toBe(13);
  });

  it('skips events at or before the stored cursor', async () => {
    const { pool, chain, indexer } = setup({ ledger: '12', last_event_id: '12-1' });
    chain.pages.push({ events: [pausedEvent(12, 1, 5n), pausedEvent(12, 2, 6n)], latestLedger: 12 });
    expect(await indexer.pollOnce()).toBe(1);
    const applied = pool.queries.filter((q) => q.sql.startsWith('INSERT INTO contract_events'));
    expect(applied.map((q) => q.params[0])).toEqual(['12-2']);
  });

  it('dead-letters events it cannot decode and keeps going', async () => {
    const { pool, chain, indexer } = setup(null);
    chain.pages.push({ events: [brokenEvent(20, 1), pausedEvent(20, 2, 9n)], latestLedger: 20 });
    expect(await indexer.pollOnce()).toBe(1);
    const dead = pool.queries.find((q) => q.sql.startsWith('INSERT INTO dead_letter_events'));
    expect(dead?.params.slice(0, 3)).toEqual(['20-1', 20, 'refunded']);
    expect(cursorWrites(pool.queries).at(-1)).toEqual([20, '20-2']);
  });

  it('jumps the cursor to the chain tip after an empty page', async () => {
    const { pool, chain, indexer } = setup({ ledger: '30', last_event_id: '30-4' });
    chain.pages.push({ events: [], latestLedger: 45 });
    await indexer.pollOnce();
    expect(cursorWrites(pool.queries)).toEqual([[45, null]]);
  });
});
