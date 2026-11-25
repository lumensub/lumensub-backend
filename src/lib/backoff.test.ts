import { describe, expect, it } from 'vitest';
import { backoffDelay, sleep } from './backoff.js';

const top = () => 0.999999;
const bottom = () => 0;

describe('backoffDelay', () => {
  it('doubles each attempt', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, random: top };
    expect(backoffDelay(1, opts)).toBe(1000);
    expect(backoffDelay(2, opts)).toBe(2000);
    expect(backoffDelay(3, opts)).toBe(4000);
  });

  it('never goes below half of the exponential delay', () => {
    expect(backoffDelay(3, { baseMs: 1000, maxMs: 60_000, random: bottom })).toBe(2000);
  });

  it('caps at maxMs', () => {
    expect(backoffDelay(20, { baseMs: 1000, maxMs: 30_000, random: top })).toBe(30_000);
    expect(backoffDelay(1_000, { baseMs: 1000, maxMs: 30_000, random: top })).toBe(30_000);
  });

  it('rejects attempt numbers below 1', () => {
    expect(() => backoffDelay(0, { baseMs: 1, maxMs: 2 })).toThrow(RangeError);
  });
});

describe('sleep', () => {
  it('resolves early when aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
