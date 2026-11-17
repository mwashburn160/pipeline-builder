// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useRef, useState } from 'react';
import { formatError } from '@/lib/constants';
import { continueAfterStepUp } from '@/lib/api/errors';
import { invalidate, type InvalidateTarget } from '@/lib/api-cache';
import { useToast } from '@/components/ui/Toast';
import { useUnmountedRef } from './useUnmountedRef';

/**
 * The one shared core for WRITES — the counterpart of `fetchCore` for reads.
 *
 * Every save / submit / delete button in this app needs the same five things,
 * and hand-rolling them per component (a `saving` flag, an `inFlightRef`, a
 * `mountedRef`, a `catch` that remembers the step-up dialog) is where the
 * double-submit and stale-async bugs came from:
 *
 *  1. **A synchronous in-flight lock.** `pending` is React state, so it does not
 *     exist until the next render; a double click lands two calls before the
 *     button disables. The lock is a ref: a second `run()` while one is in
 *     flight is not started and gets the SAME promise back.
 *  2. **Scope binding.** A result belongs to the `scopeKey` (an org id, the
 *     entity a dialog is editing) it started under. If that changed — or the
 *     component unmounted — before the write settled, its success/error
 *     callbacks, toast and state updates are DROPPED, and `run` resolves
 *     `undefined`. (Cache invalidation still runs: the write did happen.)
 *  3. **Step-up.** A refusal the global step-up dialog took over (see
 *     `continueAfterStepUp`) is not an error: `pending` clears, no error is
 *     shown, `run` resolves `undefined`, and once the person confirms and the
 *     replay lands `onStepUpResumed` runs and `invalidates` are re-applied.
 *  4. **Errors** are formatted once (`formatError(err, errorFallback)`) into
 *     `error`, optionally toasted, and handed to `onError`.
 *  5. **Invalidation** — `invalidates: ['pipelines']` calls `invalidate.pipelines()`
 *     after success, so every `useQuery` and every tagged `useFetch` reader re-reads.
 *
 * @example
 * const save = useMutation({
 *   fn: (draft: Draft) => api.updatePolicy(policy.id, draft),
 *   scopeKey: policy.id,
 *   invalidates: ['complianceRules'],
 *   errorFallback: 'Failed to save policy',
 *   toast: { success: 'Policy saved' },
 *   onSuccess: () => onClose(),
 * });
 * <Button loading={save.pending} onClick={() => save.run(draft)} />
 */
export interface UseMutationOptions<TResult, TArgs extends unknown[]> {
  /** The write. Throw to fail — including on an envelope's `success: false`. */
  fn: (...args: TArgs) => Promise<TResult>;
  /**
   * What the write's result belongs to. Compared with `Object.is` when the
   * write settles; a change in between drops the outcome. A change also
   * releases the in-flight lock for the new scope (a new org's dialog must not
   * be stuck behind the old one's request).
   */
  scopeKey?: unknown;
  /** Shared caches to drop after success (and after a resumed step-up replay). */
  invalidates?: ReadonlyArray<InvalidateTarget>;
  /** Runs after a successful write that is still in scope. A throw here is reported as the write's error. */
  onSuccess?: (result: TResult, ...args: TArgs) => void | Promise<void>;
  /** Runs with the raw error and its formatted message, when still in scope. */
  onError?: (err: unknown, message: string, ...args: TArgs) => void;
  /**
   * Runs once a step-up refusal the global dialog took over has been confirmed
   * and replayed (with the REPLAYED request's result — not `fn`'s — since `fn`
   * did not run to completion). Use it to refresh or close what this surface
   * shows. Dropped when out of scope by then.
   */
  onStepUpResumed?: (replayResult: unknown, ...args: TArgs) => void;
  /** Runs when the person dismissed that step-up dialog (or the replay failed). */
  onStepUpAbandoned?: (reason: unknown, ...args: TArgs) => void;
  /** Fallback message for a non-Error throw. */
  errorFallback?: string;
  /**
   * Turn a failure into the message shown — for surfaces with their own
   * error-code vocabulary (`reviewErrorMessage`, `rateLimitMessage`). Defaults
   * to `formatError(err, errorFallback)`.
   */
  formatError?: (err: unknown) => string;
  /**
   * Toast the outcome. `success`: a message, or a function of the result.
   * `error: true` toasts the formatted error message; a string toasts that text.
   * Needs a `ToastProvider` above; silently skipped without one.
   */
  toast?: {
    success?: string | ((result: TResult, ...args: TArgs) => string);
    error?: boolean | string;
  };
}

export interface UseMutationResult<TResult, TArgs extends unknown[]> {
  /**
   * Start the write. Resolves with `fn`'s result on success; `undefined` on
   * error, a step-up handoff, or a dropped (out-of-scope / unmounted) outcome.
   * Never rejects. A call while one is pending for the same scope returns the
   * in-flight promise without starting another.
   */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  /** True while a write for the CURRENT scope is in flight. */
  pending: boolean;
  /** The last failure's formatted message, or null. Cleared by the next run. */
  error: string | null;
  /** Clear `error` (e.g. when a dialog closes or a field is edited). */
  reset: () => void;
  /** Set or clear `error` directly — for client-side validation that shares the same banner. */
  setError: (message: string | null) => void;
}

interface Flight<TResult> {
  promise: Promise<TResult | undefined>;
  scope: unknown;
}

/** The toast API, when a provider (or a test's mock) supplies one. */
function useToastIfAvailable(): ReturnType<typeof useToast> | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

function applyInvalidations(targets: ReadonlyArray<InvalidateTarget> | undefined): void {
  for (const t of targets ?? []) {
    try { invalidate[t](); } catch { /* a cache must never break a write's outcome */ }
  }
}

export function useMutation<TResult, TArgs extends unknown[] = []>(
  options: UseMutationOptions<TResult, TArgs>,
): UseMutationResult<TResult, TArgs> {
  const optsRef = useRef(options);
  optsRef.current = options;
  const scopeRef = useRef<unknown>(options.scopeKey);
  scopeRef.current = options.scopeKey;
  const unmountedRef = useUnmountedRef();
  const toastApi = useToastIfAvailable();
  const toastRef = useRef(toastApi);
  toastRef.current = toastApi;

  const flightRef = useRef<Flight<TResult> | null>(null);
  // `pending` is the scope the in-flight write started under (wrapped, so an
  // `undefined` scope is still distinguishable from "nothing pending").
  const [pendingFor, setPendingFor] = useState<{ scope: unknown } | null>(null);
  // Errors are stamped with their scope too: a failure for the previous org's
  // dialog must not sit in the next one's banner.
  const [failure, setFailure] = useState<{ scope: unknown; message: string } | null>(null);

  const run = useCallback((...args: TArgs): Promise<TResult | undefined> => {
    const scope = scopeRef.current;
    const live = flightRef.current;
    if (live && Object.is(live.scope, scope)) return live.promise;

    const inScope = () => !unmountedRef.current && Object.is(scopeRef.current, scope);
    const marker = { scope };
    setPendingFor(marker);
    setFailure(null);

    const flight: Flight<TResult> = { scope, promise: undefined as unknown as Promise<TResult | undefined> };
    // Locked BEFORE `fn` runs: a `fn` that throws synchronously settles inside
    // the call below, and its `finally` must find (and release) this flight.
    flightRef.current = flight;
    const exec = async (): Promise<TResult | undefined> => {
      const opts = optsRef.current;
      try {
        let result: TResult;
        try {
          result = await opts.fn(...args);
        } catch (err) {
          const handed = continueAfterStepUp(
            err,
            (replay) => {
              applyInvalidations(optsRef.current.invalidates);
              if (inScope()) optsRef.current.onStepUpResumed?.(replay, ...args);
            },
            (reason) => { if (inScope()) optsRef.current.onStepUpAbandoned?.(reason, ...args); },
          );
          if (handed) return undefined;
          throw err;
        }
        applyInvalidations(opts.invalidates);
        if (!inScope()) return undefined;
        await opts.onSuccess?.(result, ...args);
        if (!inScope()) return result;
        const success = opts.toast?.success;
        if (success) {
          toastRef.current?.success(typeof success === 'function' ? success(result, ...args) : success);
        }
        return result;
      } catch (err) {
        if (!inScope()) return undefined;
        const message = opts.formatError ? opts.formatError(err) : formatError(err, opts.errorFallback);
        setFailure({ scope, message });
        const errToast = opts.toast?.error;
        if (errToast) toastRef.current?.error(typeof errToast === 'string' ? errToast : message);
        opts.onError?.(err, message, ...args);
        return undefined;
      } finally {
        if (flightRef.current === flight) flightRef.current = null;
        if (!unmountedRef.current) setPendingFor((cur) => (cur === marker ? null : cur));
      }
    };
    flight.promise = exec();
    return flight.promise;
  }, [unmountedRef]);

  const reset = useCallback(() => setFailure(null), []);
  const setError = useCallback(
    (message: string | null) => setFailure(message === null ? null : { scope: scopeRef.current, message }),
    [],
  );

  const pending = pendingFor !== null && Object.is(pendingFor.scope, options.scopeKey);
  const error = failure !== null && Object.is(failure.scope, options.scopeKey) ? failure.message : null;
  return { run, pending, error, reset, setError };
}
