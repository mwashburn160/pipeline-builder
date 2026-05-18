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
  /** Raw PromQL or LogQL. May contain `$EVENT`, `$DIGEST`, `$ACTOR` placeholders. */
  query: string;
  /** Allow-list of template variables the frontend may pass for this query. */
  allowedVars: ReadonlyArray<'event' | 'digest' | 'actor'>;
}

export const QUERIES: Record<string, QueryEntry> = {
  // -- Plugin Builds dashboard ------------------------------------------------
  plugin_builds_per_min: {
    source: 'prometheus-range',
    query: 'sum by (status) (rate(plugin_builds_total[1m]))',
    allowedVars: [],
  },
  plugin_build_success_rate_5m: {
    source: 'prometheus-range',
    query:
      'sum(rate(plugin_builds_total{status="success"}[5m])) '
      + '/ clamp_min(sum(rate(plugin_builds_total[5m])), 1)',
    allowedVars: [],
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
    query: 'sum(increase(plugin_builds_total[24h]))',
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
  vars: { event?: string; digest?: string; actor?: string },
  allowed: ReadonlyArray<'event' | 'digest' | 'actor'>,
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
