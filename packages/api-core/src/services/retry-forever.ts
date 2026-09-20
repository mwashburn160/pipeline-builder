// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Capped exponential backoff for operations that must NEVER give up.
 *
 * Distinct from `retry-strategy.ts` next door, which is HTTP-shaped: it has a
 * bounded attempt count, inspects status codes and honours `Retry-After`. This
 * one is for process-lifetime dependency waits — a cold Mongo at boot, a Redis
 * pub/sub subscription that has to come up eventually — where giving up after N
 * attempts is the wrong answer. Crash-looping the pod (or, worse, silently
 * continuing degraded) is what these loops exist to avoid.
 *
 * Four separate hand-rolled copies of the same `delay = Math.min(delay * 2,
 * max)` loop had drifted apart; this is the one implementation.
 */

/**
 * `unref`'d on purpose: these loops run for the life of the process, and a
 * pending backoff timer must never be the thing that keeps a draining Node
 * process from exiting. (`unref` is absent on the browser/timer shim some test
 * environments install, hence the optional call.)
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

/**
 * The next delay in a capped doubling sequence.
 *
 * Exposed on its own for loops that are not "retry until success" — notably a
 * readiness MONITOR, which keeps polling forever and only wants the backoff
 * arithmetic while it waits for a dependency to come back.
 */
export function nextBackoffMs(currentMs: number, maxMs: number): number {
  return Math.min(currentMs * 2, maxMs);
}

/** Options for {@link retryForever}. */
export interface RetryForeverOptions {
  /** First delay after a failure, in ms. Doubles from here. */
  baseMs: number;
  /** Ceiling the doubling delay is capped at, in ms. */
  maxMs: number;
  /**
   * Called after every failed attempt, with the error and the delay about to
   * be waited. This is where the caller logs — the helper never logs itself,
   * because each call site wants its own message and fields.
   */
  onAttemptFailed: (error: unknown, delayMs: number) => void;
  /**
   * Keep going? Checked before each attempt. Defaults to "always". A caller
   * that can shut down (a closing relay, a draining server) passes its abort
   * predicate here so the loop never keeps a dying process alive.
   */
  shouldContinue?: () => boolean;
}

/**
 * Run `fn` until it succeeds, waiting `baseMs`, `2×baseMs`, … capped at
 * `maxMs` between attempts.
 *
 * Resolves with `fn`'s value on the first success. Resolves with `undefined`
 * when `shouldContinue()` turns false before an attempt — the caller aborted,
 * which is not an error. Never rejects: the whole point is that a failing
 * dependency does not propagate out as a thrown boot error.
 */
export async function retryForever<T>(
  fn: () => Promise<T>,
  { baseMs, maxMs, onAttemptFailed, shouldContinue }: RetryForeverOptions,
): Promise<T | undefined> {
  let delayMs = baseMs;
  while (shouldContinue?.() ?? true) {
    try {
      return await fn();
    } catch (error) {
      onAttemptFailed(error, delayMs);
      await sleep(delayMs);
      delayMs = nextBackoffMs(delayMs, maxMs);
    }
  }
  return undefined;
}
