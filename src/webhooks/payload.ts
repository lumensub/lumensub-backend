import { toJson, type DomainEvent, type DomainEventType } from '../stellar/events.js';

export const WEBHOOK_EVENT_TYPES = {
  merchant: 'merchant.updated',
  plan_new: 'plan.created',
  plan_act: 'plan.updated',
  sub_new: 'subscription.created',
  charged: 'subscription.charged',
  chg_fail: 'subscription.charge_failed',
  paused: 'subscription.paused',
  resumed: 'subscription.resumed',
  cancelled: 'subscription.cancelled',
  plan_chg: 'subscription.plan_changed',
  refunded: 'subscription.refunded',
} as const satisfies Record<DomainEventType, string>;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[DomainEventType];

export const ALL_WEBHOOK_EVENT_TYPES = Object.values(WEBHOOK_EVENT_TYPES) as WebhookEventType[];

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  created_at: string;
  ledger: number;
  tx_hash: string | null;
  data: Record<string, unknown>;
}

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The body we POST to merchants. Field names are snake_case, amounts are strings
 * (they are i128 on chain and do not fit in a JSON number), times are ISO 8601.
 */
export function buildPayload(event: DomainEvent): WebhookPayload {
  const { id, ledger, ledgerTime, txHash, type, ...rest } = event;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    data[camelToSnake(key)] = value instanceof Date ? value.toISOString() : toJson(value);
  }
  return {
    id,
    type: WEBHOOK_EVENT_TYPES[type],
    created_at: ledgerTime.toISOString(),
    ledger,
    tx_hash: txHash,
    data,
  };
}

/** An endpoint with an empty filter receives everything. */
export function endpointWants(filter: readonly string[], type: WebhookEventType): boolean {
  return filter.length === 0 || filter.includes(type);
}
