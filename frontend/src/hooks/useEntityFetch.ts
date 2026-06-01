// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';

/**
 * "Fetch full record by id on mount, with optional fallback shape from
 * a list view." Consolidates the pattern in EditPipelineModal,
 * EditPluginModal, and registry detail views.
 *
 * Guarded so re-fetching for the same id doesn't overwrite user edits
 * mid-edit: refetch only triggers when id changes. Cancels in-flight
 * state writes on unmount.
 *
 * @example
 * const { entity, fetching } = useEntityFetch(plugin.id, (id) => api.getPlugin(id));
 */
export function useEntityFetch<T>(
  id: string | null | undefined,
  fetcher: (id: string) => Promise<T>,
  fallback?: T,
): { entity: T | null; fetching: boolean; error: Error | null } {
  const [entity, setEntity] = useState<T | null>(fallback ?? null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!id) {
      setEntity(fallback ?? null);
      return;
    }
    let cancelled = false;
    setFetching(true);
    setError(null);
    fetcherRef
      .current(id)
      .then((result) => {
        if (cancelled) return;
        setEntity(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (cancelled) return;
        setFetching(false);
      });
    return () => {
      cancelled = true;
    };
    // fallback intentionally omitted: it's only the initial seed and changes
    // on every render in callers that pass an inline object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return { entity, fetching, error };
}
