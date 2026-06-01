// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side query catalog for the native Observability dashboards.
 *
 * Frontend asks for a query by key (e.g. `plugin_builds_per_min`); backend
 * looks up the PromQL/LogQL here, substitutes any allowed template
 * variables, and executes against the upstream Prometheus or Loki. This
 * indirection is the security boundary — frontend never sends raw
 * PromQL/LogQL, so injection / scope-escape attacks have no surface.
 *
 * Adding a new query: pick a key, add an entry. Template variables are
 * limited to `$EVENT`, `$ACTOR`, `$PLUGIN` (frontend-supplied, sanitized)
 * and `$ORG` (server-driven scoping) — nothing else is allowed in catalog
 * strings.
 */

export type QuerySource = 'prometheus-instant' | 'prometheus-range' | 'loki-range';

/** Canonical range keys understood by the observability controller. */
export type RangeKey = '1h' | '6h' | '24h';

export interface QueryEntry {
  source: QuerySource;
  /** Raw PromQL or LogQL. May contain `$EVENT`, `$ACTOR`, `$PLUGIN`, `$ORG` placeholders. */
  query: string;
  /** Allow-list of template variables the frontend may pass for this query. */
  allowedVars: ReadonlyArray<'event' | 'actor' | 'plugin'>;
  /**
   * When true, the controller substitutes `$ORG` with the caller's org
   * (sysadmins get a regex wildcard, org admins get their literal org).
   * Catalog entries that aggregate over an `org_id` label should set this;
   * entries that have no org context (global health metrics) can omit it.
   */
  orgScoped?: boolean;
  /**
   * Explicit hint for how a `loki-range` query's results should be rendered:
   *   - `stream`  → raw log lines (use `/api/observability/logs`, returns `{entries}`)
   *   - `matrix`  → aggregated time series (returns `{series}`)
   * When omitted, the controller falls back to a syntactic heuristic on the
   * query body — prefer setting this explicitly on new Loki entries.
   */
  kind?: 'stream' | 'matrix';
}

export const QUERIES: Record<string, QueryEntry> = {
  // -- Platform Overview dashboard --------------------------------------------
  platform_orgs_total: {
    source: 'prometheus-instant',
    query: 'platform_orgs_total',
    allowedVars: [],
  },
  platform_users_total: {
    source: 'prometheus-instant',
    query: 'platform_users_total',
    allowedVars: [],
  },
  platform_logins_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(platform_logins_total[24h]))',
    allowedVars: [],
  },
  platform_logins_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(platform_logins_total[1m]))',
    allowedVars: [],
  },
  platform_memberships_active_total: {
    source: 'prometheus-instant',
    query: 'platform_memberships_active_total',
    allowedVars: [],
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
    allowedVars: [],
    orgScoped: true,
  },
  plugin_build_success_rate_5m: {
    source: 'prometheus-range',
    // See plugin_builds_per_min for the `status!=""` rationale — used as the
    // denominator anchor here so total-builds includes failed + success.
    query:
      'sum(rate(plugin_builds_total{status="success"$ORG}[5m])) '
      + '/ clamp_min(sum(rate(plugin_builds_total{status!=""$ORG}[5m])), 1)',
    allowedVars: [],
    orgScoped: true,
  },
  plugin_queue_depth: {
    source: 'prometheus-range',
    query: 'sum by (queue, state) (plugin_queue_jobs)',
    allowedVars: [],
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
    allowedVars: [],
  },
  // Exact value KEDA's `type: prometheus` trigger reads each polling
  // cycle. Compare against the trigger's threshold=2 to predict the
  // target replica count: target = ceil(value / 2).
  plugin_keda_trigger_queue: {
    source: 'prometheus-range',
    query: 'sum(plugin_queue_jobs{state=~"waiting|active"})',
    allowedVars: [],
  },
  // Per-pod CPU rate from prom-client's collectDefaultMetrics(). Process-
  // level (not cgroup-level), so absolute numbers differ slightly from
  // what KEDA's `type: cpu` trigger reads from metrics-server — but the
  // shape matches: saturation here means saturation there.
  plugin_pod_cpu_seconds_rate: {
    source: 'prometheus-range',
    query: 'sum by (instance) (rate(process_cpu_seconds_total{service="plugin"}[1m]))',
    allowedVars: [],
  },
  plugin_pod_memory_bytes: {
    source: 'prometheus-range',
    query: 'sum by (instance) (process_resident_memory_bytes{service="plugin"})',
    allowedVars: [],
  },
  plugin_build_p95_duration_sec: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.95, sum by (le) (rate(plugin_build_duration_seconds_bucket[5m])))',
    allowedVars: [],
  },
  plugin_builds_total_24h: {
    source: 'prometheus-instant',
    // `status!=""` anchors the selector without an artificial org_id matcher;
    // every emitted plugin_builds_total sample carries a status label.
    query: 'sum(increase(plugin_builds_total{status!=""$ORG}[24h]))',
    allowedVars: [],
    orgScoped: true,
  },

  // -- Queue Health dashboard -------------------------------------------------
  plugin_job_wait_p50: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.5, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
    allowedVars: [],
  },
  plugin_job_wait_p95: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.95, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
    allowedVars: [],
  },
  plugin_job_wait_p99: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.99, sum by (le) (rate(plugin_job_wait_seconds_bucket[5m])))',
    allowedVars: [],
  },
  plugin_dlq_size: {
    source: 'prometheus-range',
    query: 'sum by (state) (plugin_queue_jobs{queue="plugin-build-dlq"})',
    allowedVars: [],
  },
  // Renamed from the former "plugin_retry_rate" key. The canonical seed JSON
  // (observability/dashboards/queue-health.json, loaded by the in-process
  // dashboard seeder) references the new key.
  plugin_failed_builds_rate_5m: {
    source: 'prometheus-range',
    query: 'sum(rate(plugin_builds_total{status="failed"}[5m]))',
    allowedVars: [],
  },

  // -- Registry Activity dashboard --------------------------------------------
  registry_copies_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_copy_total[1m]))',
    allowedVars: [],
  },
  registry_deletes_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_delete_total[1m]))',
    allowedVars: [],
  },
  registry_promotions_per_hour: {
    source: 'prometheus-range',
    query: 'sum(rate(registry_tag_promote_total[1h])) * 3600',
    allowedVars: [],
  },
  registry_copies_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_copy_total[24h]))',
    allowedVars: [],
  },
  registry_deletes_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_delete_total[24h]))',
    allowedVars: [],
  },
  registry_promotions_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(registry_tag_promote_total[24h]))',
    allowedVars: [],
  },

  // -- Audit Activity dashboard ----------------------------------------------
  // not orgScoped: audit log stream has no org_id label; relies on platform-only RBAC
  audit_events_per_hour_by_event: {
    source: 'loki-range',
    query: 'sum by (event) (count_over_time({eventCategory="audit"}[1h]))',
    allowedVars: [],
    kind: 'matrix',
  },
  // not orgScoped: audit log stream has no org_id label; relies on platform-only RBAC
  audit_recent_events: {
    source: 'loki-range',
    query: '{eventCategory="audit"$EVENT$ACTOR}',
    allowedVars: ['event', 'actor'],
    kind: 'stream',
  },
  // not orgScoped: audit log stream has no org_id label; relies on platform-only RBAC
  audit_top_actors_24h: {
    source: 'loki-range',
    query: 'topk(10, sum by (actor) (count_over_time({eventCategory="audit"}[24h])))',
    allowedVars: [],
    kind: 'matrix',
  },
};

/**
 * Substitute allowed template variables into a catalog query. Unknown
 * placeholders are left as-is on purpose: if the catalog declares a
 * variable but the frontend didn't send it, we drop it cleanly rather
 * than leaving a literal `$EVENT` in the query.
 *
 * Template syntax is bespoke (not regex injection) so callers can't
 * compose a different query by sending crafted variable values — the
 * variable values get sanitized to allow only the character set of
 * legitimate audit-event names and actor IDs.
 */
export function substituteVars(
  query: string,
  vars: { event?: string; actor?: string; plugin?: string; org?: string; isSuperAdmin?: boolean },
  allowed: ReadonlyArray<'event' | 'actor' | 'plugin'>,
): string {
  let result = query;

  // event: alphanumerics + . + - + _ (matches our event-naming convention)
  const eventClause = allowed.includes('event') && vars.event && /^[a-zA-Z0-9._-]+$/.test(vars.event)
    ? `,event="${vars.event}"` : '';
  result = result.replaceAll('$EVENT', eventClause);

  // actor: alphanumerics + - + _ + . + @ (covers user IDs and service principals)
  const actorClause = allowed.includes('actor') && vars.actor && /^[a-zA-Z0-9._@-]+$/.test(vars.actor)
    ? `,actor="${vars.actor}"` : '';
  result = result.replaceAll('$ACTOR', actorClause);

  // plugin: alphanumerics + . + - + _ (plugin names follow the same convention
  // as events). Substituted as a literal label match — used by the per-plugin
  // drill-down panel and its supporting Loki recent-builds query.
  if (allowed.includes('plugin') && vars.plugin && /^[a-zA-Z0-9._-]+$/.test(vars.plugin)) {
    result = result.replaceAll('$PLUGIN', vars.plugin);
  } else {
    // Drop the placeholder entirely if the caller didn't supply a valid plugin.
    // The query templates wrap $PLUGIN in `plugin_name="$PLUGIN"` which would
    // become `plugin_name=""` — matches nothing, the right failure mode.
    result = result.replaceAll('$PLUGIN', '');
  }

  // org: substituted by the controller (not from the frontend). Sysadmins
  // get a regex wildcard so they see all orgs; org admins get a literal
  // match scoped to their org. The substitution happens regardless of
  // `allowed` — `$ORG` is server-driven, not user-supplied.
  // replaceAll, not replace: several panel queries reference $ORG more than
  // once (e.g. the success-rate ratio divides two plugin_builds_total sums,
  // each carrying $ORG). String.replace only swaps the first occurrence,
  // leaving a literal `$ORG` in the second matcher that Prometheus rejects
  // with "unexpected character inside braces: '$'".
  if (vars.isSuperAdmin) {
    result = result.replaceAll('$ORG', ',org_id=~".+"');
  } else if (vars.org && /^[a-zA-Z0-9_-]+$/.test(vars.org)) {
    result = result.replaceAll('$ORG', `,org_id="${vars.org}"`);
  } else {
    // Missing/invalid org for a non-sysadmin — substitute empty match so
    // the query returns nothing rather than leaking all data.
    result = result.replaceAll('$ORG', ',org_id="__no_org__"');
  }

  return result;
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
