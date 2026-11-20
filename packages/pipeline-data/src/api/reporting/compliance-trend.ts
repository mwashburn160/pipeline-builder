// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance trend: the advanced compliance report.
 *
 * ONE function, {@link getComplianceTrend}, serves the dashboard panel
 * (`GET /reports/security/compliance-trend`) and the `compliance_trend`
 * stakeholder section, so the two cannot disagree for the same range and timezone.
 *
 * SOURCE AND OWNERSHIP. The compliance service owns and writes these tables;
 * they live in the same database as everything reporting reads, under the same
 * application role and the same per-org RLS, so this module only READS them —
 * never writes, never caches a copy. (The `compliance_posture` section asks the
 * compliance service over HTTP instead because it reports the service's live
 * rule state; a historical trend is a plain aggregate over rows that already
 * exist, and needs nothing the service computes.)
 *
 *  - `compliance_scans`: pass / warn / block counts per COMPLETED scan, bucketed
 *    by when the scan completed. Rule dry runs are excluded: they evaluate a
 *    draft rule and are not the org's verdict.
 *  - `compliance_exemptions`: created per bucket (any status), and ACTIVE per
 *    bucket — approved (or since expired) and in force at some point during the
 *    bucket. The approval time is not stored, so an exemption counts from its
 *    creation; the methodology says so.
 *  - `compliance_audit_log`: every check verdict with its violations. The top
 *    rules are counted from the violations array over the window. The log is
 *    pruned on the compliance service's own retention (180 days by default), so a
 *    wider window only sees what is left.
 *
 * TEAM-LEVEL ONLY: no user, requester, approver or entity name leaves this module.
 */

import type { WeekStart } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { asOfFor, bucketSeries, num, safeTz, securityRead, type SecurityBucket, type SecurityScope } from './security.js';
import { assertReportInterval, periodBucket } from './sql-helpers.js';
import { resultRows } from '../../database/pg-result.js';

/** One bucket of the compliance trend. */
export interface ComplianceTrendPoint {
  period: string;
  /** Completed scans in the bucket. */
  scans: number;
  pass: number;
  warn: number;
  block: number;
  /** Exemptions requested in the bucket (any outcome). */
  exemptionsCreated: number;
  /** Approved exemptions in force at some point during the bucket. */
  exemptionsActive: number;
}

/** A rule, ranked by how often it was violated over the window. */
export interface TopViolatedRule {
  ruleId: string;
  ruleName: string;
  severity: string | null;
  violations: number;
  /** Distinct pipelines / plugins it was violated on. */
  entities: number;
}

export interface ComplianceTrendReport {
  window: { from: string; to: string };
  asOf: string;
  trend: ComplianceTrendPoint[];
  totals: { scans: number; pass: number; warn: number; block: number; exemptionsCreated: number };
  /** Approved exemptions in force at `asOf`. */
  activeExemptions: number;
  topRules: TopViolatedRule[];
}

const TOP_RULES_LIMIT = 10;

/** The compliance trend for a window. `bucket.interval` is allow-listed. */
export async function getComplianceTrend(scope: SecurityScope, bucket: SecurityBucket): Promise<ComplianceTrendReport> {
  assertReportInterval(bucket.interval);
  const tz = safeTz(bucket.tz);
  const weekStart: WeekStart = bucket.weekStart ?? 'monday';
  const asOf = asOfFor(scope.to, bucket.now ?? new Date());
  const { from, to } = scope;

  return securityRead(scope, async (org, tx) => {
    const trendRes = await tx.execute(sql`
      WITH b AS ${bucketSeries(bucket.interval, from, to, tz, weekStart)},
      s AS (
        SELECT ${periodBucket(bucket.interval, sql`COALESCE(cs.completed_at, cs.created_at)`, tz, weekStart)}::text AS period,
               COUNT(*)::int AS scans,
               COALESCE(SUM(cs.pass_count), 0)::int AS pass,
               COALESCE(SUM(cs.warn_count), 0)::int AS warn,
               COALESCE(SUM(cs.block_count), 0)::int AS block
        FROM compliance_scans cs
        WHERE cs.org_id ${org}
          AND cs.status = 'completed'
          AND cs.triggered_by <> 'rule-dry-run'
          AND COALESCE(cs.completed_at, cs.created_at) >= ${from}::timestamptz
          AND COALESCE(cs.completed_at, cs.created_at) < ${to}::timestamptz
        GROUP BY 1),
      c AS (
        SELECT ${periodBucket(bucket.interval, sql`ce.created_at`, tz, weekStart)}::text AS period, COUNT(*)::int AS created
        FROM compliance_exemptions ce
        WHERE ce.org_id ${org}
          AND ce.created_at >= ${from}::timestamptz AND ce.created_at < ${to}::timestamptz
        GROUP BY 1),
      a AS (
        SELECT b.period, COUNT(ce.id)::int AS active
        FROM b
        JOIN compliance_exemptions ce
          ON ce.org_id ${org}
         AND ce.status IN ('approved', 'expired')
         AND ce.created_at < LEAST(b.bucket_end, ${to}::timestamptz)
         AND (ce.expires_at IS NULL OR ce.expires_at > GREATEST(b.bucket_start, ${from}::timestamptz))
        GROUP BY b.period)
      SELECT b.period,
             COALESCE(s.scans, 0)::int AS scans, COALESCE(s.pass, 0)::int AS pass,
             COALESCE(s.warn, 0)::int AS warn, COALESCE(s.block, 0)::int AS block,
             COALESCE(c.created, 0)::int AS created, COALESCE(a.active, 0)::int AS active
      FROM b
      LEFT JOIN s ON s.period = b.period
      LEFT JOIN c ON c.period = b.period
      LEFT JOIN a ON a.period = b.period
      ORDER BY b.period`);

    const activeRes = await tx.execute(sql`
      SELECT COUNT(*)::int AS active
      FROM compliance_exemptions ce
      WHERE ce.org_id ${org}
        AND ce.status IN ('approved', 'expired')
        AND ce.created_at <= ${asOf}
        AND (ce.expires_at IS NULL OR ce.expires_at > ${asOf})`);

    const rulesRes = await tx.execute(sql`
      SELECT f->>'ruleId' AS rule_id,
             MAX(f->>'ruleName') AS rule_name,
             MAX(f->>'severity') AS severity,
             COUNT(*)::int AS violations,
             COUNT(DISTINCT a.entity_id)::int AS entities
      FROM compliance_audit_log a, jsonb_array_elements(a.violations) AS f
      WHERE a.org_id ${org}
        AND jsonb_typeof(a.violations) = 'array'
        AND a.created_at >= ${from}::timestamptz AND a.created_at < ${to}::timestamptz
        AND f->>'ruleId' IS NOT NULL
      GROUP BY f->>'ruleId'
      ORDER BY violations DESC, rule_id
      LIMIT ${TOP_RULES_LIMIT}`);

    const trend = resultRows<Record<string, unknown>>(trendRes).map((r) => ({
      period: String(r.period),
      scans: num(r.scans),
      pass: num(r.pass),
      warn: num(r.warn),
      block: num(r.block),
      exemptionsCreated: num(r.created),
      exemptionsActive: num(r.active),
    }));
    const sum = (k: keyof ComplianceTrendPoint) => trend.reduce((acc, r) => acc + (r[k] as number), 0);

    return {
      window: { from, to },
      asOf: asOf.toISOString(),
      trend,
      totals: { scans: sum('scans'), pass: sum('pass'), warn: sum('warn'), block: sum('block'), exemptionsCreated: sum('exemptionsCreated') },
      activeExemptions: num(resultRows<Record<string, unknown>>(activeRes)[0]?.active),
      topRules: resultRows<Record<string, unknown>>(rulesRes).map((r) => ({
        ruleId: String(r.rule_id),
        ruleName: String(r.rule_name ?? r.rule_id),
        severity: (r.severity as string | null) ?? null,
        violations: num(r.violations),
        entities: num(r.entities),
      })),
    };
  });
}
