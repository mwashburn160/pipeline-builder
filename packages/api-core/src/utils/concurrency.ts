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

/**
 * Resolve after `ms`. With `unref`, the pending timer never keeps a draining
 * process alive (a backoff wait must not block shutdown).
 */
export function sleep(ms: number, opts: { unref?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // `unref` is absent on the timer shim some test environments install.
    if (opts.unref) timer.unref?.();
  });
}

/**
 * A {@link withTimeout} deadline elapsed. `label` / `ms` name what timed out.
 * (Deliberately not named `TimeoutError`: that is the DOMException name
 * `AbortSignal.timeout()` uses, which callers already match on.)
 */
export class OperationTimeoutError extends Error {
  readonly code = 'OPERATION_TIMEOUT';
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'OperationTimeoutError';
  }
}

/** Options for {@link withTimeout}. */
export interface WithTimeoutOptions {
  /**
   * A caller's signal: aborting it settles `withTimeout` at once (rejecting
   * with the signal's reason) and aborts the signal handed to `work`.
   */
  signal?: AbortSignal;
}

/**
 * Settle with `work`, or reject with {@link OperationTimeoutError} after `ms`.
 *
 * Giving up on a promise is not cancelling it, so `work` may be a FUNCTION of
 * an `AbortSignal`: the signal aborts (with the timeout error as its reason)
 * when the deadline passes or the caller's `options.signal` aborts, and `work`
 * should stop — check it before every side effect, or pass it to `fetch` /
 * the HTTP client. A bare promise is only raced (it keeps running; fine for a
 * read whose result is simply dropped, like a health probe).
 *
 * The timer is `unref`'d and always cleared, so a pending deadline never keeps
 * the process alive or a test run open.
 */
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  label: string,
  options: WithTimeoutOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const outer = options.signal;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOuterAbort = (): void => finish(() => {
      controller.abort(outer!.reason);
      reject(outer!.reason);
    });
    let done = false;
    function finish(settle: () => void): void {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
      settle();
    }

    if (outer?.aborted) {
      onOuterAbort();
      return;
    }
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    timer = setTimeout(() => finish(() => {
      const err = new OperationTimeoutError(label, ms);
      controller.abort(err);
      reject(err);
    }), ms);
    timer.unref?.();

    let pending: Promise<T>;
    try {
      pending = typeof work === 'function' ? work(controller.signal) : work;
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}
