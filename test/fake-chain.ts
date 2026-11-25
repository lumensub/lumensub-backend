import type { Keypair } from '@stellar/stellar-sdk';
import type {
  ChargeResult,
  EventPage,
  OnChainPlan,
  OnChainSubscription,
  SubscriptionChain,
} from '../src/stellar/chain.js';

/** In-memory SubscriptionChain. Tests set the fields they care about. */
export class FakeChain implements SubscriptionChain {
  oldest = 1;
  pages: EventPage[] = [];
  plans = new Map<bigint, OnChainPlan>();
  subscriptions = new Map<bigint, OnChainSubscription>();
  due = new Set<bigint>();
  chargeResult: (subId: bigint) => ChargeResult = (subId) => ({ txHash: `tx-${subId}`, ok: true });
  charged: bigint[] = [];

  async oldestLedger() {
    return this.oldest;
  }

  async getEvents(): Promise<EventPage> {
    return this.pages.shift() ?? { events: [], latestLedger: this.oldest };
  }

  async getPlan(planId: bigint) {
    return this.plans.get(planId) ?? null;
  }

  async getSubscription(subId: bigint) {
    return this.subscriptions.get(subId) ?? null;
  }

  async isDue(subId: bigint) {
    return this.due.has(subId);
  }

  async charge(_keeper: Keypair, subId: bigint) {
    this.charged.push(subId);
    return this.chargeResult(subId);
  }
}
