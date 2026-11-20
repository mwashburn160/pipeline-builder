// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Insights tab's sections, against a REAL Postgres.
 *
 * The one promise this module makes is that the tab and a stakeholder report over
 * the same window and timezone show IDENTICAL numbers. So the core test composes a
 * real report snapshot and computes the Insights over the same window — both through
 * the real `reportingService` reading the daily rollups under RLS — and asserts the
 * sections are equal, after first asserting they are not trivially empty (two empty
 * arrays are equal and prove nothing).
 *
 * The window is a Chicago month on purpose: the dashboard sends `YYYY-MM-DD`, and
 * read as UTC that would start five hours before the report's local midnight.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  computeInsights,
  insightBound,
  INSIGHT_SECTION_IDS,
  isInsightSectionId,
  previousWindowOf,
} from '../src/api/reporting/insights.js';
import { composeSnapshot } from '../src/api/reporting/stakeholder/compose.js';
import { resolvePeriodByLabel } from '../src/api/reporting/stakeholder/period.js';
import type { SectionDataSource } from '../src/api/reporting/stakeholder/sections.js';
import { reportingService } from '../src/api/reporting-service.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-insights';
const TZ = 'America/Chicago';
const PIPE_A = randomUUID();
const PIPE_B = randomUUID();
const asOrg = <T>(fn: () => Promise<T>) => asTenantContext({ orgId: ORG }, fn);

async function seedRollup(pipelineId: string, day: string, over: { runs?: number; succeeded?: number; failed?: number; categories?: Record<string, number>; buildSeconds?: number } = {}) {
  await owner((db) => db.query(
    `INSERT INTO execution_daily_rollups
       (org_id, day, pipeline_id, stage_name, runs, succeeded, failed,
        failures_by_category, p50_ms, p90_ms, p95_ms, build_seconds)
     VALUES ($1,$2,$3,'',$4,$5,$6,$7::jsonb,1000,1500,2000,$8)`,
    [ORG, day, pipelineId, over.runs ?? 10, over.succeeded ?? 10, over.failed ?? 0,
      JSON.stringify(over.categories ?? {}), over.buildSeconds ?? 100],
  ));
}

async function seedDeploy(commitSha: string, environment: string, deployedAt: string) {
  await owner((db) => db.query(
    `INSERT INTO dora_deployments (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, commit_sha)
     VALUES ($1,$2,$3,$4,$5,true,$6)`,
    [ORG, randomUUID(), environment, PIPE_A, deployedAt, commitSha],
  ));
}

beforeAll(async () => {
  tdb = await bootTenantDb();
  for (const [id, project, name, source] of [[PIPE_A, 'web', 'web-deploy', 'template'], [PIPE_B, 'api', 'api-deploy', 'manual']] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, creation_source, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', $4, $5, '{}'::jsonb, 'u1', 'u1')`,
      [id, ORG, project, name, source],
    ));
  }
  // September (the reported month), August (the comparison month) and a row on
  // Oct 1 that only a UTC-read window would wrongly pick up.
  await seedRollup(PIPE_A, '2026-09-05T00:00:00Z', { runs: 10, succeeded: 4, failed: 6, categories: { unit_test: 4, infrastructure: 2 }, buildSeconds: 600 });
  await seedRollup(PIPE_B, '2026-09-12T00:00:00Z', { runs: 8, succeeded: 7, failed: 1, categories: { build: 1 }, buildSeconds: 200 });
  await seedRollup(PIPE_A, '2026-08-20T00:00:00Z', { runs: 5, succeeded: 3, failed: 2, categories: { unit_test: 2 }, buildSeconds: 50 });
  await seedRollup(PIPE_B, '2026-10-01T00:00:00Z', { runs: 3, succeeded: 0, failed: 3, categories: { build: 3 }, buildSeconds: 999 });
  await seedDeploy('a'.repeat(40), 'staging', '2026-09-10T15:00:00Z');
  await seedDeploy('b'.repeat(40), 'staging', '2026-09-11T15:00:00Z');
  await seedDeploy('b'.repeat(40), 'production', '2026-09-11T18:00:00Z');
  // Sept 1 03:00Z is still Aug 31 in Chicago: outside the report's month, inside a
  // UTC-read one — the bound a naive reading of the dashboard's days gets wrong.
  await seedDeploy('c'.repeat(40), 'staging', '2026-09-01T03:00:00Z');
  await owner((db) => db.query(
    `INSERT INTO pipeline_plugin_resolution
       (org_id, pipeline_id, stage_name, step_name, plugin_publisher, plugin_name,
        resolved_version, latest_version, version_gap, within_policy)
     VALUES ($1,$2,'Build','scan','acme','trivy','1.0.0','2.0.0','major',true)`,
    [ORG, PIPE_A],
  ));
}, 120_000);

afterAll(async () => { await tdb?.close(); });

describe('the Insights tab and a stakeholder report over the same window', () => {
  const period = resolvePeriodByLabel('2026-09', 'monthly', TZ, 'monday')!;

  const both = async () => {
    const snapshot = await asOrg(() => composeSnapshot(INSIGHT_SECTION_IDS, {
      source: reportingService as unknown as SectionDataSource,
      period,
      timezone: TZ,
      weekStart: 'monday',
      orgId: ORG,
      features: [],
    }));
    const insights = await asOrg(() => computeInsights(reportingService as unknown as SectionDataSource, {
      orgId: ORG,
      // What the dashboard sends for "Sept 1 – Oct 1".
      from: insightBound('2026-09-01', TZ),
      to: insightBound('2026-10-01', TZ),
      tz: TZ,
      weekStart: 'monday',
      previous: { from: period.prevStart.toISOString(), to: period.prevEnd.toISOString() },
    }));
    const reportOf = (id: string) => snapshot.sections.find((s) => s.id === id);
    const insightOf = (id: string) => insights.sections.find((s) => s.id === id);
    return { snapshot, insights, reportOf, insightOf };
  };

  it('reads the dashboard days as the report period\'s local midnights', async () => {
    const { insights } = await both();
    expect(insights.window.from).toBe(period.start.toISOString());
    expect(insights.window.to).toBe(period.end.toISOString());
  });

  it('shows the same failure analysis (with the same trend) as the report', async () => {
    const { reportOf, insightOf } = await both();
    const report = reportOf('failure_analysis');
    expect(report?.state).toBe('ok');
    // Not trivially equal: September's 7 failures, and the change against August.
    expect(report?.current).toMatchObject({ total: 7, actionableTotal: expect.any(Number) });
    const testFailures = (report?.current as { categories: Array<{ category: string; change: number | null }> })
      .categories.find((c) => c.category === 'unit_test');
    expect(testFailures?.change).toBe(2);
    expect(insightOf('failure_analysis')).toEqual({ id: 'failure_analysis', title: report?.title, state: 'ok', data: report?.current });
  });

  it('shows the same resource consumption as the report', async () => {
    const { reportOf, insightOf } = await both();
    const report = reportOf('resource_consumption');
    // The Oct 1 row is outside a Chicago September.
    expect(report?.current).toMatchObject({ totalBuildSeconds: 800 });
    expect(insightOf('resource_consumption')?.data).toEqual(report?.current);
  });

  it('shows the same promotion, outdated plugins, adoption and needs-attention as the report', async () => {
    const { reportOf, insightOf } = await both();
    expect(reportOf('promotion')?.current).toMatchObject({ stuckCount: 1 });
    expect(reportOf('outdated_plugins')?.current).toMatchObject({ majorBehind: 1 });
    expect(reportOf('adoption')?.current).toMatchObject({ totalPipelines: 2, activePipelines: 2 });
    expect((reportOf('needs_attention')?.current as { pipelinesEvaluated: number }).pipelinesEvaluated).toBe(2);
    for (const id of ['promotion', 'outdated_plugins', 'adoption', 'needs_attention']) {
      expect(insightOf(id)).toMatchObject({ state: 'ok' });
      expect(insightOf(id)?.data).toEqual(reportOf(id)?.current);
    }
  });
});

describe('computeInsights', () => {
  it('isolates a failing section to its own card', async () => {
    const source = {
      getFailureAnalysis: () => Promise.reject(new Error('boom')),
      getResourceConsumption: () => Promise.resolve({ pipelines: [], totalBuildSeconds: 0 }),
    } as unknown as SectionDataSource;
    const r = await computeInsights(source, {
      orgId: ORG, from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z', tz: 'UTC', weekStart: 'monday',
    }, ['failure_analysis', 'resource_consumption']);
    expect(r.sections).toEqual([
      { id: 'failure_analysis', title: 'What is breaking', state: 'failed' },
      { id: 'resource_consumption', title: 'Where the build time went', state: 'ok', data: { pipelines: [], totalBuildSeconds: 0 } },
    ]);
    // The default comparison is the equal-length window before.
    expect(r.window.previous).toEqual({ from: '2026-08-25T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' });
  });

  it('passes the window, timezone and previous window to the section', async () => {
    const calls: unknown[] = [];
    const source = {
      getFailureAnalysis: (...a: unknown[]) => { calls.push(a); return Promise.resolve({}); },
    } as unknown as SectionDataSource;
    await computeInsights(source, {
      orgId: ORG, orgIds: [ORG, 'team-1'], from: 'F', to: 'T', tz: TZ, weekStart: 'sunday', previous: { from: 'PF', to: 'PT' },
    }, ['failure_analysis']);
    expect(calls).toEqual([[{ orgId: ORG, orgIds: [ORG, 'team-1'], from: 'F', to: 'T', tz: TZ }, { from: 'PF', to: 'PT' }]]);
  });

  it('never includes the Security tab\'s sections', () => {
    expect(INSIGHT_SECTION_IDS).not.toContain('plugin_vulnerabilities');
    expect(INSIGHT_SECTION_IDS).not.toContain('compliance_posture');
    expect(isInsightSectionId('adoption')).toBe(true);
    expect(isInsightSectionId('plugin_vulnerabilities')).toBe(false);
  });
});

describe('insightBound / previousWindowOf', () => {
  it('reads a date-only bound as local midnight in the zone', () => {
    expect(insightBound('2026-09-01', TZ)).toBe('2026-09-01T05:00:00.000Z');
    expect(insightBound('2026-12-01', TZ)).toBe('2026-12-01T06:00:00.000Z');
    expect(insightBound('2026-09-01', 'UTC')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('normalizes a full timestamp as-is', () => {
    expect(insightBound('2026-09-01T12:30:00+02:00', TZ)).toBe('2026-09-01T10:30:00.000Z');
  });

  it('gives the equal-length window ending at from', () => {
    expect(previousWindowOf('2026-09-08T00:00:00.000Z', '2026-09-15T00:00:00.000Z'))
      .toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' });
  });
});
