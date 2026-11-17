// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';

import { OperationTimeoutError, runConcurrent, withTimeout } from '../src/utils/concurrency.js';

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

describe('withTimeout', () => {
  it('resolves with the work when it settles in time (promise or signal-taking function)', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'op')).resolves.toBe(7);
    await expect(withTimeout(async (signal) => (signal.aborted ? 'aborted' : 'ran'), 1000, 'op')).resolves.toBe('ran');
  });

  it('passes the work\'s own rejection through', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'op')).rejects.toThrow('boom');
    await expect(withTimeout(() => { throw new Error('sync boom'); }, 1000, 'op')).rejects.toThrow('sync boom');
  });

  it('rejects with OperationTimeoutError after `ms` AND aborts the work\'s signal with it', async () => {
    let seen: AbortSignal | undefined;
    const p = withTimeout((signal) => { seen = signal; return new Promise<never>(() => {}); }, 20, 'slow op');
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OperationTimeoutError);
    expect(err).toMatchObject({ message: 'slow op timed out after 20ms', label: 'slow op', ms: 20, code: 'OPERATION_TIMEOUT' });
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(err);
  });

  it('a caller signal aborting first rejects with its reason and aborts the work', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const p = withTimeout((signal) => { seen = signal; return new Promise<never>(() => {}); }, 10_000, 'op', { signal: controller.signal });
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(seen?.reason).toBe(reason);
  });

  it('an already-aborted caller signal never starts the work', async () => {
    const work = jest.fn(async () => 1);
    const reason = new Error('already');
    await expect(withTimeout(work, 1000, 'op', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
  });

  it('a late rejection after the deadline is swallowed (no unhandled rejection)', async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_r, rej) => { rejectLate = rej; });
    await expect(withTimeout(late, 10, 'op')).rejects.toBeInstanceOf(OperationTimeoutError);
    rejectLate(new Error('late'));
    await new Promise((r) => setTimeout(r, 5));
  });
});
