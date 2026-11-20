// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The advanced security reports — vulnerability exposure / time to fix, and the
 * compliance trend — against a REAL Postgres (the init script, the application
 * role, FORCE RLS), through the module functions the dashboard route and the
 * stakeholder section both call.
 *
 * Pinned judgements:
 *  - a declared + deployed pair is ONE exposure, not two findings;
 *  - an exposure is fixed only when every row closed and one closed as `fixed`
 *    (a deleted pipeline was not remediated);
 *  - point-in-time figures are taken at the END of the range;
 *  - buckets honour the report timezone and week start, and are zero-filled;
 *  - the stakeholder section returns exactly what the dashboard read returns;
 *  - nothing per-person leaves the module;
 *  - a team's rows stay out of a single-org read and come in on a rollup.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { getComplianceTrend } from '../src/api/reporting/compliance-trend.js';
import { getVulnerabilityExposure, type SecurityScope } from '../src/api/reporting/security.js';
import { composeSnapshot } from '../src/api/reporting/stakeholder/compose.js';
import { resolvePeriod } from '../src/api/reporting/stakeholder/period.js';
import { getReportSection, type SectionDataSource } from '../src/api/reporting/stakeholder/sections.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-sec';
const TEAM = 'org-sec-team';
const PIPE_A = randomUUID();
const PIPE_B = randomUUID();
const PIPE_TEAM = randomUUID();
const PIPE_GONE = randomUUID();
const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';
/** Well after the window, so the window's end is the as-of moment. */
const NOW = new Date('2026-11-01T00:00:00Z');
const SCOPE: SecurityScope = { orgId: ORG, from: FROM, to: TO };
const asOrg = <T>(fn: () => Promise<T>, orgId = ORG) => asTenantContext({ orgId }, fn);

const vulns = (scope: SecurityScope = SCOPE, bucket: Record<string, unknown> = {}) =>
  asOrg(() => getVulnerabilityExposure(scope, { interval: 'week', tz: 'UTC', now: NOW, ...bucket }));
const compliance = (scope: SecurityScope = SCOPE, bucket: Record<string, unknown> = {}) =>
  asOrg(() => getComplianceTrend(scope, { interval: 'week', tz: 'UTC', now: NOW, ...bucket }));

let RULE_A = '';
let RULE_B = '';

beforeAll(async () => {
  tdb = await bootTenantDb();
  for (const [id, org, name, deleted] of [
    [PIPE_A, ORG, 'web-deploy', null],
    [PIPE_B, ORG, 'api-deploy', null],
    [PIPE_TEAM, TEAM, 'mobile-deploy', null],
    [PIPE_GONE, ORG, 'old-deploy', '2026-09-02T00:00:00Z'],
  ] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by, deleted_at)
       VALUES ($1, $2, $3, 'acme', $3, '{}'::jsonb, 'u1', 'u1', $4)`,
      [id, org, name, deleted],
    ));
  }
  const rule = async (org: string, name: string) => {
    const r = await owner((db) => db.query<{ id: string }>(
      'INSERT INTO compliance_rules (org_id, name, target) VALUES ($1, $2, \'pipeline\') RETURNING id', [org, name],
    ));
    return r.rows[0]!.id;
  };
  RULE_A = await rule(ORG, 'require-approval');
  RULE_B = await rule(ORG, 'pin-images');
}, 120_000);

afterAll(async () => { await tdb?.close(); });

beforeEach(async () => {
  await owner((db) => db.exec(`
    DELETE FROM plugin_vuln_exposure;
    DELETE FROM pipeline_security_reports;
    DELETE FROM compliance_scans;
    DELETE FROM compliance_exemptions;
    DELETE FROM compliance_audit_log;
  `));
});

interface ExposureSeed {
  orgId?: string;
  pipelineId?: string;
  plugin?: string;
  version?: string;
  source?: 'declared' | 'deployed';
  critical?: number;
  high?: number;
  findings?: Array<Record<string, unknown>>;
  flaggedAt?: string;
  fixedAt?: string | null;
  triage?: string;
  acceptedUntil?: string | null;
}

async function seedExposure(s: ExposureSeed = {}): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO plugin_vuln_exposure
       (id, org_id, pipeline_id, plugin_name, plugin_version, source, critical_count, high_count,
        top_findings, flagged_at, fixed_at, triage_state, accepted_until, triaged_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,'someone@example.com')`,
    [
      randomUUID(), s.orgId ?? ORG, s.pipelineId ?? PIPE_A, s.plugin ?? 'node', s.version ?? '1.0.0',
      s.source ?? 'deployed', s.critical ?? 1, s.high ?? 0, JSON.stringify(s.findings ?? []),
      s.flaggedAt ?? '2026-09-02T12:00:00Z', s.fixedAt ?? null, s.triage ?? 'open', s.acceptedUntil ?? null,
    ],
  ));
}

describe('vulnerability exposure', () => {
  it('returns an empty, zero-filled report for an org with no data', async () => {
    const r = await vulns();
    expect(r.open).toEqual({ exposures: 0, pipelines: 0, critical: 0, high: 0, medium: 0, low: 0, kev: 0 });
    expect(r.timeToFix).toEqual({ n: 0, medianSeconds: null, p90Seconds: null });
    expect(r.expiringAcceptances).toEqual({ count: 0, items: [] });
    // September 2026 in Monday weeks: Aug 31, Sep 7, 14, 21, 28.
    expect(r.trend.map((t) => t.period)).toEqual([
      '2026-08-31 00:00:00', '2026-09-07 00:00:00', '2026-09-14 00:00:00', '2026-09-21 00:00:00', '2026-09-28 00:00:00',
    ]);
    expect(r.trend.every((t) => t.new === 0 && t.fixed === 0)).toBe(true);
  });

  it('counts a declared + deployed pair as one exposure', async () => {
    await seedExposure({ source: 'declared', critical: 2, high: 3 });
    await seedExposure({ source: 'deployed', critical: 2, high: 3 });
    const r = await vulns();
    expect(r.open).toMatchObject({ exposures: 1, pipelines: 1, critical: 2, high: 3 });
    expect(r.totals.new).toBe(1);
  });

  it('does not call it fixed while the deployed image still runs it', async () => {
    await seedExposure({ source: 'declared', fixedAt: '2026-09-10T12:00:00Z', triage: 'fixed' });
    await seedExposure({ source: 'deployed' });
    const r = await vulns();
    expect(r.totals.fixed).toBe(0);
    expect(r.open.exposures).toBe(1);
  });

  it('measures median and p90 time to fix over exposures fixed in the window', async () => {
    // 1, 2, 3, ... 10 days to fix.
    for (let d = 1; d <= 10; d++) {
      const flagged = new Date(Date.UTC(2026, 8, 5, 0, 0, 0));
      await seedExposure({
        plugin: `p${d}`,
        flaggedAt: flagged.toISOString(),
        fixedAt: new Date(flagged.getTime() + d * 86_400_000).toISOString(),
        triage: 'fixed',
      });
    }
    // Fixed after the window: not in the sample.
    await seedExposure({ plugin: 'late', flaggedAt: '2026-09-05T00:00:00Z', fixedAt: '2026-10-05T00:00:00Z', triage: 'fixed' });
    // Removed (pipeline deleted): not a fix.
    await seedExposure({ plugin: 'gone', flaggedAt: '2026-09-05T00:00:00Z', fixedAt: '2026-09-06T00:00:00Z', triage: 'removed' });
    const r = await vulns();
    expect(r.timeToFix.n).toBe(10);
    expect(r.timeToFix.medianSeconds).toBe(5.5 * 86_400);
    expect(r.timeToFix.p90Seconds).toBe(Math.round(9.1 * 86_400));
    expect(r.totals.fixed).toBe(10);
    // The late fix was still open at the end of September.
    expect(r.open.exposures).toBe(1);
  });

  it('takes open findings at the end of the range, and applies triage', async () => {
    await seedExposure({ plugin: 'open' });
    await seedExposure({ plugin: 'fp', triage: 'false_positive' });
    await seedExposure({ plugin: 'accepted', triage: 'accepted', acceptedUntil: '2026-12-01T00:00:00Z' });
    // An acceptance that lapsed before the end of the range is open again.
    await seedExposure({ plugin: 'lapsed', triage: 'accepted', acceptedUntil: '2026-09-15T00:00:00Z' });
    // Flagged after the range: not open at its end.
    await seedExposure({ plugin: 'later', flaggedAt: '2026-10-10T00:00:00Z' });
    const r = await vulns();
    expect(r.open.exposures).toBe(2);
    // The false positive is not "new" either.
    expect(r.totals.new).toBe(3);
  });

  it('counts known-exploited findings among the open ones', async () => {
    await seedExposure({
      source: 'declared',
      findings: [{ id: 'CVE-1', kev: true }, { id: 'CVE-2', kev: false }, { id: 'CVE-3' }],
    });
    // The same finding on the deployed row of the same exposure is not counted twice.
    await seedExposure({ source: 'deployed', findings: [{ id: 'CVE-1', kev: true }] });
    await seedExposure({ pipelineId: PIPE_B, findings: [{ id: 'CVE-1', kev: true }] });
    await seedExposure({ plugin: 'fp', triage: 'false_positive', findings: [{ id: 'CVE-9', kev: true }] });
    expect((await vulns()).open.kev).toBe(2);
  });

  it('buckets new and fixed in the report timezone and week start', async () => {
    // Sunday 2026-09-06 03:00Z is still Saturday evening in Chicago.
    await seedExposure({ plugin: 'a', flaggedAt: '2026-09-06T03:00:00Z' });
    await seedExposure({ plugin: 'b', flaggedAt: '2026-09-06T18:00:00Z', fixedAt: '2026-09-08T12:00:00Z', triage: 'fixed' });
    const utc = await vulns(SCOPE, { tz: 'UTC', weekStart: 'sunday' });
    expect(utc.trend.find((t) => t.period === '2026-09-06 00:00:00')).toMatchObject({ new: 2, fixed: 1 });
    const chi = await vulns(
      { orgId: ORG, from: '2026-09-01T05:00:00Z', to: '2026-10-01T05:00:00Z' },
      { tz: 'America/Chicago', weekStart: 'sunday' },
    );
    expect(chi.trend.find((t) => t.period === '2026-08-30 00:00:00')).toMatchObject({ new: 1 });
    expect(chi.trend.find((t) => t.period === '2026-09-06 00:00:00')).toMatchObject({ new: 1, fixed: 1 });
  });

  it('lists acceptances that lapse within 30 days, without who accepted them', async () => {
    await seedExposure({ plugin: 'soon', triage: 'accepted', acceptedUntil: '2026-10-11T00:00:00Z' });
    await seedExposure({ plugin: 'far', triage: 'accepted', acceptedUntil: '2026-12-31T00:00:00Z' });
    const r = await vulns();
    expect(r.expiringAcceptances.count).toBe(1);
    expect(r.expiringAcceptances.items[0]).toEqual({
      pipelineId: PIPE_A,
      pipelineName: 'web-deploy',
      plugin: 'soon',
      version: '1.0.0',
      acceptedUntil: '2026-10-11T00:00:00.000Z',
      daysLeft: 10,
    });
    expect(JSON.stringify(r)).not.toContain('someone@example.com');
  });

  it('sums the latest scanner reports of pipelines still in use', async () => {
    const report = (pipelineId: string, tool: string, c: number[]) => owner((db) => db.query(
      `INSERT INTO pipeline_security_reports
         (id, org_id, pipeline_id, tool, format, critical_count, high_count, medium_count, low_count, kev_count, submitted_by)
       VALUES ($1, $2, $3, $4, 'sarif', $5, $6, $7, $8, $9, 'someone@example.com')`,
      [randomUUID(), ORG, pipelineId, tool, ...c],
    ));
    await report(PIPE_A, 'trivy', [1, 2, 3, 4, 1]);
    await report(PIPE_A, 'grype', [0, 1, 0, 0, 0]);
    await report(PIPE_B, 'trivy', [2, 0, 0, 1, 2]);
    await report(PIPE_GONE, 'trivy', [9, 9, 9, 9, 9]);
    const r = await vulns();
    expect(r.scanners).toEqual({ reports: 3, pipelines: 2, critical: 3, high: 3, medium: 3, low: 5, kev: 3 });
  });

  it('keeps a team out of a single-org read and brings it in on a rollup', async () => {
    await seedExposure({ orgId: TEAM, pipelineId: PIPE_TEAM });
    expect((await vulns()).open.exposures).toBe(0);
    expect((await vulns({ ...SCOPE, orgIds: [ORG, TEAM] })).open.exposures).toBe(1);
  });
});

async function seedScan(over: { at?: string; pass?: number; warn?: number; block?: number; status?: string; trigger?: string; orgId?: string } = {}) {
  await owner((db) => db.query(
    `INSERT INTO compliance_scans (org_id, target, status, triggered_by, user_id, pass_count, warn_count, block_count, created_at, completed_at)
     VALUES ($1, 'all', $2, $3, 'someone', $4, $5, $6, $7, $7)`,
    [over.orgId ?? ORG, over.status ?? 'completed', over.trigger ?? 'scheduled', over.pass ?? 0, over.warn ?? 0, over.block ?? 0, over.at ?? '2026-09-02T12:00:00Z'],
  ));
}

async function seedExemption(over: { ruleId?: string; status?: string; createdAt?: string; expiresAt?: string | null } = {}) {
  await owner((db) => db.query(
    `INSERT INTO compliance_exemptions (org_id, rule_id, entity_type, entity_id, reason, status, expires_at, created_by, updated_by, created_at)
     VALUES ($1, $2, 'pipeline', $3, 'because', $4, $5, 'someone', 'someone', $6)`,
    [ORG, over.ruleId ?? RULE_A, randomUUID(), over.status ?? 'approved', over.expiresAt ?? null, over.createdAt ?? '2026-09-02T12:00:00Z'],
  ));
}

async function seedCheck(violations: Array<Record<string, unknown>>, over: { at?: string; result?: string; entityId?: string } = {}) {
  await owner((db) => db.query(
    `INSERT INTO compliance_audit_log (org_id, user_id, target, action, entity_id, entity_name, result, violations, rule_count, created_at)
     VALUES ($1, 'someone', 'pipeline', 'update', $2, 'web-deploy', $3, $4::jsonb, 2, $5)`,
    [ORG, over.entityId ?? 'e1', over.result ?? 'block', JSON.stringify(violations), over.at ?? '2026-09-03T12:00:00Z'],
  ));
}

describe('compliance trend', () => {
  it('is zero-filled and empty for an org with no data', async () => {
    const r = await compliance();
    expect(r.trend).toHaveLength(5);
    expect(r.totals).toEqual({ scans: 0, pass: 0, warn: 0, block: 0, exemptionsCreated: 0 });
    expect(r.topRules).toEqual([]);
    expect(r.activeExemptions).toBe(0);
  });

  it('sums completed scans per bucket, leaving out dry runs and unfinished scans', async () => {
    await seedScan({ at: '2026-09-02T12:00:00Z', pass: 5, warn: 1, block: 2 });
    await seedScan({ at: '2026-09-03T12:00:00Z', pass: 1 });
    await seedScan({ at: '2026-09-09T12:00:00Z', block: 4 });
    await seedScan({ trigger: 'rule-dry-run', block: 100 });
    await seedScan({ status: 'running', block: 100 });
    await seedScan({ at: '2026-10-02T12:00:00Z', block: 100 });
    await seedScan({ orgId: TEAM, block: 100 });
    const r = await compliance();
    expect(r.trend[0]).toMatchObject({ period: '2026-08-31 00:00:00', scans: 2, pass: 6, warn: 1, block: 2 });
    expect(r.trend[1]).toMatchObject({ period: '2026-09-07 00:00:00', scans: 1, block: 4 });
    expect(r.totals).toMatchObject({ scans: 3, pass: 6, warn: 1, block: 6 });
  });

  it('counts exemptions created and in force per bucket', async () => {
    // Created in week 1, in force throughout.
    await seedExemption({ createdAt: '2026-09-02T12:00:00Z' });
    // Created in week 2, expired during week 3.
    await seedExemption({ createdAt: '2026-09-08T12:00:00Z', expiresAt: '2026-09-16T00:00:00Z', status: 'expired' });
    // Rejected: created, never in force.
    await seedExemption({ createdAt: '2026-09-08T12:00:00Z', status: 'rejected' });
    const r = await compliance();
    expect(r.trend.map((t) => t.exemptionsCreated)).toEqual([1, 2, 0, 0, 0]);
    expect(r.trend.map((t) => t.exemptionsActive)).toEqual([1, 2, 2, 1, 1]);
    expect(r.totals.exemptionsCreated).toBe(3);
    expect(r.activeExemptions).toBe(1);
  });

  it('ranks the most-violated rules over the window, with no per-person data', async () => {
    const a = { ruleId: RULE_A, ruleName: 'require-approval', severity: 'error' };
    const b = { ruleId: RULE_B, ruleName: 'pin-images', severity: 'warning' };
    await seedCheck([a, b], { entityId: 'e1' });
    await seedCheck([a], { entityId: 'e2' });
    await seedCheck([a], { entityId: 'e2' });
    await seedCheck([b], { at: '2026-10-05T00:00:00Z' });
    const r = await compliance();
    expect(r.topRules).toEqual([
      { ruleId: RULE_A, ruleName: 'require-approval', severity: 'error', violations: 3, entities: 2 },
      { ruleId: RULE_B, ruleName: 'pin-images', severity: 'warning', violations: 1, entities: 1 },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/someone|web-deploy/);
  });
});

describe('the stakeholder sections', () => {
  it('are advanced_reporting sections, locked without it', async () => {
    expect(getReportSection('vulnerability_exposure')?.requiresFeature).toBe('advanced_reporting');
    expect(getReportSection('compliance_trend')?.requiresFeature).toBe('advanced_reporting');
    const period = resolvePeriod('monthly', 'UTC', 'monday', NOW);
    const snap = await composeSnapshot(['vulnerability_exposure', 'compliance_trend'], {
      source: {} as SectionDataSource, period, timezone: 'UTC', weekStart: 'monday', orgId: ORG, features: [], now: NOW,
    });
    expect(snap.sections.map((s) => s.state)).toEqual(['locked', 'locked']);
  });

  /** The same range and timezone must give the same numbers on the dashboard and in the report. */
  it('return exactly what the dashboard read returns for the same range and timezone', async () => {
    await seedExposure({ plugin: 'a', flaggedAt: '2026-10-04T03:00:00Z', critical: 3, findings: [{ id: 'CVE-1', kev: true }] });
    await seedExposure({ plugin: 'b', flaggedAt: '2026-10-06T03:00:00Z', fixedAt: '2026-10-20T00:00:00Z', triage: 'fixed' });
    await seedExposure({ plugin: 'c', triage: 'accepted', acceptedUntil: '2026-11-10T00:00:00Z' });
    await seedScan({ at: '2026-10-04T03:00:00Z', pass: 2, block: 1 });
    await seedExemption({ createdAt: '2026-10-07T00:00:00Z' });
    await seedCheck([{ ruleId: RULE_A, ruleName: 'require-approval', severity: 'error' }], { at: '2026-10-08T00:00:00Z' });

    const tz = 'America/Chicago';
    // October 2026 in Chicago, Sunday weeks.
    const at = new Date('2026-11-05T12:00:00Z');
    const period = resolvePeriod('monthly', tz, 'sunday', at);
    expect(period.start.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    const snap = await asOrg(() => composeSnapshot(['vulnerability_exposure', 'compliance_trend'], {
      source: {} as SectionDataSource,
      period,
      timezone: tz,
      weekStart: 'sunday',
      orgId: ORG,
      features: ['advanced_reporting'],
      now: at,
    }));
    const scope = { orgId: ORG, from: period.start.toISOString(), to: period.end.toISOString() };
    const bucket = { interval: 'week', tz, weekStart: 'sunday' as const };
    const dashVulns = await asOrg(() => getVulnerabilityExposure(scope, bucket));
    const dashCompliance = await asOrg(() => getComplianceTrend(scope, bucket));

    const [v, c] = snap.sections;
    expect(v?.state).toBe('ok');
    expect(v?.current).toEqual(dashVulns);
    expect(c?.current).toEqual(dashCompliance);
    // And they carry real numbers, so the equality above is not two empties.
    expect(dashVulns.open.critical).toBe(3);
    expect(dashVulns.totals).toEqual({ new: 2, fixed: 1 });
    expect(dashVulns.expiringAcceptances.count).toBe(1);
    expect(dashCompliance.totals.block).toBe(1);
    // The report's single headline number.
    expect(v?.headline).toEqual({ label: 'Open critical findings', value: 3 });
    expect(c?.headline).toEqual({ label: 'Blocked checks', value: 1 });
  });
});
