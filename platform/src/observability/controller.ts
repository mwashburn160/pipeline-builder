// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the Observability endpoints.
 *
 *   POST /api/observability/query/batch — a dashboard's catalog queries, one request per refresh:
 *     Prometheus instant/range by key, or (`audit: true`) the MongoDB audit trail
 *     (audit-store) by key with its `limit`/`event`/`actor`/`requestId` filters
 *
 * Application LOGS (Loki) live in `log-controller.ts`, on /observability/logs.
 *
 * Authenticated + org-scoped (`ensureAuthenticated`, then results are scoped to the
 * caller's org — `$ORG` substitution for PromQL, the audit trail's org fields
 * for audit-store; a sysadmin sees every org). The catalog is the security
 * boundary — frontend cannot request raw PromQL; only catalog keys.
 *
 * Error mapping:
 *   - Unknown catalog key                       → 400
 *   - Upstream Prometheus 4xx (syntax-error)    → 500 (catalog bug, not user input)
 *   - Upstream unreachable / timeout / 5xx (READS) → 200 with an empty body + `degraded: true`
 *       (a LEAN deploy omits prometheus/alertmanager/thanos, so a dashboard reads a
 *        clean empty state instead of erroring; writes below still surface 502)
 *   - Valid query returning empty result        → 200 with `{samples: []}` / `{series: []}` / `{entries: []}`
 */

import { parsePage, parseQueryString, sendError, sendSuccess, isSystemAdmin } from '@pipeline-builder/api-core';
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
import { sendUpstreamFailure, upstreamFailureResult } from './upstream.js';
import { audit } from '../helpers/audit.js';
import { ensureAuthenticated, forbid, getAdminContext, withController } from '../helpers/controller-helper.js';
import { isReasonableString } from '../utils/string-guards.js';

/**
 * Parse the `range` query param.
 *   - missing / undefined  →  '1h' (sensible default for a dashboard load)
 *   - one of '1h'/'6h'/'24h' →  return as-is
 *   - any other value      →  null (caller returns 400 rather than silently
 *                              defaulting and masking a client bug)
 */
function parseRange(raw: unknown): RangeKey | null {
  if (raw === undefined) return '1h';
  if (raw === '1h' || raw === '6h' || raw === '24h') return raw;
  return null;
}

/** Audit-trail panel page: 50 by default, at most 500. */
const AUDIT_PAGE = { def: 50, max: 500 };

/** Most queries one batch may carry — a dashboard's panel count, with headroom. */
const MAX_BATCH_QUERIES = 50;

const INVALID_RANGE = "Invalid range — must be one of '1h', '6h', '24h'";

const UPSTREAM_MESSAGES = {
  rejected: 'Upstream rejected query (catalog bug)',
  unreachable: 'Upstream observability backend unreachable',
};

/**
 * One catalog query — one entry of a batch. Filter values are raw — only the
 * ones the catalog entry allows are used.
 */
interface CatalogQueryRequest {
  key: unknown;
  range: unknown;
  /** Audit-trail semantics: only an `audit-store` key is accepted. */
  auditOnly?: boolean;
  limit?: unknown;
  event?: unknown;
  actor?: unknown;
  requestId?: unknown;
}

/** The result of one catalog query, before it becomes a response (or a batch slot). */
type CatalogQueryOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; message: string };

const fail = (status: number, message: string): CatalogQueryOutcome => ({ ok: false, status, message });

/** The caller facts a query runs under: catalog authority + the org `$ORG` resolves to. */
interface CatalogQueryCaller extends CatalogCaller {
  orgId: string | undefined;
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
 * restricted to platform system admins (see `canQueryCatalogKey`). Returns the
 * 403 outcome when the caller lacks the required authority.
 */
function catalogScopeFailure(key: string, caller: CatalogCaller): CatalogQueryOutcome | null {
  if (canQueryCatalogKey(key, caller)) return null;
  return fail(403, QUERIES[key].orgScoped
    ? 'Forbidden: admin access required for this observability query'
    : 'Forbidden: system admin access required for this observability query');
}

/**
 * Run an `audit-store` entry against the MongoDB audit trail, org-scoped to the
 * caller (sysadmins see every org): `{series, range, step}` for matrix entries
 * (the same envelope as a Prometheus range query), `{entries, range}` for streams.
 * No degraded fallback: Mongo is a hard dependency of platform, so a failure
 * THROWS (the batch turns it into that slot's 500).
 */
async function runAuditStoreQuery(
  q: CatalogQueryRequest,
  entry: AuditStoreQueryEntry,
  caller: CatalogQueryCaller,
): Promise<CatalogQueryOutcome> {
  const range = parseRange(q.range);
  if (range === null) return fail(400, INVALID_RANGE);
  const pick = (name: 'event' | 'actor' | 'requestId') =>
    (entry.allowedVars?.includes(name) ? parseQueryString(q[name]) : undefined);
  const result = await queryAuditStore(
    entry.query,
    { isSuperAdmin: caller.isSuperAdmin, orgId: caller.orgId },
    {
      range,
      end: Math.floor(Date.now() / 1000),
      limit: parsePage({ limit: q.limit }, AUDIT_PAGE).limit,
      vars: { event: pick('event'), actor: pick('actor'), requestId: pick('requestId') },
    },
  );
  return result.kind === 'stream'
    ? { ok: true, data: { entries: result.entries, range } }
    : { ok: true, data: { series: result.series, range, step: result.step } };
}

/**
 * Read-path failure. An unreachable backend — the normal case on a LEAN deploy,
 * which omits prometheus/alertmanager/thanos — yields the given empty body with
 * `degraded: true`, so dashboards render a clean empty state instead of a 502.
 * A rejection still surfaces as a 500.
 */
function degradedOutcome(err: unknown, emptyBody: Record<string, unknown>): CatalogQueryOutcome {
  const r = upstreamFailureResult(err, UPSTREAM_MESSAGES, emptyBody);
  return r.ok ? { ok: true, data: r.body } : fail(r.status, r.message);
}

/**
 * Run one catalog query — one entry of `POST /query/batch`.
 *
 * Range queries return a `series` array (one per matching label-set), each
 * with its time-value points. Instant queries return a single `samples`
 * array. Both shape decisions are stable contracts the frontend depends on.
 */
async function runCatalogQuery(q: CatalogQueryRequest, caller: CatalogQueryCaller): Promise<CatalogQueryOutcome> {
  const key = parseQueryString(q.key);
  if (!key || !Object.hasOwn(QUERIES, key)) return fail(400, 'Unknown observability query key');
  const entry = QUERIES[key];
  if (q.auditOnly && entry.source !== 'audit-store') return fail(400, 'Query key is not an audit-trail query');
  const denied = catalogScopeFailure(key, caller);
  if (denied) return denied;
  if (entry.source === 'audit-store') return runAuditStoreQuery(q, entry, caller);

  const promQL = substituteOrg(entry.query, { org: caller.orgId, isSuperAdmin: caller.isSuperAdmin });

  if (entry.source === 'prometheus-instant') {
    try {
      return { ok: true, data: { samples: await prom.query(promQL) } };
    } catch (err) {
      return degradedOutcome(err, { samples: [] });
    }
  }
  const range = parseRange(q.range);
  if (range === null) return fail(400, INVALID_RANGE);
  const step = stepForRange(range);
  try {
    const end = Math.floor(Date.now() / 1000);
    const series = await prom.queryRange(promQL, end - rangeSeconds(range), end, step);
    return { ok: true, data: { series, range, step } };
  } catch (err) {
    // Degrade to the empty shape the frontend expects for this query kind.
    return degradedOutcome(err, { series: [], range, step });
  }
}

/** The caller a query runs as — authority from the verified token, never the request body. */
function queryCaller(req: Request): CatalogQueryCaller {
  const { isSuperAdmin, isOrgAdmin } = getAdminContext(req);
  return { isSuperAdmin, isOrgAdmin, orgId: req.user?.organizationId };
}

/** Write-path failure: rejection → 500, unreachable → 502 (no degraded fallback for writes). */
function sendUpstreamError(res: Response, err: unknown): void {
  sendUpstreamFailure(res, err, UPSTREAM_MESSAGES);
}

/** Read-path failure for the non-catalog reads (alerts, silences) — see {@link degradedOutcome}. */
function sendReadResultOrDegrade(res: Response, err: unknown, emptyBody: Record<string, unknown>): void {
  sendUpstreamFailure(res, err, UPSTREAM_MESSAGES, emptyBody);
}

/**
 * POST /api/observability/query/batch — every panel of a dashboard in ONE call.
 *
 * Body: `{ range?, queries: [{ id, key, audit?, limit?, event?, actor?, requestId? }] }`
 * (at most {@link MAX_BATCH_QUERIES}). Each entry is a catalog key — the
 * frontend never sends raw PromQL — run under the per-key tenancy gate
 * ({@link catalogScopeFailure}; `audit: true` restricts it to audit-trail keys),
 * and lands in `results[id]` as `{ ok: true, data }` or `{ ok: false, status,
 * message }` — one panel's 403 or failure never sinks its siblings.
 *
 * Why a batch: the console refreshes a dashboard on a timer, and every
 * request spends one `apiCalls`. Ten panels each polling their own GET cost
 * ten calls per tick (the per-key GET routes this replaced); a batch costs ONE. The batch is
 * metered like any other request (one 2xx = one call) — there is deliberately
 * no client-asserted "background, don't meter" flag, which anyone could forge.
 */
export const observabilityQueryBatch = withController('Observability batch query', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const body = (req.body ?? {}) as { range?: unknown; queries?: unknown };
  const queries = body.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    sendError(res, 400, 'queries must be a non-empty array');
    return;
  }
  if (queries.length > MAX_BATCH_QUERIES) {
    sendError(res, 400, `At most ${MAX_BATCH_QUERIES} queries per batch`);
    return;
  }
  const ids = new Set<string>();
  for (const q of queries as unknown[]) {
    const id = (q as { id?: unknown } | null)?.id;
    if (!q || typeof q !== 'object' || !isReasonableString(id, 128) || ids.has(id)) {
      sendError(res, 400, 'Each query needs a unique string id');
      return;
    }
    ids.add(id);
  }

  const caller = queryCaller(req);
  const entries = await Promise.all((queries as Array<Record<string, unknown>>).map(async (q) => {
    let outcome: CatalogQueryOutcome;
    try {
      outcome = await runCatalogQuery({
        key: q.key,
        range: body.range,
        auditOnly: q.audit === true,
        limit: q.limit,
        event: q.event,
        actor: q.actor,
        requestId: q.requestId,
      }, caller);
    } catch {
      // An audit-trail read that throws (Mongo down) fails only its own slot.
      outcome = fail(500, 'Observability query failed');
    }
    return [q.id as string, outcome] as const;
  }));
  sendSuccess(res, 200, { results: Object.fromEntries(entries) });
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
  if (!ensureAuthenticated(req, res)) return;
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
  if (!ensureAuthenticated(req, res)) return;
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
  if (!ensureAuthenticated(req, res)) return;
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
  if (!ensureAuthenticated(req, res)) return;
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
      forbid(req, res, 'org-scope', 'You can only silence alerts in your own organization');
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
  if (!ensureAuthenticated(req, res)) return;
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
        forbid(req, res, 'org-scope', 'You can only delete silences in your own organization');
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
