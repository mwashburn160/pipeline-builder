// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the Logs surface (Loki-backed application logs).
 *
 *   GET  /observability/logs          — search (entries)
 *   GET  /observability/logs/volume   — per-level histogram (matrix)
 *   GET  /observability/logs/context  — N lines either side of one entry
 *   GET  /observability/logs/raw      — one stream as text/plain
 *   POST /observability/logs/export/ticket + GET /observability/logs/export
 *
 * Distinct from `controller.ts`'s `observabilityAuditQuery`, which serves the
 * MongoDB AUDIT trail. Both were once called "logs"; only this one reads logs.
 *
 * Tenancy is the Loki tenant header, resolved from the VERIFIED token by
 * `log-query.ts` — never from `x-org-id`, which nginx injects on every proxied
 * request. Masking is applied by the client on every line.
 */

import {
  isSystemAdmin,
  parseQueryString,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import {
  buildLogQL,
  buildLogVolumeQL,
  INFRA_TENANT,
  LogQueryError,
  MAX_TENANTS_PER_QUERY,
  parseLogQuery,
  resolveTenants,
} from './log-query.js';
import * as loki from './loki-client.js';
import { audit } from '../helpers/audit.js';
import { requireAuth, withController } from '../helpers/controller-helper.js';

/** Loki keeps 7 days (`retention_period: 168h`); a wider ask is clamped, not rejected. */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

/** Export budget — see docs/plans/frontend-logs.md D6. Bytes and time, not entries. */
const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
const EXPORT_MAX_ENTRIES = 1_000_000;
const EXPORT_DEADLINE_MS = 60_000;
const EXPORT_PAGE_SIZE = 5000;

export interface ResolvedWindow {
  startMs: number;
  endMs: number;
  /** Set when the requested window was wider than retention. */
  clamped: boolean;
}

const PRESETS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/**
 * Resolve the query window from either a preset (`range=6h`) or an absolute pair
 * (`from`/`to`, unix ms). A window wider than retention is CLAMPED rather than
 * refused: someone asking for 30 days should be shown the 7 we have, with a
 * banner, not an error.
 */
export function resolveWindow(query: Request['query']): ResolvedWindow | { error: string } {
  const fromRaw = parseQueryString(query.from);
  const toRaw = parseQueryString(query.to);

  if (fromRaw || toRaw) {
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return { error: 'from/to must be unix millisecond timestamps' };
    }
    if (from >= to) return { error: 'from must be earlier than to' };
    // Allow a little clock skew but not an open-ended future window.
    if (to > Date.now() + 60_000) return { error: 'to cannot be in the future' };
    const clamped = to - from > MAX_WINDOW_MS;
    return { startMs: clamped ? to - MAX_WINDOW_MS : from, endMs: to, clamped };
  }

  const range = parseQueryString(query.range) ?? '1h';
  const span = PRESETS[range];
  if (span === undefined) {
    return { error: `Invalid range — must be one of ${Object.keys(PRESETS).join(', ')}, or from/to` };
  }
  const endMs = Date.now();
  return { startMs: endMs - span, endMs, clamped: false };
}

function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Which tenants this request reads.
 *
 * A member always gets their own org. A system admin may pass `orgs` — a
 * comma-separated list, or `all` to enumerate (Loki has no wildcard, so a
 * fleet-wide view is literally an enumeration, capped). Default for a sysadmin
 * is `_infra` alone: an implicit firehose is a surprising default for a shared
 * backend.
 */
async function tenantsForRequest(req: Request, sysadmin: boolean): Promise<string> {
  if (!sysadmin) return resolveTenants({ isSuperAdmin: false, orgId: req.user?.organizationId });

  const raw = parseQueryString(req.query.orgs);
  if (!raw) return resolveTenants({ isSuperAdmin: true }, [INFRA_TENANT]);

  if (raw === 'all') {
    // Imported lazily: the Organization model pulls platform's config (and its
    // production secret guards) in at module load, and only this one branch
    // needs it. Keeping it out of the module graph means merely mounting the
    // log routes doesn't drag the whole config in.
    const { default: Organization } = await import('../models/organization.js');
    const orgs = await Organization.find({}, { _id: 1 })
      .limit(MAX_TENANTS_PER_QUERY)
      .lean();
    return resolveTenants({ isSuperAdmin: true }, [INFRA_TENANT, ...orgs.map((o) => String(o._id))]);
  }
  return resolveTenants({ isSuperAdmin: true }, raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Record a sysadmin reading a tenant other than `_infra` — cross-org data access. */
function auditCrossOrgRead(req: Request, tenants: string, context: string): void {
  const others = tenants.split('|').filter((t) => t !== INFRA_TENANT);
  if (others.length === 0) return;
  audit(req, 'observability.logs.cross-org-read', {
    targetType: 'organization',
    targetId: others.length === 1 ? others[0] : undefined,
    details: { tenantCount: others.length, context },
  });
}

/** Map a LogQueryError to a 400 and anything else to the shared degraded path. */
function sendQueryFailure(res: Response, err: unknown, emptyBody: Record<string, unknown>): void {
  if (err instanceof LogQueryError) {
    sendError(res, 400, err.message);
    return;
  }
  const e = err as { kind?: string };
  if (e.kind === 'unreachable') {
    // A LEAN deploy omits Loki; render an empty state, not a 502.
    sendSuccess(res, 200, { ...emptyBody, degraded: true });
    return;
  }
  if (e.kind === 'upstream-4xx') {
    // No user text reaches LogQL unquoted, so a 4xx is our compiler's bug.
    sendError(res, 500, 'Log backend rejected the compiled query');
    return;
  }
  sendError(res, 502, 'Log backend unreachable');
}

/** GET /observability/logs — search. */
export const logSearch = withController('Log search', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const window = resolveWindow(req.query);
  if ('error' in window) { sendError(res, 400, window.error); return; }

  try {
    const filter = parseLogQuery(parseQueryString(req.query.q));
    const tenants = await tenantsForRequest(req, sysadmin);
    if (sysadmin) auditCrossOrgRead(req, tenants, 'search');
    const entries = await loki.queryLogs(buildLogQL(filter), tenants, {
      startMs: window.startMs,
      endMs: window.endMs,
      limit: parseLimit(req.query.limit),
    });
    sendSuccess(res, 200, {
      entries,
      window: { from: window.startMs, to: window.endMs, clamped: window.clamped },
    });
  } catch (err) {
    sendQueryFailure(res, err, { entries: [], window: { from: window.startMs, to: window.endMs, clamped: window.clamped } });
  }
});

/** GET /observability/logs/volume — per-level counts for the histogram. */
export const logVolume = withController('Log volume', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const window = resolveWindow(req.query);
  if ('error' in window) { sendError(res, 400, window.error); return; }

  // ~60 buckets across the window, rounded to whole seconds (min 15s) so the
  // bars stay legible at every range without over-fetching.
  const stepSeconds = Math.max(15, Math.floor((window.endMs - window.startMs) / 1000 / 60));
  const step = `${stepSeconds}s`;

  try {
    const filter = parseLogQuery(parseQueryString(req.query.q));
    const tenants = await tenantsForRequest(req, sysadmin);
    const series = await loki.queryLogVolume(
      buildLogVolumeQL(filter, step), tenants, window.startMs, window.endMs, step,
    );
    sendSuccess(res, 200, { series, step, window: { from: window.startMs, to: window.endMs, clamped: window.clamped } });
  } catch (err) {
    sendQueryFailure(res, err, { series: [], step, window: { from: window.startMs, to: window.endMs, clamped: window.clamped } });
  }
});

/** GET /observability/logs/context — lines either side of one entry. */
export const logContext = withController('Log context', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const atMs = Number(parseQueryString(req.query.at));
  if (!Number.isFinite(atMs)) { sendError(res, 400, 'at must be a unix millisecond timestamp'); return; }
  const span = Math.min(parseLimit(req.query.spanMs, 60_000), 600_000);
  const limit = parseLimit(req.query.limit, 50);

  try {
    const filter = parseLogQuery(parseQueryString(req.query.q));
    const tenants = await tenantsForRequest(req, sysadmin);
    if (sysadmin) auditCrossOrgRead(req, tenants, 'context');
    const logQL = buildLogQL(filter);
    const [before, after] = await Promise.all([
      loki.queryLogs(logQL, tenants, { startMs: atMs - span, endMs: atMs, limit, direction: 'backward' }),
      loki.queryLogs(logQL, tenants, { startMs: atMs, endMs: atMs + span, limit, direction: 'forward' }),
    ]);
    sendSuccess(res, 200, { before: before.reverse(), after });
  } catch (err) {
    sendQueryFailure(res, err, { before: [], after: [] });
  }
});

/**
 * GET /observability/logs/raw — one stream as text/plain, chronological.
 *
 * NOTE this is the caller's SLICE of the stream, not the container's file: a pod
 * is multi-tenant, so an org's "whole log" is its own lines from that stream.
 * The preamble says so, in the file itself.
 */
export const logRaw = withController('Log raw view', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const sysadmin = isSystemAdmin(req);

  const window = resolveWindow(req.query);
  if ('error' in window) { sendError(res, 400, window.error); return; }

  try {
    const filter = parseLogQuery(parseQueryString(req.query.q));
    const tenants = await tenantsForRequest(req, sysadmin);
    if (sysadmin) auditCrossOrgRead(req, tenants, 'raw');
    const entries = await loki.queryLogs(buildLogQL(filter), tenants, {
      startMs: window.startMs,
      endMs: window.endMs,
      limit: MAX_LIMIT,
      direction: 'forward',
    });
    const truncated = entries.length >= MAX_LIMIT;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send([
      ...renderPreamble({ tenants, sysadmin, window, filterText: parseQueryString(req.query.q) ?? '', truncated }),
      ...entries.map((e) => `${new Date(e.time).toISOString()} ${e.line}`),
      ...(truncated ? [`# TRUNCATED at ${MAX_LIMIT} lines — narrow the range or use the download for the full extract.`] : []),
    ].join('\n'));
  } catch (err) {
    sendQueryFailure(res, err, { entries: [] });
  }
});

/** Provenance header written into every raw view and export. */
function renderPreamble(opts: {
  tenants: string;
  sysadmin: boolean;
  window: ResolvedWindow;
  filterText: string;
  truncated: boolean;
}): string[] {
  return [
    '# Pipeline Builder — log extract',
    `# generated:    ${new Date().toISOString()}`,
    `# scope:        ${opts.sysadmin ? `tenants=${opts.tenants}` : 'your organization only'}`,
    `# window:       ${new Date(opts.window.startMs).toISOString()} .. ${new Date(opts.window.endMs).toISOString()}`
      + (opts.window.clamped ? ' (clamped to the 7-day retention window)' : ''),
    `# filter:       ${opts.filterText || '(none)'}`,
    '# NOTE: this is a FILTERED, MASKED extract, not a raw container log. Lines',
    '#       belonging to other organizations are not included, and credential-',
    '#       shaped values are replaced with [REDACTED].',
    '#',
  ];
}

/** Sanitize a filename component before it reaches Content-Disposition. */
function safeName(name: string): string {
  return (name || 'logs').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * GET /observability/logs/export — stream the extract as a download.
 *
 * Streams rather than buffers: a busy stream over the retention window is far
 * larger than one `query_range` (capped at `max_entries_limit_per_query`) can
 * return, and buffering it would take the replica down. Budget is bytes + wall
 * clock, since entry sizes vary far too much for a count to bound anything.
 *
 * Failure has to be decided BEFORE the first byte — once the response is
 * streaming, the only way to signal trouble is a truncation footer.
 */
export const logExport = withController('Log export', async (req, res) => {
  if (!requireAuth(req, res)) return;

  // Read-only impersonation must not be able to exfiltrate the viewed org's
  // logs. The platform-wide gate keys off the HTTP METHOD (it rejects non-GET),
  // and this is a GET, so it would sail straight through — the check has to be
  // here. Downloading a tenant's logs while "viewing as" one of its users is
  // precisely the egress that mode exists to prevent.
  if (req.user?.impersonationReadOnly === true) {
    sendError(res, 403, 'Log export is not available during a read-only impersonation session');
    return;
  }

  const sysadmin = isSystemAdmin(req);

  const window = resolveWindow(req.query);
  if ('error' in window) { sendError(res, 400, window.error); return; }
  const format = parseQueryString(req.query.format) === 'jsonl' ? 'jsonl' : 'log';

  let logQL: string;
  let tenants: string;
  const filterText = parseQueryString(req.query.q) ?? '';
  try {
    const filter = parseLogQuery(filterText);
    tenants = await tenantsForRequest(req, sysadmin);
    logQL = buildLogQL(filter);
  } catch (err) {
    sendQueryFailure(res, err, { entries: [] });
    return;
  }

  const filename = `${safeName(parseQueryString(req.query.name) ?? 'pipeline-builder-logs')}`
    + `-${new Date().toISOString().slice(0, 10)}.${format}`;
  res.setHeader('Content-Type', format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Defensive: nginx must not buffer this (see the /api/observability/logs
  // location), and no intermediary should cache an org's log extract.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  if (format === 'log') {
    res.write(renderPreamble({ tenants, sysadmin, window, filterText, truncated: false }).join('\n') + '\n');
  }

  let bytes = 0;
  let lines = 0;
  let truncated = false;
  try {
    for await (const page of loki.iterateLogs(logQL, tenants, {
      startMs: window.startMs,
      endMs: window.endMs,
      pageSize: EXPORT_PAGE_SIZE,
      maxEntries: EXPORT_MAX_ENTRIES,
      deadlineMs: EXPORT_DEADLINE_MS,
    })) {
      const chunk = page.map((e) => (format === 'jsonl'
        ? JSON.stringify({ time: e.time, line: e.line, labels: e.labels })
        : `${new Date(e.time).toISOString()} ${e.line}`)).join('\n') + '\n';
      bytes += Buffer.byteLength(chunk);
      lines += page.length;
      if (bytes > EXPORT_MAX_BYTES) { truncated = true; break; }
      if (!res.write(chunk)) {
        // Respect backpressure: a slow client must not let us buffer unboundedly.
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch {
    truncated = true;
  }

  if (truncated) {
    res.write(`# TRUNCATED — hit the export cap (${EXPORT_MAX_BYTES} bytes / ${EXPORT_DEADLINE_MS}ms). Narrow the range or filter.\n`);
  }
  res.end();

  audit(req, 'observability.logs.export', {
    targetType: 'logs',
    details: {
      format,
      lines,
      bytes,
      truncated,
      from: new Date(window.startMs).toISOString(),
      to: new Date(window.endMs).toISOString(),
      filter: filterText || undefined,
      tenantCount: tenants.split('|').length,
    },
  });
});
