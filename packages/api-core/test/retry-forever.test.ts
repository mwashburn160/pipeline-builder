// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { nextBackoffMs, retryForever } from '../src/services/retry-forever.js';

// Fake timers: `retryForever` sleeps between attempts, so a real-time test
// would either be slow or flaky. `advanceTimersByTimeAsync` also flushes the
// microtask queue, which is what lets the awaited sleep resolve.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('nextBackoffMs', () => {
  it('doubles until it hits the cap, then stays there', () => {
    expect(nextBackoffMs(100, 1000)).toBe(200);
    expect(nextBackoffMs(200, 1000)).toBe(400);
    expect(nextBackoffMs(800, 1000)).toBe(1000);
    expect(nextBackoffMs(1000, 1000)).toBe(1000);
  });
});

describe('retryForever', () => {
  it('returns the value on the first success without sleeping', async () => {
    const fn = jest.fn(async () => 'ok');
    const onAttemptFailed = jest.fn();

    await expect(retryForever(fn, { baseMs: 10, maxMs: 100, onAttemptFailed })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onAttemptFailed).not.toHaveBeenCalled();
  });

  it('keeps retrying past the point a bounded policy would give up', async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts += 1;
      if (attempts < 6) throw new Error(`boom ${attempts}`);
      return attempts;
    });
    const onAttemptFailed = jest.fn();

    const promise = retryForever(fn, { baseMs: 10, maxMs: 40, onAttemptFailed });
    // 10 + 20 + 40 + 40 + 40 = 150ms of backoff across the five failures.
    await jest.advanceTimersByTimeAsync(200);

    await expect(promise).resolves.toBe(6);
    expect(onAttemptFailed).toHaveBeenCalledTimes(5);
  });

  it('reports each failure with the delay it is about to wait, capped at maxMs', async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts += 1;
      if (attempts < 5) throw new Error('boom');
      return 'done';
    });
    const delays: number[] = [];

    const promise = retryForever(fn, {
      baseMs: 10,
      maxMs: 30,
      onAttemptFailed: (_err, delayMs) => delays.push(delayMs),
    });
    await jest.advanceTimersByTimeAsync(200);
    await promise;

    expect(delays).toEqual([10, 20, 30, 30]);
  });

  it('passes the thrown error to the reporter', async () => {
    const err = new Error('cold datastore');
    let attempts = 0;
    const seen: unknown[] = [];

    const promise = retryForever(
      async () => {
        attempts += 1;
        if (attempts === 1) throw err;
        return 1;
      },
      { baseMs: 5, maxMs: 5, onAttemptFailed: (e) => seen.push(e) },
    );
    await jest.advanceTimersByTimeAsync(20);
    await promise;

    expect(seen).toEqual([err]);
  });

  it('resolves undefined (not a rejection) when the caller aborts mid-retry', async () => {
    let open = true;
    const fn = jest.fn(async () => {
      throw new Error('still down');
    });

    const promise = retryForever(fn, {
      baseMs: 10,
      maxMs: 10,
      onAttemptFailed: () => { open = false; },
      shouldContinue: () => open,
    });
    await jest.advanceTimersByTimeAsync(50);

    await expect(promise).resolves.toBeUndefined();
    // One attempt, then `shouldContinue` turned false before the second.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never attempts at all when shouldContinue is already false', async () => {
    const fn = jest.fn(async () => 'never');
    await expect(
      retryForever(fn, { baseMs: 1, maxMs: 1, onAttemptFailed: jest.fn(), shouldContinue: () => false }),
    ).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});
