import { useState, useCallback, useRef } from 'react';

export interface UseDeleteResult<T> {
  /** The item currently targeted for deletion, or null. */
  target: T | null;
  /** Whether the delete operation is in progress. */
  loading: boolean;
  /** Open the delete confirmation for an item. */
  open: (item: T) => void;
  /** Cancel the delete confirmation. */
  close: () => void;
  /** Execute the deletion. Calls deleteFn, then onSuccess on success. */
  confirm: () => Promise<void>;
}

/**
 * Manages delete confirmation state and execution.
 * Pair with <DeleteConfirmModal> for a complete delete flow.
 *
 * @param deleteFn - Async function that performs the deletion.
 * @param onSuccess - Callback after successful deletion (e.g. refresh list).
 * @param onError - Optional error handler (defaults to re-throwing).
 *
 * @example
 * ```tsx
 * const del = useDelete(
 *   (pipeline) => api.deletePipeline(pipeline.id),
 *   () => fetchPipelines(),
 * );
 *
 * // In JSX:
 * <button onClick={() => del.open(pipeline)}>Delete</button>
 * {del.target && (
 *   <DeleteConfirmModal
 *     title="Delete Pipeline"
 *     itemName={del.target.pipelineName}
 *     loading={del.loading}
 *     onConfirm={del.confirm}
 *     onCancel={del.close}
 *   />
 * )}
 * ```
 */
export function useDelete<T>(
  deleteFn: (item: T) => Promise<unknown>,
  onSuccess?: () => void,
  onError?: (err: unknown) => void,
): UseDeleteResult<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const targetRef = useRef<T | null>(null);

  const open = useCallback((item: T) => {
    targetRef.current = item;
    setTarget(item);
  }, []);
  const close = useCallback(() => {
    targetRef.current = null;
    setTarget(null);
  }, []);

  const confirm = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    setLoading(true);
    try {
      await deleteFn(current);
      targetRef.current = null;
      setTarget(null);
      onSuccess?.();
    } catch (err) {
      targetRef.current = null;
      setTarget(null);
      if (onError) {
        onError(err);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, [deleteFn, onSuccess, onError]);

  return { target, loading, open, close, confirm };
}
