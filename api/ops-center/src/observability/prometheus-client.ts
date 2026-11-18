// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Prometheus HTTP client over {@link callUpstream}. The base URL is read
 * per call from `config.observability.prometheusUrl`.
 */

import { callUpstream, upstreamRejected } from './upstream.js';
import { config } from '../config/index.js';

/** Per-query timeout. */
const QUERY_TIMEOUT_MS = 15_000;

export interface PromInstantSample {
  /** Unix seconds (Prometheus convention). */
  time: number;
  /** The value as a stringified float, per Prometheus' wire format. */
  value: string;
  /** Series labels (sans the implicit __name__). */
  labels: Record<string, string>;
}

export interface PromRangePoint {
  time: number;
  value: string;
}

export interface PromRangeSeries {
  labels: Record<string, string>;
  values: PromRangePoint[];
}

interface PromResponseEnvelope<T> {
  status: 'success' | 'error';
  data?: { resultType: string; result: T };
  errorType?: string;
  error?: string;
}

interface RawInstantResult {
  metric: Record<string, string>;
  value: [number, string];
}

interface RawRangeResult {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

async function callProm<T>(path: string, params: Record<string, string>): Promise<T> {
  const base = config.observability.prometheusUrl;
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const env = await callUpstream<PromResponseEnvelope<T>>(url.toString(), {
    backend: 'Prometheus',
    timeoutMs: QUERY_TIMEOUT_MS,
    logContext: { url: url.toString() },
  });
  if (env.status !== 'success' || env.data === undefined) {
    throw upstreamRejected(200, env.error || 'Prometheus returned non-success envelope');
  }
  return env.data.result;
}

/** Run an instant query. Returns 0+ samples (one per matching series). */
export async function query(promQL: string): Promise<PromInstantSample[]> {
  const raw = await callProm<RawInstantResult[]>('api/v1/query', { query: promQL });
  return raw.map((r) => ({
    time: r.value[0],
    value: r.value[1],
    labels: r.metric,
  }));
}

/**
 * Run a range query. `start` and `end` are unix seconds; `step` is a
 * Prometheus duration string ('15s', '1m', '5m'). Returns 0+ series with
 * each series carrying its time-value array.
 */
export async function queryRange(
  promQL: string,
  start: number,
  end: number,
  step: string,
): Promise<PromRangeSeries[]> {
  const raw = await callProm<RawRangeResult[]>('api/v1/query_range', {
    query: promQL,
    start: String(start),
    end: String(end),
    step,
  });
  return raw.map((r) => ({
    labels: r.metric,
    values: r.values.map(([t, v]) => ({ time: t, value: v })),
  }));
}
