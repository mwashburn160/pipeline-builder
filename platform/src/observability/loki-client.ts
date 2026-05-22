// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Loki HTTP client. Mirrors prometheus-client's shape so the route
 * layer can treat both upstreams symmetrically.
 *
 * Loki's `query_range` endpoint accepts a LogQL string and returns either
 * `matrix` (metric-style queries  count_over_time, etc.) or `streams`
 * (raw log entries). We surface both via separate methods.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';

const logger = createLogger('loki-client');

const DEFAULT_URL = 'http://loki:3100';

export type LokiError =
  | { kind: 'upstream-4xx'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

export interface LokiLogEntry {
  /** Unix nanoseconds (Loki convention). */
  time: string;
  /** The raw log line (Promtail's `output.source: msg` makes this the message body). */
  line: string;
  /** Stream labels at ingest. */
  labels: Record<string, string>;
}

export interface LokiMatrixPoint {
  time: number;
  value: string;
}

export interface LokiMatrixSeries {
  labels: Record<string, string>;
  values: LokiMatrixPoint[];
}

interface LokiResponseEnvelope {
  status: 'success' | 'error';
  data?: {
    resultType: 'streams' | 'matrix' | 'vector';
    result: unknown;
  };
  errorType?: string;
  error?: string;
}

interface RawLokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

interface RawLokiMatrixSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

function lokiUrl(): string {
  return process.env.LOKI_URL || DEFAULT_URL;
}

/**
 * tenant header. Observability dashboards are cross-org by intent
 * (the operator drilldown that shows every build across the fleet), so
 * we always read from the `system` tenant. In multi-tenant Loki this
 * tenant must be configured with `tenant_federation_enabled` to read
 * across the per-org streams; in single-tenant mode the header is
 * ignored. See docs/plans/f-2-6-loki-multitenant.md for the runbook.
 */
const SYSTEM_TENANT = 'system';

async function callLoki(path: string, params: Record<string, string>, tenant: string = SYSTEM_TENANT): Promise<LokiResponseEnvelope> {
  const url = new URL(path, lokiUrl().endsWith('/') ? lokiUrl(): lokiUrl() + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
      headers: { 'X-Scope-OrgID': tenant },
    });
  } catch (err) {
    const e: LokiError = { kind: 'unreachable', message: errorMessage(err) };
    logger.warn('Loki unreachable', { url: url.toString(), error: e.message });
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e: LokiError = {
      kind: 'upstream-4xx',
      status: res.status,
      message: text || `Loki returned ${res.status}`,
    };
    logger.warn('Loki rejected query', { status: res.status, message: e.message });
    throw e;
  }

  const env = (await res.json()) as LokiResponseEnvelope;
  if (env.status !== 'success' || env.data === undefined) {
    const e: LokiError = {
      kind: 'upstream-4xx',
      status: res.status,
      message: env.error || 'Loki returned non-success envelope',
    };
    throw e;
  }
  return env;
}

/**
 * Run a LogQL range query that returns log entries (`{label=...}` selector
 * + optional pipeline). Empty result is success-with-empty, not error.
 */
export async function queryStreams( logQL: string,
  start: number,
  end: number,
  limit: number,
): Promise<LokiLogEntry[]> {
  const env = await callLoki('loki/api/v1/query_range', {
    query: logQL,
    start: String(start * 1e9), // Loki wants nanoseconds
    end: String(end * 1e9),
    limit: String(limit),
    direction: 'backward', // most-recent-first matches the dashboard's intent
  });
  if (env.data?.resultType !== 'streams') return [];
  const streams = env.data.result as RawLokiStream[];
  const entries: LokiLogEntry[] = [];
  for (const s of streams) {
    for (const [time, line] of s.values) {
      entries.push({ time, line, labels: s.stream });
    }
  }
  return entries;
}

/**
 * Run a LogQL range query that returns a matrix (e.g. `count_over_time`,
 * `sum by (event)(...)`). Each series carries its time-value array.
 */
export async function queryMatrix( logQL: string,
  start: number,
  end: number,
  step: string,
): Promise<LokiMatrixSeries[]> {
  const env = await callLoki('loki/api/v1/query_range', {
    query: logQL,
    start: String(start * 1e9),
    end: String(end * 1e9),
    step,
  });
  if (env.data?.resultType !== 'matrix') return [];
  const raw = env.data.result as RawLokiMatrixSeries[];
  return raw.map((r) => ({
    labels: r.metric,
    values: r.values.map(([t, v]) => ({ time: t, value: v })),
  }));
}
