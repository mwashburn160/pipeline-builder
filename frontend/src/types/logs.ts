// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Types for the Logs surface (Loki-backed application logs).
 *
 * Distinct from `types/observability.ts`'s `ObservabilityLogEntry`, which is an
 * AUDIT-trail row. Both were once reachable through an endpoint called "logs";
 * only these are logs.
 */

/** Presets offered alongside the absolute picker. Must match the server's list. */
export type LogRangePreset = '15m' | '1h' | '6h' | '24h' | '7d';

/**
 * A query window: a preset, or an absolute pair.
 *
 * Deliberately NOT the observability `RangeKey` union ('1h'|'6h'|'24h'), which is
 * baked into the Prometheus catalog, the controller and `RangePicker`. Logs need
 * arbitrary ranges; widening the shared type would have forced churn on every
 * metrics panel for no benefit.
 */
export type LogWindow =
  | { kind: 'preset'; key: LogRangePreset }
  | { kind: 'absolute'; fromMs: number; toMs: number };

export interface LogQueryParams {
  window: LogWindow;
  /** The search-box mini-syntax; parsed and compiled server-side, never LogQL. */
  q?: string;
  limit?: number;
  /** Sysadmin-only: which Loki tenants to read. `['all']` enumerates (capped). */
  orgs?: string[];
}

/** One log line. `labels` carries stream labels plus structured metadata. */
export interface LogEntry {
  /** Unix milliseconds. */
  time: number;
  /** Already masked server-side — never render an unmasked line. */
  line: string;
  labels: Record<string, string>;
}

/** The window the server actually served, which may be narrower than requested. */
export interface ServedWindow {
  from: number;
  to: number;
  /** True when the request exceeded the retention window and was clamped. */
  clamped: boolean;
}

export interface LogSearchResponse {
  entries: LogEntry[];
  window: ServedWindow;
  /** True when the log backend was unreachable (e.g. a LEAN deploy omits Loki). */
  degraded?: boolean;
}

/** One histogram series — same shape as a Prometheus range result, so the
 *  existing chart panels can render it unchanged. */
export interface LogVolumeSeries {
  labels: Record<string, string>;
  /** `time` is unix SECONDS here, matching the metrics wire format. */
  values: Array<{ time: number; value: string }>;
}

export interface LogVolumeResponse {
  series: LogVolumeSeries[];
  step: string;
  window: ServedWindow;
  degraded?: boolean;
}

export interface LogContextResponse {
  /** Oldest-first, ending just before the anchor entry. */
  before: LogEntry[];
  /** Starting at the anchor entry, oldest-first. */
  after: LogEntry[];
  degraded?: boolean;
}

/** Severity ordering for the level rail / filter chips. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

/** Normalize the many spellings services emit ('warning', 'ERROR', 'fatal'). */
export function normalizeLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (v === 'error' || v === 'err' || v === 'fatal' || v === 'critical') return 'error';
  if (v === 'warn' || v === 'warning') return 'warn';
  if (v === 'info' || v === 'information' || v === 'notice') return 'info';
  if (v === 'debug' || v === 'trace' || v === 'verbose') return 'debug';
  return undefined;
}
