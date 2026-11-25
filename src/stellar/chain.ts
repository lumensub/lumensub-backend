import {
  Account,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
  type xdr,
} from '@stellar/stellar-sdk';
import type { RawContractEvent } from './events.js';
import { parseContractStatus, type SubscriptionStatus } from './status.js';

export interface EventPage {
  events: RawContractEvent[];
  latestLedger: number;
}

export interface OnChainPlan {
  merchant: string;
  token: string;
  amount: bigint;
  periodSecs: bigint;
  trialSecs: bigint;
  maxCycles: number;
  graceSecs: bigint;
  active: boolean;
}

export interface OnChainSubscription {
  planId: bigint;
  subscriber: string;
  status: SubscriptionStatus;
  cyclesCharged: number;
  nextChargeAt: Date;
}

export interface ChargeResult {
  txHash: string;
  /** The transaction landed. A landed charge can still have collected nothing; see amount. */
  ok: boolean;
  /**
   * What charge() returned: the amount taken from the subscriber. Zero means the
   * subscriber could not pay (the contract publishes chg_fail) or plan-change credit
   * covered the whole period (it publishes charged).
   */
  amount?: bigint;
  error?: string;
}

/**
 * Everything the indexer and keeper need from the network. Kept as an interface so
 * both can be tested against an in-memory fake.
 */
export interface SubscriptionChain {
  oldestLedger(): Promise<number>;
  getEvents(startLedger: number, limit: number): Promise<EventPage>;
  getPlan(planId: bigint): Promise<OnChainPlan | null>;
  getSubscription(subId: bigint): Promise<OnChainSubscription | null>;
  isDue(subId: bigint): Promise<boolean>;
  charge(keeper: Keypair, subId: bigint): Promise<ChargeResult>;
}

export interface SorobanChainOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  allowHttp?: boolean;
  /** How long to wait for a submitted transaction before giving up. */
  confirmTimeoutMs?: number;
}

// Read-only calls are simulated, never submitted, so any well-formed source works.
const READ_SOURCE = new Account(Keypair.random().publicKey(), '0');

export class SorobanChain implements SubscriptionChain {
  private readonly server: rpc.Server;
  private readonly contract: Contract;

  constructor(private readonly opts: SorobanChainOptions) {
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? opts.rpcUrl.startsWith('http://') });
    this.contract = new Contract(opts.contractId);
  }

  async oldestLedger(): Promise<number> {
    // The RPC returns oldestLedger from getHealth, but the SDK types do not declare it.
    const health = (await this.server.getHealth()) as unknown as { oldestLedger?: number };
    if (typeof health.oldestLedger === 'number') return health.oldestLedger;
    // Fall back to roughly one day of history (5 s ledgers), which every RPC keeps.
    const latest = await this.server.getLatestLedger();
    return Math.max(1, latest.sequence - 17_280);
  }

  async getEvents(startLedger: number, limit: number): Promise<EventPage> {
    const res = await this.server.getEvents({
      startLedger,
      limit,
      filters: [{ type: 'contract', contractIds: [this.opts.contractId] }],
    });
    return {
      latestLedger: res.latestLedger,
      events: res.events.map((e) => ({
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt,
        txHash: e.txHash,
        topic: e.topic,
        value: e.value,
      })),
    };
  }

  private async view(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(READ_SOURCE, { fee: BASE_FEE, networkPassphrase: this.opts.networkPassphrase })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} simulation failed: ${sim.error}`);
    const retval = sim.result?.retval;
    return retval ? scValToNative(retval) : undefined;
  }

  async getPlan(planId: bigint): Promise<OnChainPlan | null> {
    const p = (await this.view('get_plan', nativeToScVal(planId, { type: 'u64' }))) as Record<string, unknown> | undefined;
    if (!p) return null;
    return {
      merchant: String(p.merchant),
      token: String(p.token),
      amount: BigInt(p.amount as bigint),
      periodSecs: BigInt(p.period_secs as bigint),
      trialSecs: BigInt((p.trial_secs as bigint) ?? 0n),
      maxCycles: Number(p.max_cycles ?? 0),
      graceSecs: BigInt((p.grace_secs as bigint) ?? 0n),
      active: Boolean(p.active ?? true),
    };
  }

  async getSubscription(subId: bigint): Promise<OnChainSubscription | null> {
    const s = (await this.view('get_subscription', nativeToScVal(subId, { type: 'u64' }))) as
      | Record<string, unknown>
      | undefined;
    if (!s) return null;
    return {
      planId: BigInt(s.plan_id as bigint),
      subscriber: String(s.subscriber),
      status: parseContractStatus(s.status),
      cyclesCharged: Number(s.cycles_charged ?? 0),
      nextChargeAt: new Date(Number(s.next_charge_at) * 1000),
    };
  }

  async isDue(subId: bigint): Promise<boolean> {
    return Boolean(await this.view('is_due', nativeToScVal(subId, { type: 'u64' })));
  }

  async charge(keeper: Keypair, subId: bigint): Promise<ChargeResult> {
    const account = await this.server.getAccount(keeper.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.opts.networkPassphrase })
      .addOperation(
        this.contract.call('charge', nativeToScVal(keeper.publicKey(), { type: 'address' }), nativeToScVal(subId, { type: 'u64' })),
      )
      .setTimeout(60)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(keeper);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
      return { txHash: sent.hash, ok: false, error: `send status ${sent.status}` };
    }

    const deadline = Date.now() + (this.opts.confirmTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const got = await this.server.getTransaction(sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const amount = got.returnValue ? BigInt(scValToNative(got.returnValue) as bigint) : undefined;
        return { txHash: sent.hash, ok: true, amount };
      }
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        return { txHash: sent.hash, ok: false, error: 'transaction failed on chain' };
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return { txHash: sent.hash, ok: false, error: 'timed out waiting for confirmation' };
  }
}
