// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vulnerability exposure and time to fix: the advanced security report.
 *
 * ONE function, {@link getVulnerabilityExposure}, serves both the dashboard panel
 * (`GET /reports/security/vulnerabilities`) and the `vulnerability_exposure`
 * stakeholder section. The two must agree to the digit for the same range and
 * timezone, and the only way that stays true is if there is nothing to drift.
 *
 * WHERE THE NUMBERS COME FROM. Two tables in the shared database:
 *
 *  - `plugin_vuln_exposure` (reporting-owned): one row per (pipeline, plugin
 *    version, image digest, source). It carries history — `flagged_at`,
 *    `fixed_at`, the triage state and the acceptance deadline — so it is the
 *    source for open-at-a-moment, new vs fixed, time to fix and expiring
 *    acceptances. It only counts Critical and High (that is what the rescan
 *    gates on), so its Medium/Low are always zero.
 *  - `pipeline_security_reports` (pipeline-owned, read-only here): the LATEST
 *    scanner report a pipeline run uploaded per (pipeline, tool, stage) — what
 *    the pipeline's own scan steps found in what it builds. It has all four
 *    severities and an exact KEV count, but no history (each upload replaces the
 *    last), so it is shown as "latest", never bucketed.
 *
 * ONE EXPOSURE, NOT TWO. A pipeline usually has both a `declared` row (what its
 * config asks for) and a `deployed` row (what last ran) for the same version.
 * Counting rows would show every finding twice, so rows are grouped by
 * (pipeline, plugin, version, digest) first. Such an exposure is FIXED only when
 * every one of its rows is closed and at least one closed as `fixed` — a config
 * updated to a patched version while the old image keeps running is not fixed,
 * and a pipeline that was deleted (`removed`) was not remediated.
 *
 * AS OF THE END OF THE RANGE. Point-in-time figures (open, KEV, expiring
 * acceptances) are taken at `min(to, now)`, so a report for last month says what
 * was open at the end of last month. Triage decisions (false positive, accepted)
 * are stored as their CURRENT state with no history, so they are applied as they
 * stand today; the methodology says so.
 *
 * TEAM-LEVEL ONLY. No triager, submitter or any other person is read or returned.
 */

import { instantOfCivil, isUsableTimeZone, type WeekStart } from '@pipeline-builder/api-core';
import { sql, type SQL } from 'drizzle-orm';
import { elevateRollup, orgScope } from './query-scope.js';
import { periodBucket, assertReportInterval } from './sql-helpers.js';
import { anyText, resultRows } from '../../database/pg-result.js';
import { withTenantTxRead } from '../../database/tenancy.js';

/** The org + window every security read takes (the analytics scope shape). */
export interface SecurityScope {
  orgId: string;
  /** `[self, ...descendants]` for a rollup; undefined = this org only. */
  orgIds?: string[];
  from: string;
  to: string;
}

/** How the series is bucketed. Same params the dashboard's other series take. */
export interface SecurityBucket {
  interval: string;
  tz?: string;
  weekStart?: WeekStart;
  /** Clock override for tests. */
  now?: Date;
}

type ReadTx = Parameters<Parameters<typeof withTenantTxRead>[0]>[0];

/** The step a bucket series advances by, per interval. */
const STEP: Record<string, string> = { day: '1 day', week: '1 week', month: '1 month', quarter: '3 months' };

/** A usable IANA zone, or UTC. */
export function safeTz(tz: string | undefined): string {
  return tz && isUsableTimeZone(tz) ? tz : 'UTC';
}

/**
 * Every bucket in `[from, to)` as `(period text, start timestamptz, end timestamptz)`,
 * zero rows when the range is empty.
 *
 * Built from {@link periodBucket} so the labels are byte-identical to the
 * `GROUP BY period` keys of the same expression — a bucket with no activity
 * then shows as a zero, not as a gap the chart silently closes.
 */
export function bucketSeries(interval: string, from: string, to: string, tz: string, weekStart: WeekStart): SQL {
  assertReportInterval(interval);
  const step = STEP[interval];
  const first = periodBucket(interval, sql`${from}::timestamptz`, tz, weekStart);
  const last = periodBucket(interval, sql`(${to}::timestamptz - INTERVAL '1 microsecond')`, tz, weekStart);
  return sql`(
    SELECT g::text AS period,
           (g AT TIME ZONE ${tz}) AS bucket_start,
           ((g + ${step}::interval) AT TIME ZONE ${tz}) AS bucket_end
    FROM generate_series(${first}, ${last}, ${step}::interval) AS g
    WHERE ${from}::timestamptz < ${to}::timestamptz
  )`;
}

/**
 * One security read: the anchor-validated org set and the same rollup elevation
 * the analytics reads use (FORCE RLS would otherwise drop every child team's rows
 * from a parent's rollup). `org` is the predicate on `org_id`.
 */
export function securityRead<T>(scope: SecurityScope, fn: (org: SQL, tx: ReadTx) => Promise<T>): Promise<T> {
  const { ids, multi } = orgScope(scope.orgId, scope.orgIds);
  const org = multi ? sql`= ${anyText(ids)}` : sql`= ${ids[0]}`;
  return elevateRollup(multi, () => withTenantTxRead((tx) => fn(org, tx)));
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

const isoOrNull = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A dashboard range bound as an ISO instant in `tz`. The date pickers send
 * `YYYY-MM-DD`; read as UTC, a Chicago team's "Sept 1" would start on Aug 31
 * locally and stop lining up with the stakeholder report, whose periods start at
 * LOCAL midnight. A full timestamp is normalized as-is.
 */
export function securityBound(value: string, tz: string | undefined): string {
  const m = DATE_ONLY.exec(value);
  if (m) {
    return instantOfCivil({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, safeTz(tz)).toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/** The point-in-time moment of a range: its end, or now when the end is in the future. */
export function asOfFor(to: string, now: Date): Date {
  const end = new Date(to);
  return Number.isNaN(end.getTime()) || end.getTime() > now.getTime() ? now : end;
}

/** One bucket of the new-vs-fixed series. */
export interface VulnTrendPoint {
  period: string;
  /** Exposures first flagged in the bucket. */
  new: number;
  /** Exposures whose last open row closed as fixed in the bucket. */
  fixed: number;
}

/** An acceptance that lapses within 30 days of the as-of moment. */
export interface ExpiringAcceptance {
  pipelineId: string;
  pipelineName: string | null;
  plugin: string;
  version: string;
  acceptedUntil: string;
  /** Whole days from the as-of moment to the deadline (0 = today). */
  daysLeft: number;
}

/** The whole report, as both the dashboard and the stakeholder section show it. */
export interface VulnerabilityExposureReport {
  window: { from: string; to: string };
  /** The point-in-time moment the open / KEV / expiring figures are taken at. */
  asOf: string;
  /** Plugin-image exposures open at `asOf`, grouped one per pipeline + version. */
  open: {
    exposures: number;
    pipelines: number;
    /** Findings, summed over open exposures. Medium/low: see the module header. */
    critical: number;
    high: number;
    medium: number;
    low: number;
    /**
     * Known-exploited findings among the itemized ones. A LOWER BOUND: an
     * exposure stores at most its top findings, so a KEV past that cap is not
     * counted here (the scanner reports below carry an exact count).
     */
    kev: number;
  };
  /** The pipelines' own latest scanner reports (no history; not bucketed). */
  scanners: {
    reports: number;
    pipelines: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    kev: number;
  };
  /** flagged_at → fixed_at over exposures FIXED within the window. */
  timeToFix: { n: number; medianSeconds: number | null; p90Seconds: number | null };
  trend: VulnTrendPoint[];
  totals: { new: number; fixed: number };
  /** Accepted-risk exposures whose acceptance lapses within 30 days of `asOf`. */
  expiringAcceptances: { count: number; items: ExpiringAcceptance[] };
}

/** At most this many expiring acceptances are itemized (the count is exact). */
const EXPIRING_LIST_LIMIT = 50;
const EXPIRY_HORIZON_DAYS = 30;

/**
 * Exposure rows grouped one per (pipeline, plugin, version, digest), with what
 * each group was at `asOf`. The CTE every part of the report reads.
 */
function exposureGroups(org: SQL, asOf: Date): SQL {
  const openAt = sql`(v.flagged_at <= ${asOf}
      AND (v.fixed_at IS NULL OR v.fixed_at > ${asOf})
      AND v.triage_state <> 'false_positive'
      AND NOT (v.triage_state = 'accepted' AND (v.accepted_until IS NULL OR v.accepted_until > ${asOf})))`;
  return sql`
    SELECT
      v.pipeline_id,
      COALESCE(v.plugin_publisher || '/', '') || v.plugin_name AS plugin,
      v.plugin_version,
      COALESCE(v.image_digest, '') AS digest,
      MIN(v.flagged_at) AS flagged_at,
      bool_and(v.triage_state = 'false_positive') AS all_false_positive,
      (bool_and(v.fixed_at IS NOT NULL) AND bool_or(v.triage_state = 'fixed')) AS is_fixed,
      MAX(v.fixed_at) AS fixed_at,
      bool_or(${openAt}) AS is_open,
      COALESCE(MAX(v.critical_count) FILTER (WHERE ${openAt}), 0) AS open_critical,
      COALESCE(MAX(v.high_count) FILTER (WHERE ${openAt}), 0) AS open_high
    FROM plugin_vuln_exposure v
    WHERE v.org_id ${org}
    GROUP BY v.pipeline_id, plugin, v.plugin_version, digest`;
}

/**
 * The vulnerability exposure and time-to-fix report for a window.
 *
 * `bucket.interval` is validated against the report-interval allow-list (the
 * route validates it first); `tz` falls back to UTC when unusable.
 */
export async function getVulnerabilityExposure(scope: SecurityScope, bucket: SecurityBucket): Promise<VulnerabilityExposureReport> {
  assertReportInterval(bucket.interval);
  const tz = safeTz(bucket.tz);
  const weekStart = bucket.weekStart ?? 'monday';
  const asOf = asOfFor(scope.to, bucket.now ?? new Date());
  const { from, to } = scope;
  const horizon = new Date(asOf.getTime() + EXPIRY_HORIZON_DAYS * 86_400_000);

  return securityRead(scope, async (org, tx) => {
    const groups = exposureGroups(org, asOf);

    const [openRes, kevRes, scanRes, ttfRes, trendRes, expRes] = [
      await tx.execute(sql`
        WITH g AS (${groups})
        SELECT COUNT(*) FILTER (WHERE is_open)::int AS exposures,
               COUNT(DISTINCT pipeline_id) FILTER (WHERE is_open)::int AS pipelines,
               COALESCE(SUM(open_critical) FILTER (WHERE is_open), 0)::int AS critical,
               COALESCE(SUM(open_high) FILTER (WHERE is_open), 0)::int AS high
        FROM g`),
      await tx.execute(sql`
        SELECT COUNT(DISTINCT v.pipeline_id || '|' || v.plugin_name || '|' || v.plugin_version || '|'
                     || COALESCE(v.image_digest, '') || '|' || (f->>'id'))::int AS kev
        FROM plugin_vuln_exposure v, jsonb_array_elements(v.top_findings) AS f
        WHERE v.org_id ${org}
          AND jsonb_typeof(v.top_findings) = 'array'
          AND f->>'kev' = 'true'
          AND v.flagged_at <= ${asOf}
          AND (v.fixed_at IS NULL OR v.fixed_at > ${asOf})
          AND v.triage_state <> 'false_positive'
          AND NOT (v.triage_state = 'accepted' AND (v.accepted_until IS NULL OR v.accepted_until > ${asOf}))`),
      // Scoped to pipelines still in use: a deleted pipeline's last report is not
      // exposure anybody carries.
      await tx.execute(sql`
        SELECT COUNT(*)::int AS reports,
               COUNT(DISTINCT r.pipeline_id)::int AS pipelines,
               COALESCE(SUM(r.critical_count), 0)::int AS critical,
               COALESCE(SUM(r.high_count), 0)::int AS high,
               COALESCE(SUM(r.medium_count), 0)::int AS medium,
               COALESCE(SUM(r.low_count), 0)::int AS low,
               COALESCE(SUM(r.kev_count), 0)::int AS kev
        FROM pipeline_security_reports r
        JOIN pipelines p ON p.id::text = r.pipeline_id AND p.deleted_at IS NULL
        WHERE r.org_id ${org}`),
      await tx.execute(sql`
        WITH g AS (${groups})
        SELECT COUNT(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fixed_at - flagged_at))) AS median_s,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fixed_at - flagged_at))) AS p90_s
        FROM g
        WHERE is_fixed AND fixed_at >= ${from}::timestamptz AND fixed_at < ${to}::timestamptz`),
      await tx.execute(sql`
        WITH g AS (${groups}),
        b AS ${bucketSeries(bucket.interval, from, to, tz, weekStart)},
        n AS (
          SELECT ${periodBucket(bucket.interval, sql`flagged_at`, tz, weekStart)}::text AS period, COUNT(*)::int AS c
          FROM g
          WHERE NOT all_false_positive AND flagged_at >= ${from}::timestamptz AND flagged_at < ${to}::timestamptz
          GROUP BY 1),
        f AS (
          SELECT ${periodBucket(bucket.interval, sql`fixed_at`, tz, weekStart)}::text AS period, COUNT(*)::int AS c
          FROM g
          WHERE is_fixed AND fixed_at >= ${from}::timestamptz AND fixed_at < ${to}::timestamptz
          GROUP BY 1)
        SELECT b.period, COALESCE(n.c, 0)::int AS new, COALESCE(f.c, 0)::int AS fixed
        FROM b LEFT JOIN n ON n.period = b.period LEFT JOIN f ON f.period = b.period
        ORDER BY b.period`),
      await tx.execute(sql`
        SELECT v.pipeline_id, p.pipeline_name,
               COALESCE(v.plugin_publisher || '/', '') || v.plugin_name AS plugin,
               v.plugin_version,
               MIN(v.accepted_until) AS accepted_until
        FROM plugin_vuln_exposure v
        LEFT JOIN pipelines p ON p.id::text = v.pipeline_id
        WHERE v.org_id ${org}
          AND v.triage_state = 'accepted'
          AND (v.fixed_at IS NULL OR v.fixed_at > ${asOf})
          AND v.accepted_until > ${asOf}
          AND v.accepted_until <= ${horizon}
        GROUP BY v.pipeline_id, p.pipeline_name, plugin, v.plugin_version, COALESCE(v.image_digest, '')
        ORDER BY accepted_until, plugin`),
    ];

    const o = resultRows<Record<string, unknown>>(openRes)[0] ?? {};
    const k = resultRows<Record<string, unknown>>(kevRes)[0] ?? {};
    const s = resultRows<Record<string, unknown>>(scanRes)[0] ?? {};
    const t = resultRows<Record<string, unknown>>(ttfRes)[0] ?? {};
    const trend = resultRows<Record<string, unknown>>(trendRes).map((r) => ({
      period: String(r.period), new: num(r.new), fixed: num(r.fixed),
    }));
    const expiring = resultRows<Record<string, unknown>>(expRes).map((r) => {
      const until = isoOrNull(r.accepted_until) ?? asOf.toISOString();
      return {
        pipelineId: String(r.pipeline_id),
        pipelineName: (r.pipeline_name as string | null) ?? null,
        plugin: String(r.plugin),
        version: String(r.plugin_version),
        acceptedUntil: until,
        daysLeft: Math.max(0, Math.floor((new Date(until).getTime() - asOf.getTime()) / 86_400_000)),
      };
    });
    const n = num(t.n);
    const round = (v: unknown) => { const x = numOrNull(v); return x === null ? null : Math.round(x); };

    return {
      window: { from, to },
      asOf: asOf.toISOString(),
      open: {
        exposures: num(o.exposures),
        pipelines: num(o.pipelines),
        critical: num(o.critical),
        high: num(o.high),
        medium: 0,
        low: 0,
        kev: num(k.kev),
      },
      scanners: {
        reports: num(s.reports),
        pipelines: num(s.pipelines),
        critical: num(s.critical),
        high: num(s.high),
        medium: num(s.medium),
        low: num(s.low),
        kev: num(s.kev),
      },
      timeToFix: { n, medianSeconds: n > 0 ? round(t.median_s) : null, p90Seconds: n > 0 ? round(t.p90_s) : null },
      trend,
      totals: {
        new: trend.reduce((a, r) => a + r.new, 0),
        fixed: trend.reduce((a, r) => a + r.fixed, 0),
      },
      expiringAcceptances: { count: expiring.length, items: expiring.slice(0, EXPIRING_LIST_LIMIT) },
    };
  });
}
