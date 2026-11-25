import { describe, expect, it } from 'vitest';
import { churnRate, MONTH_SECS, monthlyRecurringRevenue, percent } from './metrics.js';

const DAY = 86_400n;

describe('monthlyRecurringRevenue', () => {
  it('counts a monthly plan at face value', () => {
    expect(monthlyRecurringRevenue([{ token: 'USDC', amount: 10_000_000n, periodSecs: MONTH_SECS, activeCount: 3 }])).toEqual({
      USDC: 30_000_000n,
    });
  });

  it('scales weekly and yearly plans to a 30-day month', () => {
    const mrr = monthlyRecurringRevenue([
      { token: 'USDC', amount: 7n, periodSecs: 7n * DAY, activeCount: 1 }, // 30 per month
      { token: 'USDC', amount: 360n, periodSecs: 360n * DAY, activeCount: 1 }, // 30 per month
    ]);
    expect(mrr.USDC).toBe(60n);
  });

  it('keeps tokens apart and skips empty plans', () => {
    const mrr = monthlyRecurringRevenue([
      { token: 'USDC', amount: 5n, periodSecs: MONTH_SECS, activeCount: 2 },
      { token: 'XLM', amount: 100n, periodSecs: MONTH_SECS, activeCount: 1 },
      { token: 'EURC', amount: 100n, periodSecs: MONTH_SECS, activeCount: 0 },
    ]);
    expect(mrr).toEqual({ USDC: 10n, XLM: 100n });
  });

  it('rounds down rather than inventing revenue', () => {
    expect(monthlyRecurringRevenue([{ token: 'T', amount: 1n, periodSecs: 7n * DAY, activeCount: 1 }]).T).toBe(4n);
  });
});

describe('churnRate', () => {
  it('is ended over live-at-start', () => {
    expect(churnRate(200, 10)).toBe(0.05);
  });

  it('is zero with nothing live, and never above one', () => {
    expect(churnRate(0, 5)).toBe(0);
    expect(churnRate(3, 9)).toBe(1);
  });
});

describe('percent', () => {
  it('formats with two decimals', () => {
    expect(percent(0.05)).toBe('5.00');
    expect(percent(0.12345)).toBe('12.35');
  });
});
