/**
 * Generic hook for CRUD resource management — fetch, create, update, delete
 * with loading/error state. Used by useComplianceRules and useCompliancePolicies.
 */
import { useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';
import { useAsync } from './useAsync';

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
  error: string | null;
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
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { loading, error: fetchError } = useAsync(async () => {
    const res = await api.list();
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.pagination?.total ?? res.data.items.length);
    }
  }, []);

  const fetch = useCallback(async (params?: TParams) => {
    try {
      setMutationError(null);
      const res = await api.list(params);
      if (res.success && res.data) {
        setItems(res.data.items);
        setTotal(res.data.pagination?.total ?? res.data.items.length);
      }
    } catch (err) {
      setMutationError(formatError(err, `Failed to fetch ${entityName}`));
    }
  }, [api, entityName]);

  const create = useCallback(async (data: TCreate): Promise<T | null> => {
    try {
      const res = await api.create(data);
      if (res.success && res.data) {
        const item = res.data.item;
        setItems((prev) => [item, ...prev]);
        return item;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, `Failed to create ${entityName}`));
      return null;
    }
  }, [api, entityName]);

  const update = useCallback(async (id: string, data: TUpdate): Promise<T | null> => {
    try {
      const res = await api.update(id, data);
      if (res.success && res.data) {
        const item = res.data.item;
        setItems((prev) => prev.map((i) => (i.id === id ? item : i)));
        return item;
      }
      return null;
    } catch (err) {
      setMutationError(formatError(err, `Failed to update ${entityName}`));
      return null;
    }
  }, [api, entityName]);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api.delete(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
      return true;
    } catch (err) {
      setMutationError(formatError(err, `Failed to delete ${entityName}`));
      return false;
    }
  }, [api, entityName]);

  return { items, loading, error: mutationError || fetchError, total, fetch, create, update, remove };
}
