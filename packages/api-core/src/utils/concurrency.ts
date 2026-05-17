// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run `worker` over `items` with at most `limit` invocations in flight.
 * Preserves order in the returned array. Rejects on the first error.
 *
 * Use this anywhere we fan out N HTTP calls and want to cap concurrency
 * (e.g. registry blob mounts, parallel manifest fetches). Hand-rolled to
 * avoid adding a dep — keeps the bundle/footprint tiny.
 */
export async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('runConcurrent: limit must be >= 1');
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return results;
}
