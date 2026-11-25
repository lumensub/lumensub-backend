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
 * The contract's Status is a unit enum. Depending on how it was decoded it shows up
 * as "PastDue" or as ["PastDue"] (a Vec holding one Symbol). Accept both.
 */
export function parseContractStatus(value: unknown): SubscriptionStatus {
  const name = Array.isArray(value) ? value[0] : value;
  const status = typeof name === 'string' ? fromContract[name] : undefined;
  if (!status) throw new Error(`unknown subscription status: ${JSON.stringify(value)}`);
  return status;
}
