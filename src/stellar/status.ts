export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
  'lapsed',
  'completed',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Statuses the keeper may still charge. */
export const CHARGEABLE_STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/** Statuses that never change again. */
export const TERMINAL_STATUSES: readonly SubscriptionStatus[] = ['cancelled', 'lapsed', 'completed'];

const fromContract: Record<string, SubscriptionStatus> = {
  Trialing: 'trialing',
  Active: 'active',
  PastDue: 'past_due',
  Paused: 'paused',
  Cancelled: 'cancelled',
  Lapsed: 'lapsed',
  Completed: 'completed',
};

/**
 * The contract stores SubscriptionStatus as a u32 (Trialing = 0 through Completed = 6),
 * in the same order as SUBSCRIPTION_STATUSES. The variant name, bare or wrapped in a
 * one-element array, is still accepted so fixtures written by hand keep working.
 */
export function parseContractStatus(value: unknown): SubscriptionStatus {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const status = SUBSCRIPTION_STATUSES[Number(value)];
    if (status && Number.isInteger(Number(value))) return status;
    throw new Error(`unknown subscription status: ${String(value)}`);
  }
  const name = Array.isArray(value) ? value[0] : value;
  const status = typeof name === 'string' ? fromContract[name] : undefined;
  if (!status) throw new Error(`unknown subscription status: ${JSON.stringify(value)}`);
  return status;
}
