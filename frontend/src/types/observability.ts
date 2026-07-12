// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Quick-pick window for observability panels. The catalog/backend accepts
 *  these literal strings; keep in sync with the RangePicker preset list. */
export type RangeKey = '1h' | '6h' | '24h';

/** Time-value point in a Prometheus or Loki series. */
export interface DataPoint {
  /** Unix seconds. */
  time: number;
  /** Value as string (Prometheus/Loki wire format — JS-parse downstream). */
  value: string;
}

/** One series in a range query result. */
export interface DataSeries {
  /** Label-set identifying this series (e.g. `{status:"success"}`). */
  labels: Record<string, string>;
  values: DataPoint[];
}

/** Single sample from an instant query. */
export interface InstantSample {
  time: number;
  value: string;
  labels: Record<string, string>;
}

/** Response shape from `GET /api/observability/query`. */
export type ObservabilityQueryResponse =
  | { samples: InstantSample[] }
  | { series: DataSeries[]; range: string; step: string };

/** A single log entry from `GET /api/observability/logs` (streams response). */
export interface ObservabilityLogEntry {
  /** Unix nanoseconds (Loki convention; render as Date(time/1e6)). */
  time: string;
  line: string;
  labels: Record<string, string>;
}

/** Response shape from `GET /api/observability/logs`. */
export type ObservabilityLogsResponse =
  | { entries: ObservabilityLogEntry[]; range: string }
  | { series: DataSeries[]; range: string; step: string };

/** Optional templated params accepted by `GET /api/observability/logs`. */
export interface ObservabilityLogsParams {
  range?: string;
  limit?: number;
  event?: string;
  digest?: string;
  actor?: string;
  /** Plugin name — used by the per-plugin drill-down's recent-builds query. */
  plugin?: string;
}

/** A single Alertmanager-v2 alert. Mirrors the backend Alert type. */
export interface Alert {
  fingerprint: string;
  status: {
    state: 'active' | 'suppressed' | 'unprocessed';
    silencedBy?: string[];
    inhibitedBy?: string[];
  };
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  generatorURL?: string;
}

/** Response shape from `GET /api/observability/alerts`. */
export interface AlertsResponse {
  alerts: Alert[];
}

/** A single silence rule. */
export interface Silence {
  id: string;
  status: { state: 'active' | 'expired' | 'pending' };
  matchers: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }>;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
}

/** Response shape from `GET /api/observability/silences`. */
export interface SilencesResponse {
  silences: Silence[];
}

/** Single catalog entry as exposed by `GET /api/observability/catalog`. The
 *  raw PromQL/LogQL is intentionally omitted from this surface. */
export interface CatalogEntry {
  key: string;
  source: 'prometheus-instant' | 'prometheus-range' | 'loki-range';
  allowedVars: ReadonlyArray<'event' | 'digest' | 'actor' | 'plugin'>;
  orgScoped: boolean;
}

export interface CatalogResponse {
  entries: CatalogEntry[];
}

/** Per-org alert destination as returned by the API. Note `target` is
 *  masked on reads — only the last 12 chars + a leading mask are exposed
 *  even to the owner org. */
export interface AlertDestination {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  channel: 'slack' | 'webhook' | 'in-app' | 'email';
  /** Masked URL/address (e.g. `••••XXXXXXXXXXXX`). Use `hasTarget` to know whether it's set. */
  target: string;
  hasTarget: boolean;
  label: string;
  minSeverity: 'warning' | 'critical';
  enabled: boolean;
}

export interface AlertDestinationsResponse {
  destinations: AlertDestination[];
}

export interface AlertDestinationResponse {
  destination: AlertDestination;
}

/** Body for POST/PUT on alert destinations. `target` is the raw secret URL
 *  on writes; empty string on update means "leave existing value". */
export interface AlertDestinationWrite {
  channel?: 'slack' | 'webhook' | 'in-app' | 'email';
  target?: string;
  label?: string;
  minSeverity?: 'warning' | 'critical';
  enabled?: boolean;
}

/** Per-org operator-authored alert rule as returned by the API. The stored
 *  `expr` already carries the auto-injected `org_id="<orgId>"` matcher — the
 *  service scopes the rule to the caller's org before persisting. */
export interface AlertRule {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Operator-supplied rule name (letters, digits, space, _, -; <= 100 chars). */
  name: string;
  /** PromQL expression. The service injects/validates the `org_id` matcher. */
  expr: string;
  /** Prometheus `for:` duration (e.g. `5m`). */
  forDuration: string;
  severity: 'warning' | 'critical';
  /** Alertmanager `summary` annotation (required, <= 500 chars). */
  summary: string;
  /** Alertmanager `description` annotation. `''` when unset. */
  description: string;
  /** Disabled rules don't materialize into Prometheus. */
  enabled: boolean;
}

export interface AlertRulesResponse {
  rules: AlertRule[];
}

export interface AlertRuleResponse {
  rule: AlertRule;
}

/** Body for POST/PUT on alert rules. `name`, `expr`, and `summary` are
 *  required on create; PUT is a partial patch of the same fields. The backend
 *  auto-injects the `org_id` matcher into `expr` and returns 400s on malformed
 *  PromQL / cross-tenant matchers / invalid durations. */
export interface AlertRuleWrite {
  name?: string;
  expr?: string;
  forDuration?: string;
  severity?: 'warning' | 'critical';
  summary?: string;
  description?: string;
  enabled?: boolean;
}

/** A single panel inside a DB-stored dashboard. */
export interface DashboardPanel {
  id: string;
  dashboardId: string;
  queryKey: string;
  vizKind: string;
  title: string;
  span: number;
  groupBy: string | null;
  format: string | null;
  position: number;
  vars: Record<string, string>;
}

/** A DB-stored, user-editable dashboard. */
export interface Dashboard {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  name: string;
  description: string | null;
  layoutJson: Record<string, { x: number; y: number; w: number; h: number; minW?: number; minH?: number }>;
  visibility: 'private' | 'org' | 'public';
}

/** Dashboard + its panels in render order — the shape `GET /:id` returns. */
export interface DashboardWithPanels extends Dashboard {
  panels: DashboardPanel[];
}

/** Response shape from `GET /api/dashboards`. */
export interface DashboardsResponse {
  dashboards: Dashboard[];
}

/** Response shape from `GET /api/dashboards/:id`. */
export interface DashboardResponse {
  dashboard: DashboardWithPanels;
}

/** Body shape for `POST /api/dashboards` and `PUT /api/dashboards/:id`. */
export interface DashboardWrite {
  name?: string;
  description?: string | null;
  visibility?: 'private' | 'org' | 'public';
  layoutJson?: Record<string, { x: number; y: number; w: number; h: number; minW?: number; minH?: number }>;
  panels?: Array<{
    queryKey: string;
    vizKind?: string;
    title: string;
    span?: number;
    groupBy?: string | null;
    format?: string | null;
    position?: number;
    vars?: Record<string, string>;
  }>;
}
