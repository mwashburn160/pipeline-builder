// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/ui/Toast';
import { formatError } from '@/lib/constants';

/**
 * Load-once-and-reload state for an async resource. Manages `data` / `loading` /
 * `error` + a failure toast + a `reload()`, so components stop re-hand-rolling
 * the same scaffold (previously duplicated across PatSection, RecentlyDeletedPanel).
 *
 * - `loader` MUST be memoized (wrap in `useCallback`) — it's a `reload`
 *   dependency; a fresh function each render would refetch every render.
 * - `loader` should THROW to signal failure (including an API `success:false`),
 *   which surfaces as `error` + a toast. A load failure never clears prior
 *   `data`, so callers can keep showing stale rows rather than a false-empty.
 * - `loading` starts `true` (the effect runs post-paint), avoiding an
 *   empty-state flash on first render.
 */
export function useLoadable<T>(loader: () => Promise<T>, initial: T, errorMessage: string) {
  const toast = useToast();
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (err) {
      const msg = formatError(err, errorMessage);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [loader, errorMessage, toast]);

  useEffect(() => { void reload(); }, [reload]);

  return { data, setData, loading, error, reload };
}
