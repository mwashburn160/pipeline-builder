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
 * Note: this is intentionally NOT used by `useAsync`, which uses a real
 * `AbortSignal` and a `string` error shape and carries many consumers that
 * depend on those contracts.
 */

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
 * Run `fetcher()` and route its outcome through `handlers`, suppressing every
 * post-resolution write once the returned cleanup fn has been invoked.
 *
 * Intended to be called from inside a `useEffect`; return its result as the
 * effect cleanup so a deps change or unmount cancels the in-flight write.
 *
 * @returns cleanup function that marks the run as cancelled.
 */
export function runCancellableFetch<T>(
  fetcher: () => Promise<T>,
  handlers: CancellableFetchHandlers<T>,
): () => void {
  let cancelled = false;
  handlers.onStart();
  fetcher()
    .then((result) => {
      if (!cancelled) handlers.onSuccess(result);
    })
    .catch((err) => {
      if (!cancelled) handlers.onError(toError(err));
    })
    .finally(() => {
      if (!cancelled) handlers.onSettled();
    });
  return () => {
    cancelled = true;
  };
}
