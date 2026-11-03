// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read models over the stored scan results (`scan_summary` / `scan_flag` on
 * `plugins` and `plugin_listing_versions`) and the exposure data
 * (`pipeline_step_manifests`, `pipeline_plugin_resolution`):
 *
 *  - {@link searchAdvisory}: "which of our plugins and pipelines does CVE-X hit?"
 *  - {@link versionFindings}: one version's full finding list (JSON or CSV);
 *  - {@link fleetPosture}: the operator's cross-tenant view;
 *  - {@link listedVersionsNeedingAttention}: the moderators' view of LISTED
 *    versions a later rescan flagged, or whose scan went stale.
 *
 * A version that is no longer live — inactive, yanked, deleted, or on a
 * suspended / withdrawn listing — still counts while a pipeline REFERENCES it
 * (pipeline-data `versionReferencedPredicate`, the removal rule's SQL form): a
 * CVE in an image a pipeline still pulls is exactly what these views exist to
 * surface. Each such version is labelled with its `state`.
 *
 * Everything here reads; nothing writes.
 */

import { parseVulnWaivers, pluginVulnFailOn, pluginVulnGateKev, pluginVulnMaxFindings, scanStaleHours, type PluginScanFinding } from '@pipeline-builder/api-core';
import {
  buildPluginConditions, executeRows, pipelinesOnVersion, runWithTenantContext, schema, versionReferencedPredicate, withTenantTx, withViewerContext,
  type PipelineOnVersion, type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

/** The `scan_summary` fields these views read (a subset of api-core's PluginScanSummary). */
interface StoredSummary {
  criticalFixable?: number;
  highFixable?: number;
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  kev?: number;
  findings?: PluginScanFinding[];
  truncated?: boolean;
  waived?: string[];
  scannedAt?: string;
  trigger?: string;
  imageDigest?: string;
  dbBuiltAt?: string | null;
  uncataloguedBinaries?: string[];
}

const asSummary = (v: unknown): StoredSummary | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as StoredSummary : null);
const findingsOf = (v: unknown): PluginScanFinding[] => {
  const raw = asSummary(v)?.findings;
  return Array.isArray(raw) ? raw.filter((f) => f && typeof f.id === 'string') : [];
};
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Advisory ids are compared case-insensitively (`ghsa-…` and `GHSA-…` are one advisory). */
const sameId = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/**
 * A version's lifecycle state in these views. Anything but `active` is listed
 * only because a pipeline still references it.
 */
export type VersionState = 'active' | 'inactive' | 'yanked' | 'deleted' | 'suspended' | 'withdrawn';

/** The state of a `plugins` row (alias `p`-shaped columns). */
const orgRowState = (alias: string) => sql.raw(`CASE WHEN ${alias}.deleted_at IS NOT NULL THEN 'deleted' WHEN ${alias}.yanked_at IS NOT NULL THEN 'yanked'
  WHEN ${alias}.is_active IS NOT TRUE THEN 'inactive' ELSE 'active' END`);
/** The state of a listing version `v` of listing `l`. */
const LISTED_STATE = sql.raw(`CASE WHEN l.state = 'suspended' THEN 'suspended' WHEN v.yanked_at IS NOT NULL THEN 'yanked'
  WHEN l.state IN ('listed', 'unmaintained') THEN 'active' ELSE 'withdrawn' END`);

/** Some pipeline references this `plugins` row (alias). */
const orgRowReferenced = (alias: string) => versionReferencedPredicate({
  digest: sql.raw(`${alias}.image_digest`), name: sql.raw(`${alias}.name`), version: sql.raw(`${alias}.version`), orgId: sql.raw(`${alias}.org_id`),
});
/** Some pipeline pins this listing version's image (listing versions are matched by digest). */
const listedReferenced = () => versionReferencedPredicate({ digest: sql.raw('v.image_digest'), name: sql`NULL`, version: sql`NULL`, orgId: sql`NULL` });

const asState = (v: unknown): VersionState => (typeof v === 'string' && ['inactive', 'yanked', 'deleted', 'suspended', 'withdrawn'].includes(v) ? v as VersionState : 'active');

/** A version (org row or listing version) a finding was found in. */
export interface AffectedVersion {
  /** `org` = a `plugins` row; `listing` = a published listing version. */
  source: 'org' | 'listing';
  id: string;
  /** Owning org of an org row; null for a listing version. */
  orgId: string | null;
  /** Listing publisher handle; null for an org row. */
  publisher: string | null;
  name: string;
  version: string;
  imageDigest: string | null;
  /** `active`, or why a version still listed here is not live (a pipeline references it). */
  state: VersionState;
  scannedAt: string | null;
  /** The matching findings (one advisory can hit several packages). */
  findings: PluginScanFinding[];
  /** The stored finding list was capped, so absence elsewhere is not proof. */
  truncated: boolean;
  /** The CALLER's pipelines declaring or running this version. */
  pipelines: PipelineOnVersion[];
}

/** Rows a jsonb finding-list search returns. */
interface FindingRow {
  id: string;
  org_id: string | null;
  publisher: string | null;
  name: string;
  version: string;
  image_digest: string | null;
  scanned_at: unknown;
  scan_summary: unknown;
  scan_flag: unknown;
  state?: unknown;
}

/** `EXISTS a finding with this id in the summary or the flag`, for a table alias. */
const findingMatch = (alias: string, advisoryId: string) => sql`(
  EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${sql.raw(alias)}.scan_summary->'findings', '[]'::jsonb)) f
          WHERE upper(f->>'id') = upper(${advisoryId}))
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${sql.raw(alias)}.scan_flag->'findings', '[]'::jsonb)) f
          WHERE upper(f->>'id') = upper(${advisoryId})))`;

/**
 * Every plugin version visible to the caller — its own rows, its parent's shared
 * rows, public and system-org rows, and every live listing's versions — whose
 * stored findings name `advisoryId`, with the caller's pipelines on each. A
 * deleted row, a yanked listing version or a suspended listing's version is
 * included while a pipeline still references it, labelled with its `state`.
 */
export async function searchAdvisory(advisoryId: string, orgId: string, parentOrgId?: string): Promise<{ advisoryId: string; versions: AffectedVersion[]; affectedPipelines: number }> {
  const P = schema.plugin;
  const conditions = [
    ...buildPluginConditions(withViewerContext<PluginFilter>({}), orgId, parentOrgId),
    or(isNull(P.deletedAt), orgRowReferenced('plugins'))!,
  ];
  const readOrgRows = () => withTenantTx((tx) => tx
    .select({
      id: P.id,
      orgId: P.orgId,
      name: P.name,
      version: P.version,
      imageDigest: P.imageDigest,
      scannedAt: P.scannedAt,
      scanSummary: P.scanSummary,
      scanFlag: P.scanFlag,
      state: sql<string>`${orgRowState('plugins')}`,
    })
    .from(P)
    .where(and(...conditions, findingMatch('plugins', advisoryId)))
    .limit(500));
  // A parent-org row sits outside the caller's RLS scope; the access-control
  // WHERE above is the gate for it (as in the plugin service's reads).
  const orgRows = parentOrgId ? await runWithTenantContext({ isSuperAdmin: true }, readOrgRows) : await readOrgRows();

  // Listing versions are app-role only: an elevated read, limited to live listings.
  const listed = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => executeRows<FindingRow>(tx, sql`
    SELECT v.id::text AS id, NULL AS org_id, pub.handle AS publisher, l.name, v.version, v.image_digest,
           v.scanned_at, v.scan_summary, v.scan_flag, ${LISTED_STATE} AS state
      FROM plugin_listing_versions v
      JOIN plugin_listings l ON l.id = v.listing_id
      JOIN publishers pub ON pub.id = l.publisher_id
     WHERE ${findingMatch('v', advisoryId)}
       AND ((v.yanked_at IS NULL AND l.state IN ('listed', 'unmaintained'))
            OR (v.image_digest IS NOT NULL AND ${listedReferenced()}))
     LIMIT 500
  `)));

  const rows: FindingRow[] = [
    ...orgRows.map((r) => ({
      id: r.id,
      org_id: r.orgId,
      publisher: null,
      name: r.name,
      version: r.version,
      image_digest: r.imageDigest,
      scanned_at: r.scannedAt,
      scan_summary: r.scanSummary,
      scan_flag: r.scanFlag,
      state: r.state,
    })),
    ...listed,
  ];
  const versions: AffectedVersion[] = [];
  for (const r of rows) {
    const summaryFindings = findingsOf(r.scan_summary);
    const flagFindings = findingsOf(r.scan_flag);
    const findings = (summaryFindings.length > 0 ? summaryFindings : flagFindings).filter((f) => sameId(f.id, advisoryId));
    const pipelines = await pipelinesOnVersion({
      pluginName: r.name,
      pluginVersion: r.version,
      pluginPublisher: r.publisher,
      ...(r.image_digest ? { imageDigest: r.image_digest } : {}),
      orgIds: [orgId],
    });
    versions.push({
      source: r.publisher ? 'listing' : 'org',
      id: r.id,
      orgId: r.org_id,
      publisher: r.publisher,
      name: r.name,
      version: r.version,
      imageDigest: r.image_digest,
      state: asState(r.state),
      scannedAt: iso(asSummary(r.scan_summary)?.scannedAt) ?? iso(r.scanned_at),
      findings,
      truncated: asSummary(r.scan_summary)?.truncated === true,
      pipelines,
    });
  }
  // Versions running in the caller's pipelines first: that is the to-do list.
  versions.sort((a, b) => b.pipelines.length - a.pipelines.length || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    advisoryId,
    versions,
    affectedPipelines: new Set(versions.flatMap((v) => v.pipelines.map((p) => p.pipelineId))).size,
  };
}

/** One version's stored scan, as the findings endpoint returns it. */
export interface VersionFindings {
  plugin: { source: 'org' | 'listing'; id: string; orgId: string | null; publisher: string | null; name: string; version: string; imageDigest: string | null };
  /** The latest scan's summary (counts, provenance, coverage); null = none stored. */
  summary: Omit<StoredSummary, 'findings'> | null;
  /** The rescan's gating flag while one is set. */
  flagged: boolean;
  scanFlaggedAt: string | null;
  /** Every stored Critical/High finding (the summary's, else the flag's). */
  findings: Array<PluginScanFinding & { waived: boolean }>;
}

/** Shape one stored row into {@link VersionFindings}. */
function shapeFindings(row: FindingRow & { scan_flagged_at?: unknown }, source: 'org' | 'listing'): VersionFindings {
  const summary = asSummary(row.scan_summary);
  const findings = summary?.findings && summary.findings.length > 0 ? findingsOf(row.scan_summary) : findingsOf(row.scan_flag);
  const waived = new Set(summary?.waived ?? []);
  const { findings: _omit, ...rest } = summary ?? {};
  void _omit;
  return {
    plugin: { source, id: row.id, orgId: row.org_id, publisher: row.publisher, name: row.name, version: row.version, imageDigest: row.image_digest },
    summary: summary ? rest : null,
    flagged: !!row.scan_flagged_at,
    scanFlaggedAt: iso(row.scan_flagged_at),
    // `waived` holds finding keys in api-core's `scanFindingKey` shape.
    findings: findings.map((f) => ({ ...f, waived: waived.has(`${f.id}|${f.packageName}|${f.packageVersion}`) })),
  };
}

/**
 * One version's findings: a `plugins` row the caller can read, else a version
 * of a live listing (listing versions are public catalog entries). Null = none.
 */
export async function versionFindings(id: string, orgId: string, parentOrgId?: string): Promise<VersionFindings | null> {
  const P = schema.plugin;
  const conditions = [
    ...buildPluginConditions(withViewerContext<PluginFilter>({}), orgId, parentOrgId),
    isNull(P.deletedAt),
    eq(P.id, id),
  ];
  const read = () => withTenantTx((tx) => tx
    .select({
      id: P.id,
      orgId: P.orgId,
      name: P.name,
      version: P.version,
      imageDigest: P.imageDigest,
      scannedAt: P.scannedAt,
      scanSummary: P.scanSummary,
      scanFlag: P.scanFlag,
      scanFlaggedAt: P.scanFlaggedAt,
    })
    .from(P)
    .where(and(...conditions))
    .limit(1));
  const [own] = parentOrgId ? await runWithTenantContext({ isSuperAdmin: true }, read) : await read();
  if (own) {
    return shapeFindings({
      id: own.id,
      org_id: own.orgId,
      publisher: null,
      name: own.name,
      version: own.version,
      image_digest: own.imageDigest,
      scanned_at: own.scannedAt,
      scan_summary: own.scanSummary,
      scan_flag: own.scanFlag,
      scan_flagged_at: own.scanFlaggedAt,
    }, 'org');
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [listed] = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => executeRows<FindingRow & { scan_flagged_at: unknown }>(tx, sql`
    SELECT v.id::text AS id, NULL AS org_id, pub.handle AS publisher, l.name, v.version, v.image_digest,
           v.scanned_at, v.scan_summary, v.scan_flag, v.scan_flagged_at
      FROM plugin_listing_versions v
      JOIN plugin_listings l ON l.id = v.listing_id AND l.state IN ('listed', 'unmaintained')
      JOIN publishers pub ON pub.id = l.publisher_id
     WHERE v.id = ${id}::uuid
     LIMIT 1
  `)));
  return listed ? shapeFindings(listed, 'listing') : null;
}

/** RFC 4180 field, with spreadsheet-formula neutralization (a leading `=+-@`). */
function csvField(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The findings as CSV, one row per finding. */
export function findingsCsv(f: VersionFindings): string {
  const header = ['plugin', 'version', 'image_digest', 'advisory', 'severity', 'package', 'package_version', 'fixed_in', 'fixable', 'kev', 'epss', 'waived'];
  const name = f.plugin.publisher ? `${f.plugin.publisher}/${f.plugin.name}` : f.plugin.name;
  const lines = f.findings.map((x) => [
    name, f.plugin.version, f.plugin.imageDigest, x.id, x.severity, x.packageName, x.packageVersion,
    x.fixedIn.join(' '), x.fixedIn.length > 0, x.kev === true, x.epss ?? '', x.waived,
  ].map(csvField).join(','));
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

/** A version in the fleet's attention lists. */
export interface PostureVersion {
  source: 'org' | 'listing';
  id: string;
  orgId: string | null;
  publisher: string | null;
  name: string;
  version: string;
  /** `active`, or why a version still listed here is not live (a pipeline references it). */
  state: VersionState;
  scanFlaggedAt: string | null;
  lastScannedAt: string | null;
  critical: number;
  high: number;
}

/** Counts over one bucket of versions. */
interface PostureCounts {
  versions: number;
  unscanned: number;
  stale: number;
  flagged: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  kev: number;
  criticalFixable: number;
  highFixable: number;
  /** Versions whose image carries executables no SBOM package accounts for. */
  withUncataloguedBinaries: number;
  uncataloguedBinaries: number;
  /** Versions no longer live (inactive, yanked, deleted, suspended) counted because a pipeline references them. */
  withdrawnReferenced: number;
}

const countsOf = (r: Record<string, unknown>): PostureCounts => ({
  versions: int(r.versions),
  unscanned: int(r.unscanned),
  stale: int(r.stale),
  flagged: int(r.flagged),
  critical: int(r.critical),
  high: int(r.high),
  medium: int(r.medium),
  low: int(r.low),
  kev: int(r.kev),
  criticalFixable: int(r.critical_fixable),
  highFixable: int(r.high_fixable),
  withUncataloguedBinaries: int(r.with_uncatalogued),
  uncataloguedBinaries: int(r.uncatalogued),
  withdrawnReferenced: int(r.withdrawn_referenced),
});

const sumCounts = (rows: PostureCounts[]): PostureCounts => rows.reduce((a, b) => {
  const out = { ...a };
  for (const k of Object.keys(b) as Array<keyof PostureCounts>) out[k] = a[k] + b[k];
  return out;
}, countsOf({}));

/** `GREATEST(build scan, rescan summary)` — when a row was last scanned. */
const lastScan = (alias: string) => sql.raw(`GREATEST(${alias}.scanned_at, (${alias}.scan_summary->>'scannedAt')::timestamptz)`);

/** The shared aggregate columns (summary first, the row's own counts as fallback); `live` marks a live version. */
const aggregateColumns = (alias: string, staleBefore: Date, hasMediumLow: boolean, live: ReturnType<typeof sql>) => sql`
  COUNT(*) AS versions,
  COUNT(*) FILTER (WHERE ${lastScan(alias)} IS NULL) AS unscanned,
  COUNT(*) FILTER (WHERE ${lastScan(alias)} < ${staleBefore}) AS stale,
  COUNT(*) FILTER (WHERE ${sql.raw(alias)}.scan_flagged_at IS NOT NULL) AS flagged,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'critical')::int, ${sql.raw(alias)}.vuln_critical, 0)) AS critical,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'high')::int, ${sql.raw(alias)}.vuln_high, 0)) AS high,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'medium')::int, ${hasMediumLow ? sql.raw(`${alias}.vuln_medium`) : sql`NULL`}, 0)) AS medium,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'low')::int, ${hasMediumLow ? sql.raw(`${alias}.vuln_low`) : sql`NULL`}, 0)) AS low,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'kev')::int, 0)) AS kev,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'criticalFixable')::int, ${sql.raw(alias)}.vuln_critical_fixable, 0)) AS critical_fixable,
  SUM(COALESCE((${sql.raw(alias)}.scan_summary->>'highFixable')::int, ${sql.raw(alias)}.vuln_high_fixable, 0)) AS high_fixable,
  COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(${sql.raw(alias)}.scan_summary->'uncataloguedBinaries', '[]'::jsonb)) > 0) AS with_uncatalogued,
  SUM(jsonb_array_length(COALESCE(${sql.raw(alias)}.scan_summary->'uncataloguedBinaries', '[]'::jsonb))) AS uncatalogued,
  COUNT(*) FILTER (WHERE NOT (${live})) AS withdrawn_referenced`;

/** A live org version / listing version. */
const LIVE_PLUGIN = sql`p.deleted_at IS NULL AND p.is_active = true`;
const LIVE_LISTING_VERSION = sql`v.yanked_at IS NULL AND l.state IN ('listed', 'unmaintained')`;
/**
 * Versions that run an image of their own (the only ones a scan applies to):
 * live ones, and any other a pipeline still references.
 */
const imagePlugin = () => sql`p.build_type <> 'metadata_only' AND p.plugin_type <> 'ManualApprovalStep' AND ((${LIVE_PLUGIN}) OR ${orgRowReferenced('p')})`;
const liveListed = () => sql`v.image_digest IS NOT NULL AND ((${LIVE_LISTING_VERSION}) OR ${listedReferenced()})`;

/** Days a waiver counts as "expiring soon". */
const WAIVER_EXPIRY_WARNING_DAYS = 14;

/**
 * Listed versions needing a moderator: flagged by a rescan since they were
 * published (oldest flag first), and those whose scan is stale or missing.
 */
export async function listedVersionsNeedingAttention(now = new Date(), limit = 200): Promise<{ flagged: PostureVersion[]; staleOrUnscanned: PostureVersion[] }> {
  const staleBefore = new Date(now.getTime() - scanStaleHours() * 3_600_000);
  const rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => executeRows<Record<string, unknown>>(tx, sql`
    SELECT v.id::text AS id, pub.handle AS publisher, l.name, v.version, v.scan_flagged_at, ${LISTED_STATE} AS state,
           ${lastScan('v')} AS last_scanned_at,
           COALESCE((v.scan_flag->>'critical')::int, (v.scan_summary->>'criticalFixable')::int, v.vuln_critical_fixable, 0) AS critical,
           COALESCE((v.scan_flag->>'high')::int, (v.scan_summary->>'highFixable')::int, v.vuln_high_fixable, 0) AS high
      FROM plugin_listing_versions v
      JOIN plugin_listings l ON l.id = v.listing_id
      JOIN publishers pub ON pub.id = l.publisher_id
     WHERE ${liveListed()}
       AND (v.scan_flagged_at IS NOT NULL OR ${lastScan('v')} IS NULL OR ${lastScan('v')} < ${staleBefore})
     ORDER BY v.scan_flagged_at ASC NULLS LAST, ${lastScan('v')} ASC NULLS FIRST
     LIMIT ${limit * 2}
  `)));
  const shaped = rows.map((r): PostureVersion => ({
    source: 'listing',
    id: String(r.id),
    orgId: null,
    publisher: String(r.publisher),
    name: String(r.name),
    version: String(r.version),
    state: asState(r.state),
    scanFlaggedAt: iso(r.scan_flagged_at),
    lastScannedAt: iso(r.last_scanned_at),
    critical: int(r.critical),
    high: int(r.high),
  }));
  return {
    flagged: shaped.filter((v) => v.scanFlaggedAt).slice(0, limit),
    staleOrUnscanned: shaped.filter((v) => !v.scanFlaggedAt).slice(0, limit),
  };
}

/**
 * The fleet's vulnerability posture, across every tenant: counts by severity and
 * by org, the unscanned and stale versions, the oldest flags still open, the
 * waivers in force (and the ones about to lapse), and how many images carry
 * binaries the scanner cannot see into.
 */
export async function fleetPosture(now = new Date()) {
  const staleBefore = new Date(now.getTime() - scanStaleHours() * 3_600_000);
  return runWithTenantContext({ isSuperAdmin: true }, async () => {
    const [byOrgRows, listedRows, oldestRows] = await Promise.all([
      withTenantTx((tx) => executeRows<Record<string, unknown>>(tx, sql`
        SELECT p.org_id, ${aggregateColumns('p', staleBefore, true, LIVE_PLUGIN)}
          FROM plugins p
         WHERE ${imagePlugin()}
         GROUP BY p.org_id
         ORDER BY SUM(COALESCE((p.scan_summary->>'criticalFixable')::int, p.vuln_critical_fixable, 0)) DESC, p.org_id
      `)),
      withTenantTx((tx) => executeRows<Record<string, unknown>>(tx, sql`
        SELECT ${aggregateColumns('v', staleBefore, false, LIVE_LISTING_VERSION)}
          FROM plugin_listing_versions v
          JOIN plugin_listings l ON l.id = v.listing_id
         WHERE ${liveListed()}
      `)),
      withTenantTx((tx) => executeRows<Record<string, unknown>>(tx, sql`
        SELECT p.id::text AS id, p.org_id, p.name, p.version, p.scan_flagged_at, ${orgRowState('p')} AS state, ${lastScan('p')} AS last_scanned_at,
               COALESCE((p.scan_flag->>'critical')::int, 0) AS critical, COALESCE((p.scan_flag->>'high')::int, 0) AS high
          FROM plugins p
         WHERE ${imagePlugin()} AND p.scan_flagged_at IS NOT NULL
         ORDER BY p.scan_flagged_at ASC
         LIMIT 20
      `)),
    ]);
    const attention = await listedVersionsNeedingAttention(now);
    const byOrg = byOrgRows.map((r) => ({ orgId: String(r.org_id), ...countsOf(r) }));
    const listed = countsOf(listedRows[0] ?? {});
    const oldestFlagged: PostureVersion[] = [
      ...oldestRows.map((r): PostureVersion => ({
        source: 'org',
        id: String(r.id),
        orgId: String(r.org_id),
        publisher: null,
        name: String(r.name),
        version: String(r.version),
        state: asState(r.state),
        scanFlaggedAt: iso(r.scan_flagged_at),
        lastScannedAt: iso(r.last_scanned_at),
        critical: int(r.critical),
        high: int(r.high),
      })),
      ...attention.flagged.slice(0, 20),
    ].sort((a, b) => (a.scanFlaggedAt ?? '').localeCompare(b.scanFlaggedAt ?? '')).slice(0, 20);

    const waivers = parseVulnWaivers();
    const soon = now.getTime() + WAIVER_EXPIRY_WARNING_DAYS * 86_400_000;
    const inForce = waivers.filter((w) => w.expires.getTime() >= now.getTime());
    return {
      generatedAt: now.toISOString(),
      staleAfterHours: scanStaleHours(),
      /**
       * THE GATE THIS DEPLOYMENT ENFORCES, beside `staleAfterHours` for the same
       * reason: it is deployment config the reader cannot otherwise know.
       *
       * `failOn` reached the dashboard only on a scan FLAG, and a posture row
       * has none — so the fleet panel could not tell whether a version's Highs
       * block its build, and showed every High in yellow even where the
       * deployment refuses them. Which severities gate is one value for the
       * whole fleet, so it belongs on the envelope rather than repeated on
       * every row.
       */
      gate: {
        failOn: pluginVulnFailOn(),
        maxFindings: pluginVulnMaxFindings(),
        kev: pluginVulnGateKev(),
      },
      totals: sumCounts([...byOrg.map(({ orgId: _o, ...c }) => c), listed]),
      orgPlugins: sumCounts(byOrg.map(({ orgId: _o, ...c }) => c)),
      listedVersions: listed,
      byOrg,
      oldestFlagged,
      flaggedListedVersions: attention.flagged,
      staleListedVersions: attention.staleOrUnscanned,
      waivers: {
        inForce: inForce.length,
        expired: waivers.length - inForce.length,
        expiringSoon: inForce
          .filter((w) => w.expires.getTime() <= soon)
          .map((w) => ({ plugin: w.plugin, version: w.version, packages: w.packages, expires: w.expires.toISOString() })),
        expiringWithinDays: WAIVER_EXPIRY_WARNING_DAYS,
      },
    };
  });
}
