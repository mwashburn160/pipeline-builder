// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side query catalog for the native Observability dashboards.
 *
 * Frontend asks for a query by key (e.g. `plugin_builds_per_min`); backend
 * looks up the entry here and runs it — PromQL against Prometheus, or a named
 * aggregation over the MongoDB audit trail. This indirection is the security
 * boundary — frontend never sends raw PromQL, so injection / scope-escape
 * attacks have no surface.
 *
 * Adding a new query: pick a key, add an entry. The only PromQL template
 * variable is `$ORG` (server-driven org scoping) — nothing user-supplied is
 * ever spliced into a query string. Audit-store entries take their frontend
 * filters (`allowedVars`) as Mongo equality values, never as query text.
 */

/**
 * Where a catalog entry's data lives. `audit-store` is platform's MongoDB audit
 * trail — the tamper-evident, per-org record every service reports into — read
 * through `audit-store-client.ts` rather than Prometheus.
 */
export type QuerySource = 'prometheus-instant' | 'prometheus-range' | 'audit-store';

/** Canonical range keys understood by the observability controller. */
export type RangeKey = '1h' | '6h' | '24h';

/** Named aggregations over the MongoDB audit trail (see `audit-store-client.ts`). */
export type AuditStoreQuery = 'events_by_action' | 'top_actors_24h' | 'recent_events';

interface QueryEntryBase {
  /**
   * When true, results are confined to the caller's org (sysadmins see every
   * org): Prometheus entries via `$ORG` substitution on an `org_id` label,
   * `audit-store` entries via the audit trail's `orgId`/`affectedOrgId`.
   * Entries with no org context (fleet-wide health metrics) omit it and are
   * sysadmin-only.
   */
  orgScoped?: boolean;
  /**
   * Readable only by org admins (and sysadmins), even though org-scoped — for
   * data that is an admin surface in its own right. Audit entries set it to
   * match `GET /audit`, which is admin-gated.
   */
  adminOnly?: boolean;
}

/** A Prometheus entry: a raw PromQL string. */
export interface PrometheusQueryEntry extends QueryEntryBase {
  source: 'prometheus-instant' | 'prometheus-range';
  /** Raw PromQL. May contain the `$ORG` placeholder (see `substituteOrg`). */
  query: string;
}

/** An entry served from the MongoDB audit trail by a named aggregation. */
export interface AuditStoreQueryEntry extends QueryEntryBase {
  source: 'audit-store';
  query: AuditStoreQuery;
  /**
   * How the result renders: `stream` → individual events (`{entries}`),
   * `matrix` → aggregated series (`{series}`).
   */
  kind: 'stream' | 'matrix';
  /** Filters the frontend may pass (event = exact action, actor = id or email,
   *  requestId = one HTTP request's events). Anything else is dropped. */
  allowedVars?: ReadonlyArray<'event' | 'actor' | 'requestId'>;
}

export type QueryEntry = PrometheusQueryEntry | AuditStoreQueryEntry;

export const QUERIES: Record<string, QueryEntry> = {
  // -- Platform Overview dashboard --------------------------------------------
  // The count gauges are sampled by EVERY platform replica (observability/
  // scraper.ts), so each exists once per pod with the same value; `max` collapses
  // them to one series and ignores a pod that has not sampled yet.
  platform_orgs_total: {
    source: 'prometheus-instant',
    query: 'max(platform_orgs_total)',
  },
  platform_users_total: {
    source: 'prometheus-instant',
    query: 'max(platform_users_total)',
  },
  platform_logins_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(platform_logins_total[24h]))',
  },
  platform_logins_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(platform_logins_total[1m]))',
  },
  platform_memberships_active_total: {
    source: 'prometheus-instant',
    query: 'max(platform_memberships_active_total)',
  },

  // -- Plugin Builds dashboard ------------------------------------------------
  // These queries have an `org_id` label on the underlying counter, so they
  // support org-scoping. `$ORG` is substituted server-side per request.
  plugin_builds_per_min: {
    source: 'prometheus-range',
    // `status!=""` is the always-present, non-empty anchor matcher Prometheus
    // requires (selectors need at least one non-empty matcher); every emitted
    // sample carries a status label, so this matches all build samples without
    // an artificial `org_id=~".+"`. `$ORG` adds the per-caller scoping suffix.
    query: 'sum by (status) (rate(plugin_builds_total{status!=""$ORG}[1m]))',
    orgScoped: true,
  },
  plugin_build_success_rate_5m: {
    source: 'prometheus-range',
    // See plugin_builds_per_min for the `status!=""` rationale — used as the
    // denominator anchor here so total-builds includes failed + success.
    // The denominator is filtered with `> 0` (no builds → no sample → gap),
    // NOT clamp_min(…, 1): the rate is builds/SECOND, so clamping it to 1
    // inflated the denominator for any real workload (e.g. 0.05 builds/s)
    // and reported a near-zero success ratio.
    query:
      'sum(rate(plugin_builds_total{status="success"$ORG}[5m])) '
      + '/ (sum(rate(plugin_builds_total{status!=""$ORG}[5m])) > 0)',
    orgScoped: true,
  },
  plugin_queue_depth: {
    source: 'prometheus-range',
    query: 'sum by (queue, state) (plugin_queue_jobs)',
  },

  // -- Plugin autoscaling visibility --------------------------------------
  // The KEDA ScaledObject in plugin.yaml has three independent triggers
  // (queue depth, pod CPU, pod memory). These keys let operators see
  // (a) the current replica count — did scaling actually happen, and
  // (b) the per-trigger signal values — so threshold tuning is grounded.

  // Replica count derived from the Prometheus pod-discovery scrape. Each
  // plugin pod's /metrics is scraped independently; `up == 1` is one
  // time series per healthy pod. No new metric source required.
  plugin_replicas: {
    source: 'prometheus-range',
    query: 'count(up{service="plugin"} == 1)',
  },
  // Exact value KEDA's `type: prometheus` trigger reads each polling
  // cycle. Compare against the trigger's threshold=2 to predict the
  // target replica count: target = ceil(value / 2).
  plugin_keda_trigger_queue: {
    source: 'prometheus-range',
    query: 'sum(plugin_queue_jobs{state=~"waiting|active"})',
  },
  // Per-pod CPU rate from prom-client's collectDefaultMetrics(). Process-
  // level (not cgroup-level), so absolute numbers differ slightly from
  // what KEDA's `type: cpu` trigger reads from metrics-server — but the
  // shape matches: saturation here means saturation there.
  plugin_pod_cpu_seconds_rate: {
    source: 'prometheus-range',
    query: 'sum by (instance) (rate(process_cpu_seconds_total{service="plugin"}[1m]))',
  },
  plugin_pod_memory_bytes: {
    source: 'prometheus-range',
    query: 'sum by (instance) (process_resident_memory_bytes{service="plugin"})',
  },
  plugin_build_p95_duration_sec: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.95, sum by (le) (rate(plugin_build_duration_seconds_bucket[5m])))',
  },
  plugin_builds_total_24h: {
    source: 'prometheus-instant',
    // `status!=""` anchors the selector without an artificial org_id matcher;
    // every emitted plugin_builds_total sample carries a status label.
    query: 'sum(increase(plugin_builds_total{status!=""$ORG}[24h]))',
    orgScoped: true,
  },

  // -- Queue Health dashboard -------------------------------------------------
  plugin_job_wait_p50: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.5, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
  },
  plugin_job_wait_p95: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.95, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
  },
  plugin_job_wait_p99: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.99, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
  },
  plugin_dlq_size: {
    source: 'prometheus-range',
    query: 'sum by (state) (plugin_queue_jobs{queue="plugin-build-dlq"})',
  },
  // Renamed from the former "plugin_retry_rate" key. The canonical seed JSON
  // (observability/dashboards/queue-health.json, loaded by the in-process
  // dashboard seeder) references the new key.
  plugin_failed_builds_rate_5m: {
    source: 'prometheus-range',
    query: 'sum(rate(plugin_builds_total{status="failed"}[5m]))',
  },

  // -- Registry Activity dashboard --------------------------------------------
  registry_copies_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_copy_total[1m]))',
  },
  registry_deletes_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_delete_total[1m]))',
  },
  registry_promotions_per_hour: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_promote_total[1h])) * 3600',
  },
  registry_copies_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_copy_total[24h]))',
  },
  registry_deletes_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_delete_total[24h]))',
  },
  registry_promotions_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_promote_total[24h]))',
  },

  // -- Audit Activity dashboard ----------------------------------------------
  // Served from the MongoDB audit trail: the complete record (every service
  // reports into it via platform's `POST /audit/events`), and every row carries
  // `orgId`/`affectedOrgId`, so an org admin gets their own org's trail — the
  // same rows `GET /audit` shows them. adminOnly mirrors `GET /audit`.
  audit_events_per_hour_by_event: {
    source: 'audit-store',
    query: 'events_by_action',
    orgScoped: true,
    adminOnly: true,
    kind: 'matrix',
  },
  audit_recent_events: {
    source: 'audit-store',
    query: 'recent_events',
    // event = exact action, actor = actor id or email, requestId = pull every
    // audited action from one HTTP request.
    allowedVars: ['event', 'actor', 'requestId'],
    orgScoped: true,
    adminOnly: true,
    kind: 'stream',
  },
  audit_top_actors_24h: {
    source: 'audit-store',
    query: 'top_actors_24h',
    orgScoped: true,
    adminOnly: true,
    kind: 'matrix',
  },
};

/** Who is asking — the two authorities a catalog entry can require. */
export interface CatalogCaller {
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
}

/**
 * Whether a caller may run the catalog entry for `key`. Sysadmins may run any
 * entry. An `orgScoped` entry is confined to the caller's org, so an org member
 * may run it — an org ADMIN when it's also `adminOnly` (the audit trail). An
 * entry that is NOT `orgScoped` is fleet-wide (platform totals, queue/registry
 * metrics) and is sysadmin-only. Unknown keys are never queryable.
 *
 * Single source of truth for the query gate (observability controller) AND for
 * withholding what a caller couldn't render anyway — catalog-picker entries,
 * dashboard panels, and dashboards left with no renderable panel.
 */
export function canQueryCatalogKey(key: string, caller: CatalogCaller): boolean {
  if (!Object.hasOwn(QUERIES, key)) return false;
  if (caller.isSuperAdmin) return true;
  const entry = QUERIES[key];
  if (entry.orgScoped !== true) return false;
  return entry.adminOnly !== true || caller.isOrgAdmin;
}

/**
 * Substitute the server-driven `$ORG` placeholder into a PromQL query. Never
 * user-supplied: the org comes from the caller's token. Sysadmins get a regex
 * wildcard so they see all orgs; org members get a literal match on their org.
 * replaceAll, not replace: several queries reference `$ORG` more than once
 * (e.g. the success-rate ratio divides two plugin_builds_total sums, each
 * carrying `$ORG`); a leftover literal `$ORG` is rejected by Prometheus.
 */
export function substituteOrg(query: string, vars: { org?: string; isSuperAdmin?: boolean }): string {
  if (vars.isSuperAdmin) return query.replaceAll('$ORG', ',org_id=~".+"');
  if (vars.org && /^[a-zA-Z0-9_-]+$/.test(vars.org)) return query.replaceAll('$ORG', `,org_id="${vars.org}"`);
  // Missing/invalid org for a non-sysadmin — substitute an impossible match so
  // the query returns nothing rather than leaking all data.
  return query.replaceAll('$ORG', ',org_id="__no_org__"');
}

/**
 * Single source of truth for the supported range presets. `seconds` is the
 * lookback window; `step` is the Prometheus query resolution chosen so charts
 * land near ~240–360 points (1h@15s, 6h@1m, 24h@5m) — comfortable for line
 * rendering without overwhelming the response payload.
 */
export const RANGES: Record<RangeKey, { seconds: number; step: string }> = {
  '1h': { seconds: 3600, step: '15s' },
  '6h': { seconds: 21_600, step: '60s' },
  '24h': { seconds: 86_400, step: '300s' },
};

/**
 * Fallback step used for any range value not in `RANGES`. Deliberately
 * coarser than the 1h step (15s) so an unknown range doesn't accidentally
 * generate a huge response from Prometheus — '60s' matches the 6h
 * preset's step, which is the historical default.
 *
 * `parseRange()` in the controller now rejects unknown ranges with HTTP
 * 400, so this fallback is reachable only by callers that bypass the
 * controller (tests, scripts) — but the contract is preserved.
 */
const FALLBACK_STEP = '60s';
const FALLBACK_SECONDS = 3600;

/** Auto-scale Prometheus `step` based on the requested range. */
export function stepForRange(range: string): string {
  return (RANGES as Record<string, { step: string }>)[range]?.step ?? FALLBACK_STEP;
}

/** Convert a range string to the equivalent number of seconds. */
export function rangeSeconds(range: string): number {
  return (RANGES as Record<string, { seconds: number }>)[range]?.seconds ?? FALLBACK_SECONDS;
}
