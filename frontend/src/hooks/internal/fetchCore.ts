// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared internal core for the ref-stored, cancellable fetch hooks
 * ({@link useFetch}, {@link useEntityFetch}, {@link useServerPagination},
 * {@link useListPage}).
 *
 * These hooks all repeated the same effect body: flip a local `cancelled`
 * flag, set loading/clear error, run the fetcher, then drop every state
 * write once cancelled (unmount / deps change). Consolidating it here keeps
 * the cancellation semantics — and the canonical `Error` error shape — in a
 * single place instead of three near-identical copies.
 *
 * Cancellation is now REAL: the cleanup aborts an `AbortSignal` handed to the
 * fetcher, so a superseded request (the next keystroke of a debounced filter, a
 * page the user navigated away from) stops on the wire instead of running to
 * completion and having its answer thrown away. Fetchers that ignore the signal
 * still behave exactly as before.
 */

import { isAbortError } from '@/lib/abort';

/**
 * Normalize an unknown thrown value into an `Error`.
 * Non-Error rejections are wrapped via `String(err)` so callers always get a
 * real `Error` with a message.
 */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Handlers invoked across a single cancellable fetch lifecycle.
 */
export interface CancellableFetchHandlers<T> {
  /** Called synchronously before the fetcher runs (set loading, clear error). */
  onStart: () => void;
  /** Called with the resolved value, unless the request was cancelled. */
  onSuccess: (result: T) => void;
  /** Called with a normalized Error on rejection, unless cancelled. */
  onError: (err: Error) => void;
  /** Called after success/error, unless cancelled (clear loading). */
  onSettled: () => void;
}

/**
 * Run `fetcher(signal)` and route its outcome through `handlers`, suppressing
 * every post-resolution write once the returned cleanup fn has been invoked —
 * and aborting `signal` so the request itself stops.
 *
 * Intended to be called from inside a `useEffect`; return its result as the
 * effect cleanup so a deps change or unmount cancels the in-flight request.
 *
 * @returns cleanup function that aborts the request and marks the run cancelled.
 */
export function runCancellableFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  handlers: CancellableFetchHandlers<T>,
): () => void {
  let cancelled = false;
  const controller = new AbortController();
  handlers.onStart();
  fetcher(controller.signal)
    .then((result) => {
      if (!cancelled) handlers.onSuccess(result);
    })
    .catch((err) => {
      // An abort is the expected outcome of cancelling, not a failure to show.
      // Checked in addition to `cancelled` because a fetcher may be wired to an
      // outer signal (the shared query cache) that fires independently.
      if (!cancelled && !isAbortError(err)) handlers.onError(toError(err));
    })
    .finally(() => {
      if (!cancelled) handlers.onSettled();
    });
  return () => {
    cancelled = true;
    controller.abort();
  };
}
