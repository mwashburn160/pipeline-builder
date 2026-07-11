// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, LogQueryResult } from '@/types';

export function observabilityApi(core: ApiCore) {
  return {
    // ==========================================================================
    // Observability (sysadmin-only; consumed by /dashboard/observability/*)
    //
    // Frontend never sends raw PromQL/LogQL — only catalog keys. Backend
    // (platform/src/observability/catalog.ts) maps key → query and substitutes
    // sanitized template variables for the Audit Activity recent-events drill.
    // ==========================================================================

    /**
     * Run a named Prometheus query from the catalog (instant or range).
     *
     * Response shape depends on the catalog entry's source:
     *  - `prometheus-instant` → `{ samples: InstantSample[] }`
     *  - `prometheus-range`   → `{ series: DataSeries[], range, step }`
     */
    observabilityQuery: async (
      key: string,
      range: '1h' | '6h' | '24h',
      signal?: AbortSignal,
      vars?: { plugin?: string },
    ) => {
      return core.request<ApiResponse<import('@/types/observability').ObservabilityQueryResponse>>(
        `/api/observability/query${buildQuery({ key, range, ...vars })}`,
        { signal },
      );
    },

    /**
     * Run a named Loki query from the catalog. Optional `event`, `digest`,
     * `actor` params are validated server-side against the catalog entry's
     * `allowedVars`; anything outside the allow-list is silently dropped.
     *
     * Response shape depends on whether the catalog entry returns streams or
     * matrix (see `controller.ts` for the heuristic).
     */
    observabilityLogs: async (
      key: string,
      range: '1h' | '6h' | '24h',
      opts: { limit?: number; event?: string; digest?: string; actor?: string; plugin?: string } = {},
      signal?: AbortSignal,
    ) => {
      const params: Record<string, unknown> = { key, range };
      if (opts.limit !== undefined) params.limit = opts.limit;
      if (opts.event) params.event = opts.event;
      if (opts.digest) params.digest = opts.digest;
      if (opts.actor) params.actor = opts.actor;
      if (opts.plugin) params.plugin = opts.plugin;
      return core.request<ApiResponse<import('@/types/observability').ObservabilityLogsResponse>>(
        `/api/observability/logs${buildQuery(params)}`,
        { signal },
      );
    },

    /** List firing + suppressed alerts visible to the caller (Alertmanager v2 shape). */
    observabilityAlerts: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').AlertsResponse>>(
        '/api/observability/alerts',
        { signal },
      );
    },

    /** List active + recent silences. */
    observabilitySilences: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').SilencesResponse>>(
        '/api/observability/silences',
        { signal },
      );
    },

    /** Create a silence. Non-sysadmins are auto-scoped to their own org. */
    observabilityCreateSilence: async (body: {
      matchers: Array<{ name: string; value: string }>;
      durationMs: number;
      comment: string;
    }) => {
      return core.request<ApiResponse<{ silenceID: string }>>(
        '/api/observability/silences',
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    /** Expire a silence by ID. */
    observabilityDeleteSilence: async (id: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/silences/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    },

    // ==========================================================================
    // Dashboards (DB-stored, user-editable observability dashboards — P3)
    //
    // Replaces the code-defined dashboards under `src/lib/dashboards/*.ts`.
    // Panels reference catalog `queryKey`s; raw PromQL/LogQL never travels
    // through this surface, so the catalog stays the security boundary.
    // ==========================================================================

    /** List dashboards visible to the caller (org-scoped + public). */
    listDashboards: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardsResponse>>(
        '/api/dashboards',
        { signal },
      );
    },

    /** Fetch one dashboard + its panels in render order. */
    getDashboard: async (id: string, signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardResponse>>(
        `/api/dashboards/${encodeURIComponent(id)}`,
        { signal },
      );
    },

    /** Create a dashboard (org-admin or sysadmin required server-side). */
    createDashboard: async (body: import('@/types/observability').DashboardWrite) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardResponse>>(
        '/api/dashboards',
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    /** Update a dashboard (ownership / org-admin / sysadmin gated server-side). */
    updateDashboard: async (id: string, body: import('@/types/observability').DashboardWrite) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardResponse>>(
        `/api/dashboards/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },

    /** Soft delete a dashboard. */
    deleteDashboard: async (id: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/dashboards/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    },

    /** Fork a dashboard into the caller's org as a private copy. */
    cloneDashboard: async (id: string) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardResponse>>(
        `/api/dashboards/${encodeURIComponent(id)}/clone`,
        { method: 'POST' },
      );
    },

    /** List catalog query keys — drives the editor's panel-add picker. */
    observabilityCatalog: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').CatalogResponse>>(
        '/api/observability/catalog',
        { signal },
      );
    },

    // ==========================================================================
    // Alert destinations (multi-tenant alerting)
    // ==========================================================================

    /** List alert destinations. Targets are masked on read.
     *  Pass `{ all: true }` (sysadmin only) for cross-tenant view; rows then
     *  include `orgId` and the UI groups them client-side. */
    listAlertDestinations: async (
      { all, signal }: { all?: boolean; signal?: AbortSignal } = {},
    ) => {
      const path = all
        ? '/api/observability/alert-destinations/all'
        : '/api/observability/alert-destinations';
      return core.request<ApiResponse<import('@/types/observability').AlertDestinationsResponse>>(
        path,
        { signal },
      );
    },

    /** Create a destination (org-admin / sysadmin server-side gate). */
    createAlertDestination: async (body: import('@/types/observability').AlertDestinationWrite) => {
      return core.request<ApiResponse<import('@/types/observability').AlertDestinationResponse>>(
        '/api/observability/alert-destinations',
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    /** Update a destination. Send `target: ""` to leave the secret URL alone. */
    updateAlertDestination: async (id: string, body: import('@/types/observability').AlertDestinationWrite) => {
      return core.request<ApiResponse<import('@/types/observability').AlertDestinationResponse>>(
        `/api/observability/alert-destinations/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },

    /** Delete a destination. */
    deleteAlertDestination: async (id: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-destinations/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    },

    // ============================================
    // Log endpoints
    // ============================================
    getLogs: async (params?: { service?: string; level?: string; search?: string; start?: string; end?: string; limit?: number; direction?: string }) => {
      return core.request<ApiResponse<LogQueryResult>>(`/api/logs${buildQuery(params)}`);
    },

    getLogServices: async () => {
      return core.request<ApiResponse<{ services: string[] }>>('/api/logs/services');
    },

    getLogLevels: async () => {
      return core.request<ApiResponse<{ levels: string[] }>>('/api/logs/levels');
    },
  };
}
