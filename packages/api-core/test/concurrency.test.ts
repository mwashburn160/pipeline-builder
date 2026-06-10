// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { runConcurrent } from '../src/utils/concurrency.js';

describe('runConcurrent', () => {
  it('returns empty array for empty input', async () => {
    const result = await runConcurrent<number, number>([], 4, async (n) => n * 2);
    expect(result).toEqual([]);
  });

  it('throws when limit < 1', async () => {
    await expect(runConcurrent([1], 0, async () => 'x')).rejects.toThrow(/limit/);
  });

  it('preserves result order', async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await runConcurrent(items, 2, async (n) => {
      // Simulate variable latency: later items finish faster
      await new Promise((r) => setTimeout(r, Math.max(0, 30 - n / 5)));
      return n + 1;
    });
    expect(result).toEqual([11, 21, 31, 41, 51]);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runConcurrent(items, 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity check that we actually parallelized
  });

  it('rejects on the first worker error', async () => {
    const items = [1, 2, 3, 4, 5];
    await expect(
      runConcurrent(items, 2, async (n) => {
        if (n === 3) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 5));
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
