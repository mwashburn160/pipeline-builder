// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { runCancellableFetch } from './internal/fetchCore';

/**
 * "Fetch full record by id on mount, with optional fallback shape from
 * a list view." Consolidates the pattern in EditPipelineModal,
 * EditPluginModal, and registry detail views.
 *
 * Guarded so re-fetching for the same id doesn't overwrite user edits
 * mid-edit: refetch only triggers when id changes. Aborts the in-flight request
 * on unmount (the fetcher's second argument is the signal). Call `reload()` to
 * force a refetch of the same id (e.g. after an in-place edit-save on a detail
 * page).
 *
 * @example
 * const { entity, fetching, reload } = useEntityFetch(plugin.id, (id) => api.getPluginById(id));
 */
export function useEntityFetch<T>(
  id: string | null | undefined,
  fetcher: (id: string, signal: AbortSignal) => Promise<T>,
  fallback?: T,
): { entity: T | null; fetching: boolean; error: Error | null; reload: () => void } {
  // The loaded record and any error are stamped with the id they belong to and
  // only returned while that id is still current. When `id` changes the very
  // next render shows `fallback` (or null), never the previous record — so a
  // failed read for the new id can't leave the old record on screen with its
  // actions (delete, stop, save) still wired to it.
  const [loaded, setLoaded] = useState<{ id: string; value: T } | null>(null);
  const [failed, setFailed] = useState<{ id: string; error: Error } | null>(null);
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [reloading, setReloading] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) {
      setLoaded(null);
      setFailed(null);
      return;
    }
    return runCancellableFetch((signal) => fetcherRef.current(id, signal), {
      onStart: () => {
        setReloading(true);
        setFailed(null);
        setLoaded((prev) => (prev && prev.id === id ? prev : null));
      },
      onSuccess: (value) => setLoaded({ id, value }),
      onError: (error) => setFailed({ id, error }),
      onSettled: () => { setReloading(false); setSettledFor(id); },
    });
    // fallback intentionally omitted: it's only the seed shown until the read
    // lands and is an inline object in most callers. reloadNonce forces a
    // same-id refetch when a caller calls reload().
  }, [id, reloadNonce]);

  const entity = id && loaded?.id === id ? loaded.value : (fallback ?? null);
  const error = id && failed?.id === id ? failed.error : null;
  // A render whose id has not settled yet is a read that is pending (or about
  // to start), so it reports `fetching` even before the effect has run.
  const fetching = !!id && (reloading || settledFor !== id);
  return { entity, fetching, error, reload };
}
