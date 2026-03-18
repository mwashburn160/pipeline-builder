import { useState, useEffect, useCallback, useRef, type DependencyList } from 'react';
import { formatError } from '@/lib/constants';

/**
 * Return type for `useAsync()`.
 */
export interface UseAsyncResult<T> {
  /** Resolved data, or null while loading or on error. */
  data: T | null;
  /** Whether the async operation is in progress. */
  loading: boolean;
  /** Error message, or null when successful. */
  error: string | null;
  /** Manually re-run the async function. */
  refresh: () => void;
}

/**
 * Auto-fetch data on mount (or when deps change).
 *
 * Handles loading state, error capture, and stale-request cancellation.
 * The async function runs immediately on mount and re-runs whenever
 * the dependency list changes.
 *
 * @param fn - Async function that returns the data. Receives an optional AbortSignal
 *   that is aborted when deps change or the component unmounts.
 * @param deps - React dependency list (re-fetches when deps change)
 * @returns Data, loading, error, and a refresh callback
 *
 * @example
 * ```tsx
 * const { data: pipelines, loading, error } = useAsync(
 *   () => api.listPipelines({ isActive: 'true' }),
 *   [],
 * );
 * ```
 */
export function useAsync<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  deps: DependencyList = [],
): UseAsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fn(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(formatError(err));
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshKey]);

  return { data, loading, error, refresh };
}

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
 * Unlike `useAsync()`, this does NOT auto-execute. Call `execute()`
 * to trigger the action (e.g., on button click, form submit).
 *
 * @param fn - Async function to wrap
 * @returns Execute callback, loading, error, and clearError
 *
 * @example
 * ```tsx
 * const { execute: upload, loading, error } = useAsyncCallback(
 *   (file: File) => api.uploadPlugin(file, 'private'),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );

  return { execute, loading, error, clearError };
}
