import { describe, expect, it } from 'vitest';
import { parseContractStatus, SUBSCRIPTION_STATUSES } from './status.js';

describe('parseContractStatus', () => {
  it('reads the u32 the contract stores', () => {
    expect(parseContractStatus(0)).toBe('trialing');
    expect(parseContractStatus(2)).toBe('past_due');
    expect(parseContractStatus(6)).toBe('completed');
    expect(SUBSCRIPTION_STATUSES.map((_, i) => parseContractStatus(i))).toEqual([...SUBSCRIPTION_STATUSES]);
  });

  it('still accepts a variant name, bare or in a one-element array', () => {
    expect(parseContractStatus('PastDue')).toBe('past_due');
    expect(parseContractStatus(['Trialing'])).toBe('trialing');
  });

  it('rejects anything else', () => {
    expect(() => parseContractStatus('Frozen')).toThrow(/unknown subscription status/);
    expect(() => parseContractStatus(7)).toThrow(/unknown subscription status/);
    expect(() => parseContractStatus(-1)).toThrow();
    expect(() => parseContractStatus(1.5)).toThrow();
  });
});
