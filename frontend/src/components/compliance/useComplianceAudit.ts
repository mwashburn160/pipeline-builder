// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import type { PaginationState } from '@/components/ui/Pagination';
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
  const [pagination, setPagination] = useState<PaginationState>({ limit: 20, offset: 0, total: 0 });

  // Monotonic guard: driven by five filters + pagination + retry, an older
  // in-flight response could otherwise resolve last and overwrite the current
  // filter's rows. Bail on any setState if a newer fetch has started since.
  const genRef = useRef(0);
  const fetchAudit = useCallback(async (offset = pagination.offset, limit = pagination.limit) => {
    const gen = ++genRef.current;
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
        if (res.data.pagination) {
          setPagination({ limit: res.data.pagination.limit, offset: res.data.pagination.offset, total: res.data.pagination.total });
        }
      } else {
        setError(res.message || 'Failed to load audit log');
      }
    } catch {
      if (genRef.current === gen) setError('Failed to load audit log');
    }
  }, [target, result, action, dateFrom, dateTo, pagination.offset, pagination.limit]);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPagination(prev => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
  }, [target, result, action, dateFrom, dateTo]);

  // Refetch the audit log when the filters change. Pass offset 0 explicitly:
  // the reset-offset effect above runs in the same commit, so `pagination.offset`
  // is still the previous page's value in this closure. Without the explicit 0,
  // changing a filter while on page 2+ would refetch the old offset and render
  // an empty page.
  //
  // `fetchAudit` is deliberately NOT a dependency: it also closes over
  // `pagination`, so listing it would refire this "filters changed, go to page 1"
  // effect on every page change too.
  const fetchAuditRef = useRef(fetchAudit);
  // Assigned in an effect (not during render) and declared BEFORE the filter
  // effect below, so React's in-order effect flush refreshes the ref first.
  useEffect(() => { fetchAuditRef.current = fetchAudit; });
  useEffect(() => {
    void fetchAuditRef.current(0);
  }, [target, result, action, dateFrom, dateTo]);

  const handlePageChange = useCallback((offset: number) => { void fetchAuditRef.current(offset, pagination.limit); }, [pagination.limit]);
  const handlePageSizeChange = useCallback((limit: number) => { void fetchAuditRef.current(0, limit); }, []);
  const retry = useCallback(() => { void fetchAuditRef.current(); }, []);

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
    pagination,
    handlePageChange,
    handlePageSizeChange,
    retry,
  };
}
