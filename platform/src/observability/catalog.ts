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
 * limited to `$EVENT`, `$DIGEST`, `$ACTOR` — server substitutes from
 * request query params; nothing else is allowed in catalog strings.
 */

export type QuerySource = 'prometheus-instant' | 'prometheus-range' | 'loki-range';

export interface QueryEntry {
  source: QuerySource;
  /** Raw PromQL or LogQL. May contain `$EVENT`, `$DIGEST`, `$ACTOR`, `$PLUGIN`, `$ORG` placeholders. */
  query: string;
  /** Allow-list of template variables the frontend may pass for this query. */
  allowedVars: ReadonlyArray<'event' | 'digest' | 'actor' | 'plugin'>;
  /**
   * When true, the controller substitutes `$ORG` with the caller's org
   * (sysadmins get a regex wildcard, org admins get their literal org).
   * Catalog entries that aggregate over an `org_id` label should set this;
   * entries that have no org context (global health metrics) can omit it.
   */
  orgScoped?: boolean;
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
  platform_logins_failed_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(platform_logins_failed_total[24h]))',
    allowedVars: [],
  },
  platform_logins_failed_per_min: {
    source: 'prometheus-range',
    query: 'sum(rate(platform_logins_failed_total[1m]))',
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
    query: 'sum by (status) (rate(plugin_builds_total{org_id=~".+"$ORG}[1m]))',
    allowedVars: [],
    orgScoped: true,
  },
  plugin_build_success_rate_5m: {
    source: 'prometheus-range',
    query:
      'sum(rate(plugin_builds_total{status="success"$ORG}[5m])) '
      + '/ clamp_min(sum(rate(plugin_builds_total{org_id=~".+"$ORG}[5m])), 1)',
    allowedVars: [],
    orgScoped: true,
  },
  plugin_queue_depth: {
    source: 'prometheus-range',
    query: 'sum by (queue, state) (plugin_queue_jobs)',
    allowedVars: [],
  },
  plugin_build_p95_duration_sec: {
    source: 'prometheus-range',
    query: 'histogram_quantile(0.95, sum by (le) (rate(plugin_build_duration_seconds_bucket[5m])))',
    allowedVars: [],
  },
  plugin_builds_total_24h: {
    source: 'prometheus-instant',
    query: 'sum(increase(plugin_builds_total{org_id=~".+"$ORG}[24h]))',
    allowedVars: [],
    orgScoped: true,
  },

  // -- Per-plugin drill-down --------------------------------------------------
  // Filtered by `?plugin=<name>` URL param. Server substitutes `$PLUGIN` after
  // sanitization (alphanumerics + `.-_`). Counter-only — durations come from
  // Loki via the recent-builds query below (cardinality safety).
  plugin_builds_for_plugin: {
    source: 'prometheus-range',
    query: 'sum by (status) (rate(plugin_builds_total{plugin_name="$PLUGIN"$ORG}[1m]))',
    allowedVars: ['plugin'],
    orgScoped: true,
  },
  plugin_builds_success_rate_for_plugin: {
    source: 'prometheus-range',
    query:
      'sum(rate(plugin_builds_total{plugin_name="$PLUGIN",status="success"$ORG}[5m])) '
      + '/ clamp_min(sum(rate(plugin_builds_total{plugin_name="$PLUGIN"$ORG}[5m])), 1)',
    allowedVars: ['plugin'],
    orgScoped: true,
  },
  plugin_builds_total_24h_for_plugin: {
    source: 'prometheus-instant',
    query: 'sum(increase(plugin_builds_total{plugin_name="$PLUGIN"$ORG}[24h]))',
    allowedVars: ['plugin'],
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
  plugin_retry_rate: {
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
  audit_events_per_hour_by_event: {
    source: 'loki-range',
    query: 'sum by (event) (count_over_time({eventCategory="audit"}[1h]))',
    allowedVars: [],
  },
  audit_recent_events: {
    source: 'loki-range',
    query: '{eventCategory="audit"$EVENT$ACTOR}',
    allowedVars: ['event', 'actor'],
  },
  audit_top_actors_24h: {
    source: 'loki-range',
    query: 'topk(10, sum by (actor) (count_over_time({eventCategory="audit"}[24h])))',
    allowedVars: [],
  },

  // -- Per-plugin recent builds (Loki-backed, served on per-plugin drill-down) -
  // The plugin queue emits structured logs `{ eventCategory: 'plugin-build',
  // pluginName, event, durationMs|errorMessage }`; promtail promotes the
  // first two to Loki labels. This stream returns each line as-is so the
  // frontend can render a recent-builds table without a roundtrip to the DB.
  plugin_recent_builds: {
    source: 'loki-range',
    query: '{eventCategory="plugin-build", pluginName="$PLUGIN"}',
    allowedVars: ['plugin'],
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
 * legitimate audit-event names, sha256 digests, and actor IDs.
 */
export function substituteVars(
  query: string,
  vars: { event?: string; digest?: string; actor?: string; plugin?: string; org?: string; isSuperAdmin?: boolean },
  allowed: ReadonlyArray<'event' | 'digest' | 'actor' | 'plugin'>,
): string {
  let result = query;

  // event: alphanumerics + . + - + _ (matches our event-naming convention)
  const eventClause = allowed.includes('event') && vars.event && /^[a-zA-Z0-9._-]+$/.test(vars.event)
    ? `,event="${vars.event}"` : '';
  result = result.replace('$EVENT', eventClause);

  // digest: sha256:<hex> — used as line filter, not label selector
  const digestClause = allowed.includes('digest') && vars.digest && /^sha256:[a-f0-9]{64}$/.test(vars.digest)
    ? ` |= \`${vars.digest}\`` : '';
  result = result.replace('$DIGEST', digestClause);

  // actor: alphanumerics + - + _ + . + @ (covers user IDs and service principals)
  const actorClause = allowed.includes('actor') && vars.actor && /^[a-zA-Z0-9._@-]+$/.test(vars.actor)
    ? `,actor="${vars.actor}"` : '';
  result = result.replace('$ACTOR', actorClause);

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
  if (vars.isSuperAdmin) {
    result = result.replace('$ORG', ',org_id=~".+"');
  } else if (vars.org && /^[a-zA-Z0-9_-]+$/.test(vars.org)) {
    result = result.replace('$ORG', `,org_id="${vars.org}"`);
  } else {
    // Missing/invalid org for a non-sysadmin — substitute empty match so
    // the query returns nothing rather than leaking all data.
    result = result.replace('$ORG', ',org_id="__no_org__"');
  }

  return result;
}

/**
 * Auto-scale Prometheus `step` based on the requested range. Tuned so a
 * 1h chart has ~240 points (15s step), 6h has ~360 points (1m step),
 * and 24h has ~288 points (5m step) — all comfortable for line rendering
 * without overwhelming the response payload.
 */
export function stepForRange(range: string): string {
  switch (range) {
    case '1h': return '15s';
    case '6h': return '60s';
    case '24h': return '300s';
    default: return '60s';
  }
}

/** Convert a range string to the equivalent number of seconds. */
export function rangeSeconds(range: string): number {
  switch (range) {
    case '1h': return 3600;
    case '6h': return 21_600;
    case '24h': return 86_400;
    default: return 3600;
  }
}
