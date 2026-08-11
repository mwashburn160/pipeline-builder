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
 * mid-edit: refetch only triggers when id changes. Cancels in-flight
 * state writes on unmount. Call `reload()` to force a refetch of the same id
 * (e.g. after an in-place edit-save on a detail page).
 *
 * @example
 * const { entity, fetching, reload } = useEntityFetch(plugin.id, (id) => api.getPlugin(id));
 */
export function useEntityFetch<T>(
  id: string | null | undefined,
  fetcher: (id: string) => Promise<T>,
  fallback?: T,
): { entity: T | null; fetching: boolean; error: Error | null; reload: () => void } {
  const [entity, setEntity] = useState<T | null>(fallback ?? null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) {
      setEntity(fallback ?? null);
      return;
    }
    return runCancellableFetch(() => fetcherRef.current(id), {
      onStart: () => {
        setFetching(true);
        setError(null);
      },
      onSuccess: setEntity,
      onError: setError,
      onSettled: () => setFetching(false),
    });
    // fallback intentionally omitted: it's only the initial seed and changes
    // on every render in callers that pass an inline object. reloadNonce forces
    // a same-id refetch when a caller calls reload().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadNonce]);

  return { entity, fetching, error, reload };
}
