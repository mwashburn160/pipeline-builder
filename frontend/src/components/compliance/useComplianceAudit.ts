// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import type { PaginationState } from '@/components/ui/Pagination';
import { usePagination } from '@/hooks/usePagination';
import type { ComplianceAuditEntry } from '@/types/compliance';

export interface ComplianceAuditFilters {
  target: string;
  result: string;
  /** What produced the check (upload/create validation, a scan, an entity event). */
  action: string;
  /** Date-range scope (empty = unbounded). */
  dateFrom: string;
  dateTo: string;
}

export interface UseComplianceAuditResult {
  entries: ComplianceAuditEntry[];
  /** A failed fetch surfaces here so the caller can show a retry banner. */
  error: string | null;
  filters: ComplianceAuditFilters;
  setTarget: (v: string) => void;
  setResult: (v: string) => void;
  setAction: (v: string) => void;
  setDateFrom: (v: string) => void;
  setDateTo: (v: string) => void;
  /** True when any of the five filters is narrowing the log. */
  filtersActive: boolean;
  pagination: PaginationState;
  handlePageChange: (offset: number) => void;
  handlePageSizeChange: (limit: number) => void;
  retry: () => void;
}

/**
 * The compliance check log shown on the dashboard Overview: its five filters,
 * pagination, fetch and error state.
 *
 * Lived inline in `ComplianceDashboard` as eight `useState`s plus three effects
 * that were then drilled through 14 props into `Overview` — the only consumer.
 * Nothing outside the Overview ever read them, so the whole block moved here.
 */
export function useComplianceAudit(): UseComplianceAuditResult {
  const [entries, setEntries] = useState<ComplianceAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [target, setTarget] = useState('');
  const [result, setResult] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [total, setTotal] = useState(0);
  const [tick, setTick] = useState(0);
  const page = usePagination();
  const { offset, limit, reset } = page;

  // A changed filter starts again from page 1 — DURING render, so the fetch
  // effect below sees the new filters and offset 0 together and issues ONE
  // request. (Resetting in an effect would first fetch the new filters at the
  // stale offset, which is what the ref choreography here used to work around.)
  const filterKey = [target, result, action, dateFrom, dateTo].join('\u0000');
  const [shownFilterKey, setShownFilterKey] = useState(filterKey);
  if (shownFilterKey !== filterKey) {
    setShownFilterKey(filterKey);
    reset();
  }

  // Monotonic guard: driven by five filters + pagination + retry, an older
  // in-flight response could otherwise resolve last and overwrite the current
  // filter's rows. Bail on any setState if a newer fetch has started since.
  const genRef = useRef(0);
  useEffect(() => {
    const gen = ++genRef.current;
    void (async () => {
      try {
        const params: Record<string, string | number> = { limit, offset };
        if (target) params.target = target;
        if (result) params.result = result;
        if (action) params.action = action;
        if (dateFrom) params.dateFrom = dateFrom;
        if (dateTo) params.dateTo = dateTo;
        const res = await api.getComplianceAuditLog(params);
        if (genRef.current !== gen) return; // superseded by a newer fetch
        if (res.success && res.data) {
          setEntries(res.data.entries);
          setError(null);
          if (res.data.pagination) setTotal(res.data.pagination.total);
        } else {
          setError(res.message || 'Failed to load audit log');
        }
      } catch {
        if (genRef.current === gen) setError('Failed to load audit log');
      }
    })();
    // Invalidate the in-flight read on unmount too, so a late answer can't
    // write into an unmounted consumer.
    return () => { genRef.current += 1; };
  }, [target, result, action, dateFrom, dateTo, offset, limit, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);

  return {
    entries,
    error,
    filters: { target, result, action, dateFrom, dateTo },
    setTarget,
    setResult,
    setAction,
    setDateFrom,
    setDateTo,
    filtersActive: Boolean(result || target || action || dateFrom || dateTo),
    pagination: page.withTotal(total),
    handlePageChange: page.setOffset,
    handlePageSizeChange: page.setLimit,
    retry,
  };
}
