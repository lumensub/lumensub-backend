import { describe, expect, it } from 'vitest';
import { parseContractStatus } from './status.js';

describe('parseContractStatus', () => {
  it('accepts a bare variant name', () => {
    expect(parseContractStatus('PastDue')).toBe('past_due');
  });

  it('accepts the single-element vec form', () => {
    expect(parseContractStatus(['Trialing'])).toBe('trialing');
  });

  it('rejects anything else', () => {
    expect(() => parseContractStatus('Frozen')).toThrow(/unknown subscription status/);
    expect(() => parseContractStatus(3)).toThrow();
  });
});
