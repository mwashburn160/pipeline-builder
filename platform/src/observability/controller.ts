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

import { parseQueryString, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import * as am from './alertmanager-client';
import {
  QUERIES,
  type RangeKey,
  rangeSeconds,
  stepForRange,
  substituteVars,
} from './catalog';
import * as loki from './loki-client';
import * as prom from './prometheus-client';
import { isSystemAdmin, requireAuth, withController } from '../helpers/controller-helper';

/**
 * Parse the `range` query param.
 *   - missing / undefined  →  '1h' (sensible default for a dashboard load)
 *   - one of '1h'/'6h'/'24h' →  return as-is
 *   - any other value      →  null (caller returns 400; previously this path
 *                              silently defaulted to '1h' and masked bugs)
 */
function parseRange(raw: unknown): RangeKey | null {
  if (raw === undefined) return '1h';
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return null;
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 500);
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

/** Validate that a free-text field (silence comment, createdBy, matcher value)
 *  is bounded and not obviously bogus. Defense-in-depth on top of Alertmanager's
 *  own validation — keeps the matcher value from being used to encode an attack
 *  on Alertmanager's regex engine. */
function isReasonableString(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * GET /api/observability/query — Prometheus instant or range query by key.
 *
 * Range queries return a `series` array (one per matching label-set), each
 * with its time-value points. Instant queries return a single `samples`
 * array. Both shape decisions are stable contracts the frontend depends on.
 */
export const observabilityQuery = withController('Observability query', async (req, res) => {
  // Auth: any authenticated user with a valid token. Org-scoping happens
  // below via $ORG substitution; sysadmin gets a wildcard.
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const key = parseQueryString(req.query.key);
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];

  const queryStr = substituteVars(
    entry.query,
    {
      plugin: parseQueryString(req.query.plugin),
      event: parseQueryString(req.query.event),
      actor: parseQueryString(req.query.actor),
      org: req.user?.organizationId,
      isSuperAdmin: sysadmin,
    },
    entry.allowedVars,
  );

  try {
    if (entry.source === 'prometheus-instant') {
      const samples = await prom.query(queryStr);
      sendSuccess(res, 200, { samples });
      return;
    }
    const range = parseRange(req.query.range);
    if (range === null) {
      sendError(res, 400, "Invalid range — must be one of '1h', '6h', '24h'");
      return;
    }
    const end = Math.floor(Date.now() / 1000);
    const start = end - rangeSeconds(range);
    const step = stepForRange(range);
    // loki-range catalog entries return matrix results in the same
    // {series, range, step} envelope as Prometheus range queries — let
    // the frontend stay endpoint-agnostic and dispatch by catalog source
    // here instead of duplicating the routing into every panel.
    if (entry.source === 'loki-range') {
      const series = await loki.queryMatrix(queryStr, start, end, step);
      sendSuccess(res, 200, { series, range, step });
      return;
    }
    if (entry.source === 'prometheus-range') {
      const series = await prom.queryRange(queryStr, start, end, step);
      sendSuccess(res, 200, { series, range, step });
      return;
    }
    sendError(res, 400, `Query key source '${entry.source}' is not supported here`);
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
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const key = parseQueryString(req.query.key);
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];
  if (entry.source !== 'loki-range') {
    sendError(res, 400, 'Query key is not a Loki query');
    return;
  }

  const range = parseRange(req.query.range);
  if (range === null) {
    sendError(res, 400, "Invalid range — must be one of '1h', '6h', '24h'");
    return;
  }
  const end = Math.floor(Date.now() / 1000);
  const start = end - rangeSeconds(range);
  const limit = parseLimit(req.query.limit);

  const vars = {
    event: parseQueryString(req.query.event),
    actor: parseQueryString(req.query.actor),
    plugin: parseQueryString(req.query.plugin),
    org: req.user?.organizationId,
    isSuperAdmin: sysadmin,
  };
  const logQL = substituteVars(entry.query, vars, entry.allowedVars);

  try {
    // Prefer the explicit `kind` field on the catalog entry — set it on new
    // Loki entries so the route shape is unambiguous. Fall back to a
    // syntactic heuristic for legacy entries that haven't been migrated:
    // queries starting with `{` and lacking aggregation operators return
    // streams; everything else is matrix. Loki itself reports `resultType`
    // in the response, but we need to pick the endpoint *before* calling.
    const isStreams = entry.kind
      ? entry.kind === 'stream'
      : /^\s*\{/.test(entry.query) && !/count_over_time|sum\s|topk\(/.test(entry.query);
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

/**
 * GET /api/observability/catalog — list every catalog query key.
 *
 * Returned shape: `{ entries: [{ key, source, allowedVars, orgScoped }] }` —
 * just enough metadata for the dashboard editor's panel-add picker to render
 * the dropdown + decide whether `vars` inputs are needed. The raw PromQL/LogQL
 * is intentionally omitted; the catalog stays the security boundary even when
 * the picker is exposed to org admins.
 */
export const observabilityCatalog = withController('Observability catalog', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const entries = Object.entries(QUERIES).map(([key, entry]) => ({
    key,
    source: entry.source,
    allowedVars: entry.allowedVars,
    orgScoped: entry.orgScoped ?? false,
  }));
  sendSuccess(res, 200, { entries });
});

/**
 * GET /api/observability/alerts — list currently-firing + suppressed alerts.
 *
 * Org-scoped: org admins see alerts labeled with their org_id (plus
 * platform-wide alerts that have no org_id label, since those still affect
 * them). Sysadmins see all alerts unfiltered.
 */
export const observabilityAlerts = withController('Observability alerts', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);
  const orgId = req.user?.organizationId;

  try {
    const all = await am.listAlerts(sysadmin ? undefined : orgId);
    const visible = sysadmin
      ? all
      : all.filter(a => !a.labels.org_id || a.labels.org_id === orgId);
    sendSuccess(res, 200, { alerts: visible });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

/**
 * GET /api/observability/silences — list active + recent silences.
 *
 * No org filter at this layer — silences are global to Alertmanager. The UI
 * presents silences scoped to the alerts the caller can see (whose matchers
 * include the caller's org_id, or whose matchers are platform-wide).
 */
export const observabilitySilencesList = withController('Observability silences list', async (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const silences = await am.listSilences();
    sendSuccess(res, 200, { silences });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

/**
 * POST /api/observability/silences — create a silence.
 *
 * Body: { matchers: [{ name, value }], durationMs, comment }
 *
 * Authorization model: any authenticated user can silence alerts whose
 * matchers are constrained to their own org_id. Sysadmins can silence
 * anything. The controller enforces this by injecting `org_id=<caller>`
 * into the matcher set for non-sysadmin callers. Sysadmins' matchers
 * pass through unmodified.
 */
export const observabilitySilenceCreate = withController('Observability silence create', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);
  const orgId = req.user?.organizationId;

  const body = req.body as { matchers?: Array<{ name?: string; value?: string }>; durationMs?: number; comment?: string };
  if (!Array.isArray(body.matchers) || body.matchers.length === 0) {
    sendError(res, 400, 'matchers[] is required');
    return;
  }
  if (typeof body.durationMs !== 'number' || body.durationMs <= 0 || body.durationMs > 7 * 24 * 60 * 60 * 1000) {
    sendError(res, 400, 'durationMs is required and must be 1ms..7d');
    return;
  }
  if (!isReasonableString(body.comment, 1024)) {
    sendError(res, 400, 'comment is required (max 1024 chars)');
    return;
  }

  // Validate + sanitize each matcher. Names/values are bounded strings; we
  // reject anything that looks like a regex (the client doesn't get to opt
  // into regex matching — keeps Alertmanager's regex engine off the
  // user-input attack surface).
  const cleanedMatchers: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }> = [];
  for (const m of body.matchers) {
    if (!isReasonableString(m.name, 128) || !isReasonableString(m.value, 256)) {
      sendError(res, 400, 'Each matcher needs a 1..128 char name and 1..256 char value');
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name)) {
      sendError(res, 400, 'Matcher name must match Prometheus label syntax');
      return;
    }
    cleanedMatchers.push({ name: m.name, value: m.value, isRegex: false, isEqual: true });
  }

  // Non-sysadmins are forced to scope to their own org. If they didn't include
  // an org_id matcher, add one. If they did but it points to a different org,
  // refuse — that's a cross-tenant silencing attempt.
  if (!sysadmin) {
    if (!orgId) {
      sendError(res, 400, 'organizationId is required for non-sysadmin silences');
      return;
    }
    const orgMatcher = cleanedMatchers.find(m => m.name === 'org_id');
    if (orgMatcher && orgMatcher.value !== orgId) {
      sendError(res, 403, 'You can only silence alerts in your own organization');
      return;
    }
    if (!orgMatcher) cleanedMatchers.push({ name: 'org_id', value: orgId, isRegex: false, isEqual: true });
  }

  const now = new Date();
  const startsAt = now.toISOString();
  const endsAt = new Date(now.getTime() + body.durationMs).toISOString();
  const createdBy = req.user?.email || req.user?.sub || 'unknown';

  try {
    const { silenceID } = await am.createSilence({
      matchers: cleanedMatchers,
      startsAt,
      endsAt,
      createdBy,
      comment: body.comment,
    });
    sendSuccess(res, 201, { silenceID });
  } catch (err) {
    sendUpstreamError(res, err);
  }
});

/**
 * DELETE /api/observability/silences/:id — expire a silence.
 *
 * Authorization model: any authenticated user can delete silences whose
 * matchers include their own org_id. Sysadmins can delete any silence.
 */
export const observabilitySilenceDelete = withController('Observability silence delete', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);
  const orgId = req.user?.organizationId;

  const id = req.params.id;
  if (!isReasonableString(id, 256)) {
    sendError(res, 400, 'Invalid silence id');
    return;
  }

  if (!sysadmin) {
    try {
      const silences = await am.listSilences();
      const target = silences.find(s => s.id === id);
      if (!target) {
        sendError(res, 404, 'Silence not found');
        return;
      }
      const ownsIt = target.matchers.some(m => m.name === 'org_id' && m.value === orgId);
      if (!ownsIt) {
        sendError(res, 403, 'You can only delete silences in your own organization');
        return;
      }
    } catch (err) {
      sendUpstreamError(res, err);
      return;
    }
  }

  try {
    await am.deleteSilence(id);
    sendSuccess(res, 200, undefined, 'Silence expired');
  } catch (err) {
    sendUpstreamError(res, err);
  }
});
