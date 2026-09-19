// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import { ApiError } from '../errors';
import type { ApiResponse } from '@/types';
import type { LogQueryParams } from '@/types/logs';

/**
 * Flatten a {@link LogQueryParams} into query-string values.
 *
 * The time window is either a preset (`range=6h`) or an absolute pair
 * (`from`/`to`, unix ms) — never both, so the server doesn't have to guess which
 * wins. Shared by every log endpoint so search, histogram, raw view and download
 * are always describing the SAME selection; the download reusing the search's
 * exact query is what makes "you download what you can see" true rather than
 * aspirational.
 */
function logQueryToParams(params: LogQueryParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.q) out.q = params.q;
  if (params.limit !== undefined) out.limit = params.limit;
  if (params.orgs?.length) out.orgs = params.orgs.join(',');
  if (params.window.kind === 'preset') out.range = params.window.key;
  else { out.from = params.window.fromMs; out.to = params.window.toMs; }
  return out;
}

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
    ) => {
      return core.request<ApiResponse<import('@/types/observability').ObservabilityQueryResponse>>(
        `/api/observability/query${buildQuery({ key, range })}`,
        { signal },
      );
    },

    /**
     * Run a named audit-trail (`audit-store`) query from the catalog — the
     * caller's org's MongoDB audit events (all orgs for a sysadmin). Filter
     * params are checked server-side against the entry's `allowedVars`;
     * anything outside the allow-list is silently dropped.
     *
     * Response is `{entries}` for stream entries, `{series}` for matrix ones
     * (the catalog entry's `kind`).
     */
    observabilityAuditQuery: async (
      key: string,
      range: '1h' | '6h' | '24h',
      opts: Omit<import('@/types/observability').ObservabilityLogsParams, 'range'> = {},
      signal?: AbortSignal,
    ) => {
      const params: Record<string, unknown> = { key, range };
      if (opts.limit !== undefined) params.limit = opts.limit;
      if (opts.event) params.event = opts.event;
      if (opts.actor) params.actor = opts.actor;
      return core.request<ApiResponse<import('@/types/observability').ObservabilityLogsResponse>>(
        `/api/observability/audit-query${buildQuery(params)}`,
        { signal },
      );
    },

    // ========================================================================
    // Logs — Loki-backed APPLICATION logs (distinct from the audit trail above).
    //
    // Tenancy is enforced server-side by the Loki tenant header, derived from the
    // caller's verified token: an org physically cannot read another org's lines,
    // and that applies to the raw view and the download exactly as to search.
    // Credential-shaped values are masked before they leave the backend.
    //
    // The browser never sends LogQL — only the `q` mini-syntax
    // (`level:error service:platform "connection refused" -noise /re/`), which
    // the server parses against an allow-list and compiles.
    // ========================================================================

    /** Search log entries. `window` is a preset range or an absolute from/to (unix ms). */
    logSearch: async (
      params: import('@/types/logs').LogQueryParams,
      signal?: AbortSignal,
    ) => {
      return core.request<ApiResponse<import('@/types/logs').LogSearchResponse>>(
        `/api/observability/logs${buildQuery(logQueryToParams(params))}`,
        { signal },
      );
    },

    /** Per-level counts across the window, for the volume histogram. */
    logVolume: async (
      params: import('@/types/logs').LogQueryParams,
      signal?: AbortSignal,
    ) => {
      return core.request<ApiResponse<import('@/types/logs').LogVolumeResponse>>(
        `/api/observability/logs/volume${buildQuery(logQueryToParams(params))}`,
        { signal },
      );
    },

    /** Lines either side of one entry, for the "show context" drill-down. */
    logContext: async (
      params: import('@/types/logs').LogQueryParams & { at: number; spanMs?: number },
      signal?: AbortSignal,
    ) => {
      const qs = { ...logQueryToParams(params), at: params.at, spanMs: params.spanMs };
      return core.request<ApiResponse<import('@/types/logs').LogContextResponse>>(
        `/api/observability/logs/context${buildQuery(qs)}`,
        { signal },
      );
    },

    /**
     * The current selection as plain text.
     *
     * Bypasses `core.request` (the endpoint returns text/plain, not the usual
     * envelope) and returns the body for the caller to render or save — the same
     * shape as `exportOrganization`.
     */
    logRaw: async (params: import('@/types/logs').LogQueryParams): Promise<string> => {
      await core.ensureFreshToken();
      const res = await fetch(`${API_URL}/api/observability/logs/raw${buildQuery(logQueryToParams(params))}`, {
        headers: core.authHeaders() as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new ApiError('Failed to load raw logs', res.status);
      return res.text();
    },

    /**
     * Download the current selection as a file.
     *
     * Fetched with auth headers and saved as a Blob rather than linked to
     * directly — a bare `<a href>` cannot carry the Authorization header (same
     * reason `fetchAttachmentBlob` exists). Requires `logs:export`.
     */
    logExport: async (
      params: import('@/types/logs').LogQueryParams & { format?: 'log' | 'jsonl'; name?: string },
    ): Promise<{ blob: Blob; filename: string }> => {
      await core.ensureFreshToken();
      const qs = { ...logQueryToParams(params), format: params.format ?? 'log', name: params.name };
      const res = await fetch(`${API_URL}/api/observability/logs/export${buildQuery(qs)}`, {
        headers: core.authHeaders() as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new ApiError('Log export failed', res.status);
      // Prefer the server's filename (it is sanitized there) over rebuilding one.
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      return {
        blob: await res.blob(),
        filename: match?.[1] ?? `logs.${params.format ?? 'log'}`,
      };
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

    /** List the caller's soft-deleted dashboards (tombstones), newest first —
     *  restorable until the retention sweep purges them. Server-side the list is
     *  already narrowed to rows the caller may restore. Powers the
     *  RecentlyDeletedPanel. */
    listDeletedDashboards: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').DashboardsResponse>>(
        '/api/dashboards/deleted',
        { signal },
      );
    },

    /** Restore a soft-deleted dashboard. Step-up gated (it reverses a
     *  destructive action): pass the token from StepUpModal; the api forwards it
     *  as the `X-Step-Up-Token` header. */
    restoreDashboard: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/dashboards/${encodeURIComponent(id)}/restore`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Permanently hard-delete a dashboard tombstone (ahead of the retention
     *  sweep). Irreversible + step-up gated like restore. */
    purgeDashboard: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/dashboards/${encodeURIComponent(id)}/purge`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
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

    /** List this org's soft-deleted destinations (tombstones), newest first.
     *  Targets stay masked exactly as on the live list. */
    listDeletedAlertDestinations: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').AlertDestinationsResponse>>(
        '/api/observability/alert-destinations/deleted',
        { signal },
      );
    },

    /** Restore a soft-deleted destination (step-up gated, like every restore). */
    restoreAlertDestination: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-destinations/${encodeURIComponent(id)}/restore`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Permanently hard-delete a destination tombstone. Irreversible + step-up gated. */
    purgeAlertDestination: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-destinations/${encodeURIComponent(id)}/purge`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Send a labeled test notification to a destination to verify delivery.
     *  Resolves `{ delivered: true }` on success; a send failure comes back as
     *  a non-2xx ApiError whose message carries the downstream reason. */
    testAlertDestination: async (id: string) => {
      return core.request<ApiResponse<{ delivered: boolean }>>(
        `/api/observability/alert-destinations/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
      );
    },

    // ==========================================================================
    // Alert rules (per-org operator-authored PromQL alert rules)
    //
    // Rules define *what fires* (destinations define *where alerts go*). The
    // backend auto-injects an `org_id="<orgId>"` matcher into `expr` and
    // validates PromQL / tenancy / durations server-side (400 on failure), so
    // the frontend passes raw PromQL and surfaces the returned error message.
    // ==========================================================================

    /** List this org's alert rules (sorted by name server-side). */
    listAlertRules: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').AlertRulesResponse>>(
        '/api/observability/alert-rules',
        { signal },
      );
    },

    /** Create an alert rule. `name`, `expr`, and `summary` are required
     *  (observability:write server-side gate). */
    createAlertRule: async (body: import('@/types/observability').AlertRuleWrite) => {
      return core.request<ApiResponse<import('@/types/observability').AlertRuleResponse>>(
        '/api/observability/alert-rules',
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    /** Update an alert rule (partial patch of the create fields). */
    updateAlertRule: async (id: string, body: import('@/types/observability').AlertRuleWrite) => {
      return core.request<ApiResponse<import('@/types/observability').AlertRuleResponse>>(
        `/api/observability/alert-rules/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },

    /** Delete (soft) an alert rule. */
    deleteAlertRule: async (id: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-rules/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    },

    /** List this org's soft-deleted alert rules (tombstones), newest first. */
    listDeletedAlertRules: async (signal?: AbortSignal) => {
      return core.request<ApiResponse<import('@/types/observability').AlertRulesResponse>>(
        '/api/observability/alert-rules/deleted',
        { signal },
      );
    },

    /** Restore a soft-deleted alert rule. Step-up gated; a restored ENABLED rule
     *  re-enters the Prometheus materializer on its next poll. */
    restoreAlertRule: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-rules/${encodeURIComponent(id)}/restore`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Permanently hard-delete an alert-rule tombstone. Irreversible + step-up gated. */
    purgeAlertRule: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(
        `/api/observability/alert-rules/${encodeURIComponent(id)}/purge`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },
  };
}
