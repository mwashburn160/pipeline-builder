// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Prometheus HTTP client. Uses Node 24's native `fetch` — no axios
 * dependency. Reads `PROMETHEUS_URL` at call time so tests can stub the
 * env per-test without import-order pain.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';

const logger = createLogger('prometheus-client');

/** Default Prometheus URL when env is unset — matches the in-cluster service name. */
const DEFAULT_URL = 'http://prometheus:9090';

/**
 * Categorized failure. Lets the route layer map 4xx (catalog bug) vs.
 * connectivity / 5xx (502) without inspecting the exception type.
 */
export type PromError =
  | { kind: 'upstream-4xx'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

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

function promUrl(): string {
  return process.env.PROMETHEUS_URL || DEFAULT_URL;
}

async function callProm<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, promUrl().endsWith('/') ? promUrl() : promUrl() + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const e: PromError = { kind: 'unreachable', message: errorMessage(err) };
    logger.warn('Prometheus unreachable', { url: url.toString(), error: e.message });
    throw e;
  }

  if (!res.ok) {
    // Prometheus returns 4xx with a JSON body containing `error`.
    const body = await res.json().catch(() => ({})) as PromResponseEnvelope<unknown>;
    const e: PromError = {
      kind: 'upstream-4xx',
      status: res.status,
      message: body.error || `Prometheus returned ${res.status}`,
    };
    logger.warn('Prometheus rejected query', { status: res.status, message: e.message });
    throw e;
  }

  const env = (await res.json()) as PromResponseEnvelope<T>;
  if (env.status !== 'success' || env.data === undefined) {
    const e: PromError = {
      kind: 'upstream-4xx',
      status: res.status,
      message: env.error || 'Prometheus returned non-success envelope',
    };
    throw e;
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
