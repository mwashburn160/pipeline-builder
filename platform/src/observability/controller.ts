// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the Observability endpoints.
 *
 *   GET /api/observability/query?key=&range=
 *   GET /api/observability/logs?key=&range=&limit=&event=&actor=
 *
 * Sysadmin-only. The catalog is the security boundary — frontend cannot
 * request raw PromQL/LogQL; only catalog keys.
 *
 * Error mapping:
 *   - Unknown catalog key                       → 400
 *   - Upstream Prom/Loki 4xx (syntax-error)     → 500 (catalog bug, not user input)
 *   - Upstream unreachable / timeout            → 502
 *   - Valid query returning empty result        → 200 with `{datapoints: []}` / `{entries: []}`
 */

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { requireSystemAdmin, withController } from '../helpers/controller-helper';
import {
  QUERIES,
  rangeSeconds,
  stepForRange,
  substituteVars,
} from './catalog';
import * as prom from './prometheus-client';
import * as loki from './loki-client';

type RangeKey = '1h' | '6h' | '24h';

function parseRange(raw: unknown): RangeKey | null {
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return null;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 500);
}

function getStringParam(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Convert a Prom/Loki error to the right HTTP response per the contract above. */
function sendUpstreamError(res: Response, err: unknown): void {
  const e = err as { kind?: string; status?: number; message?: string };
  if (e.kind === 'upstream-4xx') {
    // 4xx from Prom/Loki means our catalog produced an unparseable query —
    // user-supplied params alone can't reach this state because they're
    // sanitized in substituteVars. So this is our bug, surface 500.
    sendError(res, 500, 'Upstream rejected query (catalog bug)');
    return;
  }
  sendError(res, 502, 'Upstream observability backend unreachable');
}

/**
 * GET /api/observability/query — Prometheus instant or range query by key.
 *
 * Range queries return a `series` array (one per matching label-set), each
 * with its time-value points. Instant queries return a single `samples`
 * array. Both shape decisions are stable contracts the frontend depends on.
 */
export const observabilityQuery = withController('Observability query', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const key = getStringParam(req, 'key');
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];
  if (entry.source !== 'prometheus-instant' && entry.source !== 'prometheus-range') {
    sendError(res, 400, 'Query key is not a Prometheus query');
    return;
  }

  const promQL = substituteVars(entry.query, {}, []);

  try {
    if (entry.source === 'prometheus-instant') {
      const samples = await prom.query(promQL);
      sendSuccess(res, 200, { samples });
      return;
    }
    const range = parseRange(req.query.range) ?? '1h';
    const end = Math.floor(Date.now() / 1000);
    const start = end - rangeSeconds(range);
    const series = await prom.queryRange(promQL, start, end, stepForRange(range));
    sendSuccess(res, 200, { series, range, step: stepForRange(range) });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

/**
 * GET /api/observability/logs — Loki range query (streams or matrix) by key.
 *
 * Streams responses return `{entries: [...]}`; matrix responses return
 * `{series: [...]}`. The route picks based on the catalog `source` and
 * the resolved result type.
 */
export const observabilityLogs = withController('Observability logs', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const key = getStringParam(req, 'key');
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];
  if (entry.source !== 'loki-range') {
    sendError(res, 400, 'Query key is not a Loki query');
    return;
  }

  const range = parseRange(req.query.range) ?? '1h';
  const end = Math.floor(Date.now() / 1000);
  const start = end - rangeSeconds(range);
  const limit = parseLimit(req.query.limit);

  const vars = {
    event: getStringParam(req, 'event'),
    digest: getStringParam(req, 'digest'),
    actor: getStringParam(req, 'actor'),
  };
  const logQL = substituteVars(entry.query, vars, entry.allowedVars);

  try {
    // Heuristic: queries that start with `{` and have no `count_over_time`
    // / `sum` aggregations return streams; everything else returns matrix.
    // Cheaper than a regex against the source query — Loki itself will
    // tell us via `resultType`, but the route shape is decided here.
    const isStreams = /^\s*\{/.test(entry.query) && !/count_over_time|sum\s|topk\(/.test(entry.query);
    if (isStreams) {
      const entries = await loki.queryStreams(logQL, start, end, limit);
      sendSuccess(res, 200, { entries, range });
    } else {
      const step = stepForRange(range);
      const series = await loki.queryMatrix(logQL, start, end, step);
      sendSuccess(res, 200, { series, range, step });
    }
  } catch (err) {
    sendUpstreamError(res, err);
  }
});
