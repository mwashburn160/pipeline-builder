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
