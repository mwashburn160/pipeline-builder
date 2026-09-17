// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the Observability endpoints.
 *
 *   GET /api/observability/query?key=&range=   — Prometheus (or audit-store matrix) by key
 *   GET /api/observability/logs?key=&range=&limit=&event=&actor=&requestId=
 *                                              — the MongoDB audit trail (audit-store) by key
 *
 * Authenticated + org-scoped (`requireAuth`, then results are scoped to the
 * caller's org — `$ORG` substitution for PromQL, the audit trail's org fields
 * for audit-store; a sysadmin sees every org). The catalog is the security
 * boundary — frontend cannot request raw PromQL; only catalog keys.
 *
 * Error mapping:
 *   - Unknown catalog key                       → 400
 *   - Upstream Prometheus 4xx (syntax-error)    → 500 (catalog bug, not user input)
 *   - Upstream unreachable / timeout (READS)    → 200 with an empty body + `degraded: true`
 *       (a LEAN deploy omits prometheus/alertmanager/thanos, so a dashboard reads a
 *        clean empty state instead of erroring; writes below still surface 502)
 *   - Valid query returning empty result        → 200 with `{samples: []}` / `{series: []}` / `{entries: []}`
 */

import { parseQueryString, sendError, sendSuccess, isSystemAdmin } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import * as am from './alertmanager-client.js';
import { queryAuditStore } from './audit-store-client.js';
import {
  type AuditStoreQueryEntry,
  canQueryCatalogKey,
  type CatalogCaller,
  QUERIES,
  type RangeKey,
  rangeSeconds,
  stepForRange,
  substituteOrg,
} from './catalog.js';
import * as prom from './prometheus-client.js';
import { audit } from '../helpers/audit.js';
import { getAdminContext, requireAuth, withController } from '../helpers/controller-helper.js';
import { isReasonableString } from '../utils/string-guards.js';

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

/**
 * Enforce the tenancy boundary for a catalog key.
 *
 * An `orgScoped` entry is confined server-side to the caller's own org
 * (`$ORG` substitution, or the audit trail's org fields; sysadmins see every
 * org) — safe for an org member, or only an org admin when it's `adminOnly`
 * (the audit trail). An entry that is NOT `orgScoped` has NO org confinement:
 * it queries a fleet-wide metric (platform totals, queue/registry health).
 * Exposing those to a normal org member leaks every tenant's data, so they are
 * restricted to platform system admins (see `canQueryCatalogKey`). Writes a 403
 * and returns false when the caller lacks the required authority.
 */
function requireCatalogScope(key: string, caller: CatalogCaller, res: Response): boolean {
  if (!canQueryCatalogKey(key, caller)) {
    sendError(res, 403, QUERIES[key].orgScoped
      ? 'Forbidden: admin access required for this observability query'
      : 'Forbidden: system admin access required for this observability query');
    return false;
  }
  return true;
}

/**
 * Serve an `audit-store` entry from the MongoDB audit trail, org-scoped to the
 * caller (sysadmins see every org): `{series, range, step}` for matrix entries
 * (the same envelope as a Prometheus range query), `{entries, range}` for streams.
 * No degraded fallback: Mongo is a hard dependency of platform, so a failure
 * is a real 500 (via withController), not a LEAN-deploy empty state.
 */
async function sendAuditStoreResult(
  req: Request,
  res: Response,
  entry: AuditStoreQueryEntry,
  sysadmin: boolean,
): Promise<void> {
  const range = parseRange(req.query.range);
  if (range === null) {
    sendError(res, 400, "Invalid range — must be one of '1h', '6h', '24h'");
    return;
  }
  const pick = (name: 'event' | 'actor' | 'requestId') =>
    (entry.allowedVars?.includes(name) ? parseQueryString(req.query[name]) : undefined);
  const result = await queryAuditStore(
    entry.query,
    { isSuperAdmin: sysadmin, orgId: req.user?.organizationId },
    {
      range,
      end: Math.floor(Date.now() / 1000),
      limit: parseLimit(req.query.limit),
      vars: { event: pick('event'), actor: pick('actor'), requestId: pick('requestId') },
    },
  );
  if (result.kind === 'stream') {
    sendSuccess(res, 200, { entries: result.entries, range });
  } else {
    sendSuccess(res, 200, { series: result.series, range, step: result.step });
  }
}

/** Convert a Prometheus/Alertmanager error to the right HTTP response per the contract above. */
function sendUpstreamError(res: Response, err: unknown): void {
  const e = err as { kind?: string; status?: number; message?: string };
  if (e.kind === 'upstream-4xx') {
    // 4xx from Prometheus means our catalog produced an unparseable query —
    // no user-supplied value reaches PromQL (only the server-driven `$ORG`),
    // so this is our bug, surface 500.
    sendError(res, 500, 'Upstream rejected query (catalog bug)');
    return;
  }
  sendError(res, 502, 'Upstream observability backend unreachable');
}

/**
 * Read-endpoint degradation. An `unreachable` backend — the normal case on a LEAN
 * deploy, which omits prometheus/alertmanager/thanos — yields the given empty
 * body with `degraded: true` and a 200, so dashboards render a clean empty state
 * instead of a 502. A reachable-but-erroring backend (`upstream-4xx`) still surfaces
 * as an error via sendUpstreamError. Returns true when it degraded.
 */
function sendReadResultOrDegrade(res: Response, err: unknown, emptyBody: Record<string, unknown>): void {
  const e = err as { kind?: string };
  if (e.kind === 'unreachable') {
    sendSuccess(res, 200, { ...emptyBody, degraded: true });
    return;
  }
  sendUpstreamError(res, err);
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
  const caller = getAdminContext(req);
  const sysadmin = caller.isSuperAdmin;

  const key = parseQueryString(req.query.key);
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];
  if (!requireCatalogScope(key, caller, res)) return;
  if (entry.source === 'audit-store') {
    await sendAuditStoreResult(req, res, entry, sysadmin);
    return;
  }

  const promQL = substituteOrg(entry.query, { org: req.user?.organizationId, isSuperAdmin: sysadmin });

  try {
    if (entry.source === 'prometheus-instant') {
      const samples = await prom.query(promQL);
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
    const series = await prom.queryRange(promQL, start, end, step);
    sendSuccess(res, 200, { series, range, step });
  } catch (err) {
    // Degrade to the empty shape the frontend expects for this query kind.
    if (entry.source === 'prometheus-instant') {
      sendReadResultOrDegrade(res, err, { samples: [] });
    } else {
      const range = parseRange(req.query.range) ?? '1h';
      sendReadResultOrDegrade(res, err, { series: [], range, step: stepForRange(range) });
    }
  }
});

/**
 * GET /api/observability/logs — an `audit-store` entry (the MongoDB audit
 * trail) by key: `{entries}` for stream entries, `{series}` for matrix ones.
 * Admin-only and org-scoped per the catalog entry (see `requireCatalogScope`).
 */
export const observabilityLogs = withController('Observability logs', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const caller = getAdminContext(req);

  const key = parseQueryString(req.query.key);
  if (!key || !(key in QUERIES)) {
    sendError(res, 400, 'Unknown observability query key');
    return;
  }
  const entry = QUERIES[key];
  if (entry.source !== 'audit-store') {
    sendError(res, 400, 'Query key is not an audit-trail query');
    return;
  }
  if (!requireCatalogScope(key, caller, res)) return;
  await sendAuditStoreResult(req, res, entry, caller.isSuperAdmin);
});

/**
 * GET /api/observability/catalog — list every catalog query key.
 *
 * Returned shape: `{ entries: [{ key, source, allowedVars, orgScoped }] }` —
 * just enough metadata for the dashboard editor's panel-add picker to render
 * the dropdown + decide whether `vars` inputs are needed. The raw PromQL
 * is intentionally omitted; the catalog stays the security boundary even when
 * the picker is exposed to org admins. A non-sysadmin only gets the keys they
 * can actually run (orgScoped) — offering a fleet-wide key would just build a
 * panel that renders a 403.
 */
export const observabilityCatalog = withController('Observability catalog', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const caller = getAdminContext(req);
  const entries = Object.entries(QUERIES).filter(([key]) => canQueryCatalogKey(key, caller)).map(([key, entry]) => ({
    key,
    source: entry.source,
    allowedVars: (entry.source === 'audit-store' && entry.allowedVars) || [],
    orgScoped: entry.orgScoped ?? false,
  }));
  sendSuccess(res, 200, { entries });
});

/**
 * GET /api/observability/alerts — list currently-firing + suppressed alerts.
 *
 * Org-scoped: org admins see only alerts labeled with their org_id (the
 * Alertmanager client applies the `org_id` filter server-side). Sysadmins
 * see all alerts unfiltered.
 */
export const observabilityAlerts = withController('Observability alerts', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);
  const orgId = req.user?.organizationId;

  try {
    const all = await am.listAlerts(sysadmin ? undefined : orgId);
    // `listAlerts(orgId)` already constrains to the caller's org_id server-side;
    // the residual client-side equality check just guards the orgId-undefined
    // edge (a non-sysadmin without an org sees only no-org_id alerts).
    const visible = sysadmin
      ? all
      : all.filter(a => a.labels.org_id === orgId);
    sendSuccess(res, 200, { alerts: visible });
  } catch (err) {
    sendReadResultOrDegrade(res, err, { alerts: [] });
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
  const sysadmin = isSystemAdmin(req);
  const orgId = req.user?.organizationId;
  try {
    const silences = await am.listSilences();
    // Tenancy: non-sysadmins only see silences scoped to their own org (an
    // `org_id` matcher equal to their org) — the same ownership test the
    // create/delete paths enforce. Sysadmins see every tenant's silences.
    const visible = sysadmin
      ? silences
      : silences.filter(s => s.matchers.some(m => m.name === 'org_id' && m.value === orgId));
    sendSuccess(res, 200, { silences: visible });
  } catch (err) {
    sendReadResultOrDegrade(res, err, { silences: [] });
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
    // Audit — creating a silence SUPPRESSES the org's alerts (detection-evasion
    // vector), so it has high forensic value. Safe metadata only (no matcher
    // values that might carry sensitive labels beyond count).
    audit(req, 'observability.silence.create', {
      targetType: 'silence',
      targetId: silenceID,
      details: { matcherCount: cleanedMatchers.length, endsAt, comment: body.comment },
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
    audit(req, 'observability.silence.delete', { targetType: 'silence', targetId: id });
    sendSuccess(res, 200, undefined, 'Silence expired');
  } catch (err) {
    sendUpstreamError(res, err);
  }
});
