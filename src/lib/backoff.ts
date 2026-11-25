export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a value in [0, 1). Pass () => 1 - Number.EPSILON for no jitter in tests. */
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, the other half
 * random. Attempt 1 waits about baseMs, attempt 2 about 2x, and so on up to maxMs.
 * Keeping half fixed means a retry never fires immediately after a failure.
 */
export function backoffDelay(attempt: number, { baseMs, maxMs, random = Math.random }: BackoffOptions): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
