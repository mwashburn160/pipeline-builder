// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import { formatError } from '@/lib/constants';

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
 * Does NOT auto-execute — call `execute()` to trigger the action (e.g., on
 * button click, form submit). For fetch-on-mount/deps-change use `useFetch`.
 *
 * @param fn - Async function to wrap
 * @returns Execute callback, loading, error, and clearError
 *
 * @example
 * ```tsx
 * const { execute: upload, loading, error } = useAsyncCallback(
 *   (file: File) => api.uploadPlugin(file, 'org'),
 * );
 *
 * const handleSubmit = async () => {
 *   const result = await upload(selectedFile);
 *   if (result) onSuccess();
 * };
 * ```
 */
export function useAsyncCallback<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
): UseAsyncCallbackResult<T, A> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const execute = useCallback(
    async (...args: A): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fn(...args);
        if (mountedRef.current) setLoading(false);
        return result;
      } catch (err) {
        if (mountedRef.current) {
          setError(formatError(err));
          setLoading(false);
        }
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fn is intentionally the only dep; callers must memoize it
    [fn],
  );

  return { execute, loading, error, clearError };
}
