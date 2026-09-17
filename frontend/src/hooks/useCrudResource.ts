// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic hook for CRUD resource management — fetch, create, update, delete
 * with loading/error state. Used by RuleList and PolicyManager.
 *
 * Load and mutation failures are tracked separately: a failed `fetch` sets
 * `loadError` (render it with a Retry — the list may be stale or empty), while a
 * failed create/update/remove sets `mutationError` and leaves the current list
 * intact (render it inline and dismissible, never in place of the list). Each
 * new mutation clears the previous `mutationError`; `clearError` clears both.
 *
 * Callers must trigger the initial load themselves (e.g. from a useEffect that
 * also handles their own auth/route guards). The hook intentionally does NOT
 * auto-fetch on mount.
 */
import { useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
}

interface CrudApi<T, TCreate, TUpdate, TParams> {
  list: (params?: TParams) => Promise<ApiResponse<{ items: T[]; pagination?: { total: number } }>>;
  create: (data: TCreate) => Promise<ApiResponse<{ item: T }>>;
  update: (id: string, data: TUpdate) => Promise<ApiResponse<{ item: T }>>;
  delete: (id: string) => Promise<unknown>;
}

interface UseCrudResourceReturn<T, TCreate, TUpdate, TParams> {
  items: T[];
  loading: boolean;
  /** The last `fetch` failure; cleared when a fetch starts. */
  loadError: Error | null;
  /** The last create/update/remove failure; cleared when a mutation starts. */
  mutationError: Error | null;
  /** Dismiss both errors. */
  clearError: () => void;
  total: number;
  fetch: (params?: TParams) => Promise<void>;
  create: (data: TCreate) => Promise<T | null>;
  update: (id: string, data: TUpdate) => Promise<T | null>;
  remove: (id: string) => Promise<boolean>;
}

export function useCrudResource<T extends { id: string }, TCreate, TUpdate, TParams>(
  api: CrudApi<T, TCreate, TUpdate, TParams>,
  entityName: string,
): UseCrudResourceReturn<T, TCreate, TUpdate, TParams> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);

  const clearError = useCallback(() => {
    setLoadError(null);
    setMutationError(null);
  }, []);

  const toError = (err: unknown, fallback: string): Error =>
    err instanceof Error ? err : new Error(formatError(err, fallback));

  const fetch = useCallback(async (params?: TParams) => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.list(params);
      if (res.success && res.data) {
        setItems(res.data.items);
        setTotal(res.data.pagination?.total ?? res.data.items.length);
      } else {
        setLoadError(new Error((res as { message?: string }).message || `Failed to fetch ${entityName}`));
      }
    } catch (err) {
      setLoadError(toError(err, `Failed to fetch ${entityName}`));
    } finally {
      setLoading(false);
    }
  }, [api, entityName]);

  const create = useCallback(async (data: TCreate): Promise<T | null> => {
    setMutationError(null);
    try {
      const res = await api.create(data);
      if (res.success && res.data) {
        const item = res.data.item;
        setItems((prev) => [item, ...prev]);
        return item;
      }
      // 2xx with success:false / no data — surface it instead of a silent no-op.
      setMutationError(new Error((res as { message?: string }).message || `Failed to create ${entityName}`));
      return null;
    } catch (err) {
      setMutationError(toError(err, `Failed to create ${entityName}`));
      return null;
    }
  }, [api, entityName]);

  const update = useCallback(async (id: string, data: TUpdate): Promise<T | null> => {
    setMutationError(null);
    try {
      const res = await api.update(id, data);
      if (res.success && res.data) {
        const item = res.data.item;
        setItems((prev) => prev.map((i) => (i.id === id ? item : i)));
        return item;
      }
      setMutationError(new Error((res as { message?: string }).message || `Failed to update ${entityName}`));
      return null;
    } catch (err) {
      setMutationError(toError(err, `Failed to update ${entityName}`));
      return null;
    }
  }, [api, entityName]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setMutationError(null);
    try {
      // A 2xx soft-failure envelope ({ success: false }) must NOT drop the row from
      // the list — only remove it when the server actually deleted it (matches the
      // create/update result-gating). A void/204 response is treated as success.
      const res = await api.delete(id) as { success?: boolean } | null | undefined;
      if (res && res.success === false) {
        setMutationError(toError(new Error(`Failed to delete ${entityName}`), `Failed to delete ${entityName}`));
        return false;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
      return true;
    } catch (err) {
      setMutationError(toError(err, `Failed to delete ${entityName}`));
      return false;
    }
  }, [api, entityName]);

  return { items, loading, loadError, mutationError, clearError, total, fetch, create, update, remove };
}
