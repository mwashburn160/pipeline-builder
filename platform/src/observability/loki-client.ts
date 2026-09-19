// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Loki HTTP client, mirroring `prometheus-client.ts` (native `fetch`, env
 * read at call time, the same categorized error union so the controller's
 * degraded-on-unreachable path works unchanged on a LEAN deploy).
 *
 * Two things this client owns that Prometheus' does not:
 *
 *  - **The tenant header.** Every call takes a resolved `X-Scope-OrgID` from
 *    `log-query.ts`. Loki enforces it, which is why tenancy here is physical
 *    rather than a filter we have to remember to append.
 *  - **Masking (L4).** Every line is passed through `maskLine` on the way out,
 *    covering history written before ingest-time masking shipped. Read-time
 *    masking is NOT the guarantee (a searcher can still confirm a guess from a
 *    hit) — see `packages/api-core/src/utils/sensitive-patterns.ts`.
 */

import { createLogger, errorMessage, maskLine } from '@pipeline-builder/api-core';

const logger = createLogger('loki-client');

/** Default Loki URL when env is unset — matches the in-cluster service name. */
const DEFAULT_URL = 'http://loki:3100';

/** Same shape as PromError so the controller can treat both backends alike. */
export type LokiError =
  | { kind: 'upstream-4xx'; status: number; message: string }
  | { kind: 'unreachable'; message: string };

/** One log line as the API returns it. */
export interface LokiEntry {
  /** Unix MILLIseconds (Loki speaks nanoseconds; converted here once). */
  time: number;
  /** The log line, already masked. */
  line: string;
  /** Stream labels plus structured metadata (e.g. `orgId`). */
  labels: Record<string, string>;
}

/** One aggregated series — the Prometheus range shape, so charts render either source. */
export interface LokiSeries {
  labels: Record<string, string>;
  values: Array<{ time: number; value: string }>;
}

interface RawStream {
  stream: Record<string, string>;
  /** `[ nanosecondTimestampString, line, structuredMetadata? ]` */
  values: Array<[string, string, Record<string, string>?]>;
}

interface RawMatrix {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

interface LokiEnvelope<T> {
  status: string;
  data?: { resultType: string; result: T };
  error?: string;
  message?: string;
}

function lokiUrl(): string {
  const base = process.env.LOKI_URL || DEFAULT_URL;
  return base.endsWith('/') ? base : `${base}/`;
}

/** Loki's query timeout budget. Kept under the export's wall-clock cap. */
const QUERY_TIMEOUT_MS = 30_000;

async function callLoki<T>(
  path: string,
  params: Record<string, string>,
  tenants: string,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(path, lokiUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'X-Scope-OrgID': tenants },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e: LokiError = { kind: 'unreachable', message: errorMessage(err) };
    // Never log the tenant list at info level — it is a list of customer ids.
    logger.warn('Loki unreachable', { path, error: e.message });
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e: LokiError = {
      kind: 'upstream-4xx',
      status: res.status,
      message: text.slice(0, 300) || `Loki returned ${res.status}`,
    };
    logger.warn('Loki rejected query', { status: res.status, message: e.message });
    throw e;
  }

  const env = (await res.json()) as LokiEnvelope<T>;
  if (env.status !== 'success' || env.data === undefined) {
    throw {
      kind: 'upstream-4xx',
      status: res.status,
      message: env.error || env.message || 'Loki returned a non-success envelope',
    } satisfies LokiError;
  }
  return env.data.result;
}

/** Loki timestamps are nanosecond strings; JS wants milliseconds. */
const nsToMs = (ns: string): number => Math.floor(Number(ns) / 1e6);

function toEntries(streams: RawStream[]): LokiEntry[] {
  const out: LokiEntry[] = [];
  for (const s of streams) {
    for (const [ts, line, structured] of s.values) {
      out.push({
        time: nsToMs(ts),
        line: maskLine(line),
        labels: structured ? { ...s.stream, ...structured } : s.stream,
      });
    }
  }
  return out;
}

export interface QueryLogsOptions {
  /** Unix MILLIseconds. */
  startMs: number;
  endMs: number;
  limit: number;
  /** Loki returns newest-first by default; 'forward' for chronological reads. */
  direction?: 'backward' | 'forward';
}

/** Run a log query. Entries come back sorted newest-first (or oldest-first when `forward`). */
export async function queryLogs(
  logQL: string,
  tenants: string,
  opts: QueryLogsOptions,
): Promise<LokiEntry[]> {
  const direction = opts.direction ?? 'backward';
  const raw = await callLoki<RawStream[]>('loki/api/v1/query_range', {
    query: logQL,
    start: String(opts.startMs * 1e6),
    end: String(opts.endMs * 1e6),
    limit: String(opts.limit),
    direction,
  }, tenants);
  const entries = toEntries(raw);
  // Loki orders WITHIN a stream; a multi-stream result needs a global sort.
  entries.sort((a, b) => (direction === 'forward' ? a.time - b.time : b.time - a.time));
  return entries;
}

/** Run a metric query (the volume histogram). Same series shape as Prometheus. */
export async function queryLogVolume(
  logQL: string,
  tenants: string,
  startMs: number,
  endMs: number,
  step: string,
): Promise<LokiSeries[]> {
  const raw = await callLoki<RawMatrix[]>('loki/api/v1/query_range', {
    query: logQL,
    start: String(Math.floor(startMs / 1000)),
    end: String(Math.floor(endMs / 1000)),
    step,
  }, tenants);
  return raw.map((r) => ({
    labels: r.metric,
    values: r.values.map(([t, v]) => ({ time: t, value: v })),
  }));
}

export interface IterateOptions {
  startMs: number;
  endMs: number;
  /** Entries per underlying query — keep at or below `max_entries_limit_per_query`. */
  pageSize: number;
  /** Stop after this many entries. */
  maxEntries: number;
  /** Stop after this much wall-clock. */
  deadlineMs: number;
}

/**
 * Walk a window oldest-first, yielding pages. Used by the export path, which
 * cannot buffer: a busy stream over the retention window is far larger than one
 * `query_range` (capped at `max_entries_limit_per_query`) can return.
 *
 * Paging is by timestamp, which needs care: entries can share a millisecond (and
 * Loki a nanosecond), so advancing to `last + 1` would silently DROP the
 * remainder of that instant, while re-querying from `last` would repeat it.
 * We re-query from the last timestamp and drop the ids already emitted at it.
 */
export async function* iterateLogs(
  logQL: string,
  tenants: string,
  opts: IterateOptions,
): AsyncGenerator<LokiEntry[], void, undefined> {
  const startedAt = Date.now();
  let cursorMs = opts.startMs;
  let emitted = 0;
  // Lines already yielded AT cursorMs — the dedup set for the boundary instant.
  let seenAtCursor = new Set<string>();

  while (emitted < opts.maxEntries) {
    if (Date.now() - startedAt > opts.deadlineMs) return;

    const page = await queryLogs(logQL, tenants, {
      startMs: cursorMs,
      endMs: opts.endMs,
      limit: Math.min(opts.pageSize, opts.maxEntries - emitted + seenAtCursor.size),
      direction: 'forward',
    });
    if (page.length === 0) return;

    const fresh = page.filter((e) => !(e.time === cursorMs && seenAtCursor.has(e.line)));
    if (fresh.length === 0) return; // whole page was the boundary instant we already sent

    const slice = fresh.slice(0, opts.maxEntries - emitted);
    emitted += slice.length;
    yield slice;

    const lastTime = slice[slice.length - 1].time;
    if (lastTime === cursorMs) {
      for (const e of slice) seenAtCursor.add(e.line);
    } else {
      cursorMs = lastTime;
      seenAtCursor = new Set(slice.filter((e) => e.time === lastTime).map((e) => e.line));
    }
    // A short page means the window is exhausted.
    if (page.length < opts.pageSize) return;
  }
}
