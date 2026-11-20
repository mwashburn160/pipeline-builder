// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/concurrency: the bounded-parallel map the storage scans
 * use, and the shared limiter a whole snapshot run's registry calls go through.
 */

import { describe, it, expect } from '@jest/globals';
import { createLimiter, mapWithConcurrency } from '../src/services/concurrency.js';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

/** An async fn that records how many calls are in flight at once. */
function tracked<T, R>(fn: (item: T, i: number) => R | Promise<R>, delay: (i: number) => number = () => 1) {
  const state = { inFlight: 0, peak: 0, started: [] as number[] };
  const run = async (item: T, i: number): Promise<R> => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    state.started.push(i);
    try {
      await tick(delay(i));
      return await fn(item, i);
    } finally {
      state.inFlight--;
    }
  };
  return { state, run };
}

describe('mapWithConcurrency', () => {
  it('keeps exactly `limit` calls in flight when there is enough work', async () => {
    const { state, run } = tracked((n: number) => n);
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, run);
    expect(state.peak).toBe(4);
  });

  it('never exceeds the number of items', async () => {
    const { state, run } = tracked((n: number) => n);
    await mapWithConcurrency([1, 2], 8, run);
    expect(state.peak).toBe(2);
  });

  it('returns results in INPUT order, whatever order calls finish in', async () => {
    // Later items finish first.
    const { run } = tracked((n: number) => n * 10, (i) => 20 - i);
    expect(await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, run))
      .toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('limit 1 is serial', async () => {
    const { state, run } = tracked((n: number) => n);
    await mapWithConcurrency([1, 2, 3, 4], 1, run);
    expect(state.peak).toBe(1);
    expect(state.started).toEqual([0, 1, 2, 3]);
  });

  it('a nonsense limit (0, NaN, fractional) still makes progress', async () => {
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
    expect(await mapWithConcurrency([1, 2], Number.NaN, async (n) => n)).toEqual([1, 2]);
    expect(await mapWithConcurrency([1, 2, 3], 2.7, async (n) => n)).toEqual([1, 2, 3]);
  });

  it('an empty input resolves to an empty array without calling fn', async () => {
    let calls = 0;
    expect(await mapWithConcurrency([], 4, async () => { calls++; })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('a rejection rejects the whole map with that error (as a serial await would)', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });
});

describe('createLimiter', () => {
  it('bounds in-flight calls across independent callers', async () => {
    const limit = createLimiter(3);
    const { state, run } = tracked((n: number) => n);
    // Two nested maps at width 4 each, all calls through one limiter.
    const outer = await mapWithConcurrency([0, 1, 2, 3], 4, (o) =>
      mapWithConcurrency([0, 1, 2, 3], 4, (i) => limit(() => run(o * 4 + i, o * 4 + i))));
    expect(state.peak).toBe(3);
    expect(outer.flat()).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('a rejected call frees its slot and rejects only its caller', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(await limit(async () => 'next')).toBe('next');
  });
});
