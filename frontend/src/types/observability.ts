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
}
