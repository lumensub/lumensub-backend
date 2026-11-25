import { scValToNative, type xdr } from '@stellar/stellar-sdk';
import { parseContractStatus, type SubscriptionStatus } from './status.js';

/** Fields every indexed event carries, whatever its type. */
export interface EventMeta {
  id: string;
  ledger: number;
  ledgerTime: Date;
  txHash: string | null;
}

export type DomainEvent = EventMeta &
  (
    | { type: 'merchant'; merchant: string; payout: string }
    | { type: 'plan_new'; planId: bigint; merchant: string; token: string; amount: bigint; periodSecs: bigint }
    | { type: 'plan_act'; planId: bigint; active: boolean }
    | { type: 'sub_new'; subId: bigint; planId: bigint; subscriber: string }
    | {
        type: 'charged';
        subId: bigint;
        amount: bigint;
        fee: bigint;
        keeperReward: bigint;
        cycle: number;
        nextChargeAt: Date;
      }
    | { type: 'chg_fail'; subId: bigint; reason: string; status: SubscriptionStatus }
    | { type: 'paused'; subId: bigint }
    | { type: 'resumed'; subId: bigint }
    | { type: 'cancelled'; subId: bigint; by: string }
    | { type: 'plan_chg'; subId: bigint; fromPlan: bigint; toPlan: bigint }
    | { type: 'refunded'; subId: bigint; amount: bigint }
  );

export type DomainEventType = DomainEvent['type'];

/**
 * Topics this service indexes. The contract also publishes `config` when the admin
 * changes protocol settings; nothing here reads it, so it is skipped.
 */
export const EVENT_TOPICS: readonly DomainEventType[] = [
  'merchant',
  'plan_new',
  'plan_act',
  'sub_new',
  'charged',
  'chg_fail',
  'paused',
  'resumed',
  'cancelled',
  'plan_chg',
  'refunded',
];

/** Thrown for events we recognise but cannot read. They go to the dead-letter table. */
export class EventDecodeError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
  ) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

function big(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${field} is not an integer`);
}

function str(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`${field} is not a string`);
}

function field(body: Record<string, unknown>, key: string): unknown {
  if (!(key in body)) throw new Error(`missing field ${key}`);
  return body[key];
}

/**
 * Maps an already-decoded event (topics and body as plain JS values) to a typed
 * domain event. Returns null for topics this service does not handle.
 */
export function mapEvent(meta: EventMeta, topics: unknown[], body: unknown): DomainEvent | null {
  const [name, id] = topics;
  if (typeof name !== 'string' || !(EVENT_TOPICS as readonly string[]).includes(name)) return null;

  try {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    switch (name as DomainEventType) {
      case 'merchant':
        // Topics are (merchant, merchant address); the data is the payout address.
        return { ...meta, type: 'merchant', merchant: str(id, 'merchant'), payout: str(body, 'payout') };
      case 'plan_act':
        if (typeof body !== 'boolean') throw new Error('active is not a boolean');
        return { ...meta, type: 'plan_act', planId: big(id, 'plan_id'), active: body };
      case 'plan_new':
        return {
          ...meta,
          type: 'plan_new',
          planId: big(id, 'plan_id'),
          merchant: str(field(b, 'merchant'), 'merchant'),
          token: str(field(b, 'token'), 'token'),
          amount: big(field(b, 'amount'), 'amount'),
          periodSecs: big(field(b, 'period_secs'), 'period_secs'),
        };
      case 'sub_new':
        return {
          ...meta,
          type: 'sub_new',
          subId: big(id, 'sub_id'),
          planId: big(field(b, 'plan_id'), 'plan_id'),
          subscriber: str(field(b, 'subscriber'), 'subscriber'),
        };
      case 'charged':
        return {
          ...meta,
          type: 'charged',
          subId: big(id, 'sub_id'),
          amount: big(field(b, 'amount'), 'amount'),
          fee: big(field(b, 'fee'), 'fee'),
          keeperReward: big(field(b, 'keeper_reward'), 'keeper_reward'),
          cycle: Number(big(field(b, 'cycle'), 'cycle')),
          nextChargeAt: new Date(Number(big(field(b, 'next_charge_at'), 'next_charge_at')) * 1000),
        };
      case 'chg_fail':
        return {
          ...meta,
          type: 'chg_fail',
          subId: big(id, 'sub_id'),
          reason: String(Array.isArray(b.reason) ? b.reason[0] : field(b, 'reason')),
          status: parseContractStatus(field(b, 'status')),
        };
      case 'paused':
      case 'resumed':
        return { ...meta, type: name as 'paused' | 'resumed', subId: big(id, 'sub_id') };
      case 'cancelled':
        return { ...meta, type: 'cancelled', subId: big(id, 'sub_id'), by: str(field(b, 'by'), 'by') };
      case 'plan_chg':
        return {
          ...meta,
          type: 'plan_chg',
          subId: big(id, 'sub_id'),
          fromPlan: big(field(b, 'from_plan'), 'from_plan'),
          toPlan: big(field(b, 'to_plan'), 'to_plan'),
        };
      case 'refunded':
        return { ...meta, type: 'refunded', subId: big(id, 'sub_id'), amount: big(field(b, 'amount'), 'amount') };
    }
  } catch (err) {
    throw new EventDecodeError(`${name}: ${(err as Error).message}`, meta.id);
  }
  return null;
}

/** Shape of an event as returned by the Soroban RPC getEvents call. */
export interface RawContractEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash?: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

export function decodeEvent(raw: RawContractEvent): DomainEvent | null {
  const meta: EventMeta = {
    id: raw.id,
    ledger: raw.ledger,
    ledgerTime: new Date(raw.ledgerClosedAt),
    txHash: raw.txHash ?? null,
  };
  let topics: unknown[];
  let body: unknown;
  try {
    topics = raw.topic.map((t) => scValToNative(t));
    body = scValToNative(raw.value);
  } catch (err) {
    throw new EventDecodeError(`could not decode XDR: ${(err as Error).message}`, raw.id);
  }
  return mapEvent(meta, topics, body);
}

/** JSON-safe copy of an event, for the event log, dead letters and webhook payloads. */
export function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
