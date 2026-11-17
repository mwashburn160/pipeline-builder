// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import { useMutation } from '@/hooks/useMutation';

/**
 * Return type for `useAsyncCallback()`.
 */
export interface UseAsyncCallbackResult<T, A extends unknown[]> {
  /** Execute the wrapped async function. Returns the result or null on error. */
  execute: (...args: A) => Promise<T | null>;
  /** Whether the async operation is in progress. */
  loading: boolean;
  /** Error message from the last execution, or null. */
  error: string | null;
  /** Clear the current error. */
  clearError: () => void;
}

/**
 * Wrap an async action with loading/error state management.
 *
 * A thin adapter over {@link useMutation} for the older `execute / loading /
 * error` shape — so it inherits the synchronous in-flight lock (a second
 * `execute` while one is pending returns the same result), unmount dropping,
 * and step-up handoff (a refusal the global dialog took over resolves `null`
 * with no error). New code should call `useMutation` directly.
 *
 * Does NOT auto-execute — call `execute()` to trigger the action (e.g., on
 * button click, form submit). For fetch-on-mount/deps-change use `useFetch`.
 */
export function useAsyncCallback<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
): UseAsyncCallbackResult<T, A> {
  const m = useMutation<T, A>({ fn });
  const { run } = m;
  const execute = useCallback(async (...args: A): Promise<T | null> => {
    const result = await run(...args);
    return result === undefined ? null : result;
  }, [run]);
  return { execute, loading: m.pending, error: m.error, clearError: m.reset };
}
