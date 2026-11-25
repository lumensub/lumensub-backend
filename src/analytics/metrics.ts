/** Seconds in the "month" MRR is normalised to. 30 days, the usual convention. */
export const MONTH_SECS = 30n * 24n * 60n * 60n;

export interface PlanLine {
  token: string;
  amount: bigint;
  periodSecs: bigint;
  /** Subscriptions on this plan that count towards recurring revenue. */
  activeCount: number;
}

/**
 * Monthly recurring revenue per token. A plan's price is scaled to a 30-day month
 * (weekly plans count about 4.3 times, yearly ones a twelfth). Integer maths only,
 * rounding down, because amounts are in the token's smallest unit.
 */
export function monthlyRecurringRevenue(lines: PlanLine[]): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const line of lines) {
    if (line.periodSecs <= 0n || line.activeCount <= 0) continue;
    const monthly = (line.amount * MONTH_SECS * BigInt(line.activeCount)) / line.periodSecs;
    totals[line.token] = (totals[line.token] ?? 0n) + monthly;
  }
  return totals;
}

/**
 * Share of subscriptions that were live at the start of the window and ended
 * (cancelled or lapsed) during it. Returned as a fraction between 0 and 1.
 */
export function churnRate(liveAtStart: number, endedDuringWindow: number): number {
  if (liveAtStart <= 0) return 0;
  return Math.min(1, Math.max(0, endedDuringWindow / liveAtStart));
}

/** A fraction as a display percentage with two decimals, e.g. 0.025 -> "2.50". */
export function percent(fraction: number): string {
  return (Math.round(fraction * 10_000) / 100).toFixed(2);
}
