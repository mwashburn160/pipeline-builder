// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
export interface LogEntry {
  /** Unix nanoseconds (Loki convention; render as Date(time/1e6)). */
  time: string;
  line: string;
  labels: Record<string, string>;
}

/** Response shape from `GET /api/observability/logs`. */
export type ObservabilityLogsResponse =
  | { entries: LogEntry[]; range: string }
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
