// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result. `fn` should handle its own errors: a rejection
 * rejects the whole map (the other workers still run to completion of their
 * current item).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Runs `fn` once a slot is free; see {@link createLimiter}. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * A shared cap on in-flight calls across independent callers. Nested
 * {@link mapWithConcurrency} calls multiply their widths (orgs × calls per
 * org); routing the leaf calls through one limiter keeps the total at `limit`.
 * Only leaf calls may take a slot — a caller that waits on a slot while
 * holding one would deadlock.
 */
export function createLimiter(limit: number): Limiter {
  const width = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];
  // A finishing call hands its slot straight to the next waiter (`active` is
  // unchanged), so a caller arriving in between cannot take it as well.
  const release = (): void => {
    const wake = waiting.shift();
    if (wake) wake();
    else active--;
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= width) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
