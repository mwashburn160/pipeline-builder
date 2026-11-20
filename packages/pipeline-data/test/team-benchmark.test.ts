// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Team benchmarking, against a REAL Postgres with the real RLS policies.
 *
 * The promise: a team's benchmark row equals that team's own dashboard numbers.
 * So the core test reads the benchmark from the PARENT's tenant scope and then
 * reads each team's DORA + success rate the way its own dashboard does — in the
 * team's scope, for the team's org id alone — and asserts they are equal, after
 * first asserting they are not trivially empty.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { MIN_DORA_SAMPLE } from '@pipeline-builder/api-core';
import {
  computeTeamBenchmark,
  previousDashboardWindow,
  successTotals,
  type TeamBenchmarkSource,
} from '../src/api/reporting/team-benchmark.js';
import { reportingService } from '../src/api/reporting-service.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const PARENT = 'org-bench-parent';
const TEAM_A = 'org-bench-team-a';
const TEAM_B = 'org-bench-team-b';
const PIPES: Record<string, string> = { [PARENT]: randomUUID(), [TEAM_A]: randomUUID(), [TEAM_B]: randomUUID() };
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-15T23:59:59.000Z';
const BUCKET = { tz: 'America/Chicago', weekStart: 'sunday' as const };

async function seedEvent(org: string, type: 'PIPELINE' | 'STAGE', status: string, at: string, environment: string | null = null) {
  await owner((db) => db.query(
    `INSERT INTO pipeline_events
       (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name,
        started_at, completed_at, duration_ms, environment, source_event_id, created_at)
     VALUES ($1, $2, 'codepipeline', $3, $4, $5, $6, $7, $7, 1000, $8, $9, $7)`,
    [PIPES[org], org, type, status, randomUUID(), type === 'STAGE' ? 'Deploy' : null, at, environment, randomUUID()],
  ));
}

const day = (d: number, h = 12) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

beforeAll(async () => {
  tdb = await bootTenantDb();
  for (const org of [PARENT, TEAM_A, TEAM_B]) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
       VALUES ($1, $2, 'p', 'acme', $3, '{}'::jsonb, 'u1', 'u1')`,
      [PIPES[org], org, `${org}-pipe`],
    ));
  }
  // Team A: six production deploys (one failed) — enough to band.
  for (let d = 2; d <= 7; d++) await seedEvent(TEAM_A, 'STAGE', d === 4 ? 'FAILED' : 'SUCCEEDED', day(d), 'production');
  for (let d = 2; d <= 9; d++) await seedEvent(TEAM_A, 'PIPELINE', d === 3 ? 'FAILED' : 'SUCCEEDED', day(d));
  // Team B: two production deploys — below MIN_DORA_SAMPLE, so `insufficient`.
  await seedEvent(TEAM_B, 'STAGE', 'SUCCEEDED', day(3), 'production');
  await seedEvent(TEAM_B, 'STAGE', 'SUCCEEDED', day(10), 'production');
  await seedEvent(TEAM_B, 'PIPELINE', 'SUCCEEDED', day(3));
  await seedEvent(TEAM_B, 'PIPELINE', 'CANCELED', day(10));
  // The parent: one run of its own.
  await seedEvent(PARENT, 'PIPELINE', 'FAILED', day(8, 3));
  // Outside the window: must count nowhere.
  await seedEvent(TEAM_A, 'PIPELINE', 'FAILED', '2026-10-20T12:00:00Z');
  // Team A's own incident window override (its dashboard reads it).
  await owner((db) => db.query(
    'INSERT INTO dora_settings (org_id, incident_window_hours) VALUES ($1, 6)',
    [TEAM_A],
  ));
}, 120_000);

afterAll(async () => { await tdb?.close(); });

const input = {
  parentOrgId: PARENT,
  orgIds: [PARENT, TEAM_A, TEAM_B],
  names: { [TEAM_A]: 'Team A' },
  doraRange: { from: FROM, to: TO },
  eventRange: { from: FROM, to: TO },
  ...BUCKET,
};

const asParent = <T>(fn: () => Promise<T>) => asTenantContext({ orgId: PARENT }, fn);

describe('computeTeamBenchmark', () => {
  it('gives each team the numbers its own dashboard shows', async () => {
    const bench = await asParent(() => computeTeamBenchmark(reportingService, input));
    expect(bench.rows.map((r) => [r.orgId, r.role, r.state])).toEqual([
      [PARENT, 'parent', 'ok'], [TEAM_A, 'team', 'ok'], [TEAM_B, 'team', 'ok'],
    ]);
    expect(bench.rows[1].name).toBe('Team A');
    expect(bench.rows[2].name).toBeNull();

    for (const row of bench.rows) {
      // The team's own dashboard: its scope, its org id alone, its incident window.
      const own = await asTenantContext({ orgId: row.orgId }, async () => {
        const settings = await reportingService.getReportingSettings(row.orgId);
        const dora = await reportingService.getDoraMetrics(row.orgId, FROM, TO, undefined, {
          incidentWindowHours: settings.incidentWindowHours ?? undefined,
        });
        const timeline = await reportingService.getSuccessRate(row.orgId, 'week', FROM, TO, undefined, BUCKET);
        return { dora, timeline };
      });
      const env = own.dora.environments.find((e) => e.environment === own.dora.headline) ?? own.dora.environments[0];
      expect(row.environment).toBe(env?.environment ?? null);
      if (env) {
        expect(row.deploymentFrequency).toEqual({
          value: { deployments: env.deploymentFrequency.deployments, perDay: env.deploymentFrequency.perDay },
          level: env.deploymentFrequency.level,
          n: env.deploymentFrequency.n,
        });
        expect(row.changeFailureRate).toEqual({
          value: { rate: env.changeFailureRate.rate, attempts: env.changeFailureRate.attempts },
          level: env.changeFailureRate.level,
          n: env.changeFailureRate.n,
        });
        expect(row.leadTime).toEqual({ value: { medianSeconds: env.leadTime.medianSeconds }, level: env.leadTime.level, n: env.leadTime.n });
      }
      expect(row.timeToRestore).toEqual({
        value: { medianSeconds: own.dora.meanTimeToRestore.medianSeconds },
        level: own.dora.meanTimeToRestore.level,
        n: own.dora.meanTimeToRestore.n,
      });
      expect(row.successRate).toEqual(successTotals(own.timeline));
    }

    // Not trivially equal: the seeded figures are really there, per team.
    const [parent, a, b] = bench.rows;
    expect(a.deploymentFrequency?.value.deployments).toBe(5);
    expect(a.changeFailureRate?.value.attempts).toBe(6);
    expect(a.successRate).toEqual({ pct: 87.5, runs: 8, succeeded: 7, failed: 1, canceled: 0 });
    expect(b.successRate).toEqual({ pct: 50, runs: 2, succeeded: 1, failed: 0, canceled: 1 });
    // The parent row is the parent's OWN figures, not the rollup.
    expect(parent.successRate).toEqual({ pct: 0, runs: 1, succeeded: 0, failed: 1, canceled: 0 });
    expect(parent.deploymentFrequency).toBeNull();
  });

  it('applies the MIN_DORA_SAMPLE rule per team, with n', async () => {
    const bench = await asParent(() => computeTeamBenchmark(reportingService, input));
    const a = bench.rows.find((r) => r.orgId === TEAM_A)!;
    const b = bench.rows.find((r) => r.orgId === TEAM_B)!;
    expect(a.deploymentFrequency!.n).toBeGreaterThanOrEqual(MIN_DORA_SAMPLE);
    expect(a.deploymentFrequency!.level).not.toBe('insufficient');
    expect(b.deploymentFrequency).toEqual(expect.objectContaining({ level: 'insufficient', n: 2 }));
  });

  it('reads each team in its own tenant scope, not the parent\'s', async () => {
    const scopes: string[] = [];
    const spy: TeamBenchmarkSource = {
      getReportingSettings: async (orgId) => {
        const { getTenantContext } = await import('../src/database/tenancy.js');
        scopes.push(`${orgId}:${getTenantContext()?.orgId}`);
        return reportingService.getReportingSettings(orgId);
      },
      getDoraMetrics: (...a) => reportingService.getDoraMetrics(...a),
      getSuccessRate: (...a) => reportingService.getSuccessRate(...a),
    };
    await asParent(() => computeTeamBenchmark(spy, { ...input, concurrency: 1 }));
    expect(scopes).toEqual([`${PARENT}:${PARENT}`, `${TEAM_A}:${TEAM_A}`, `${TEAM_B}:${TEAM_B}`]);
  });

  it('isolates a team whose read fails and keeps the others', async () => {
    const flaky: TeamBenchmarkSource = {
      getReportingSettings: (o) => reportingService.getReportingSettings(o),
      getDoraMetrics: (orgId, ...rest) => (orgId === TEAM_B ? Promise.reject(new Error('boom')) : reportingService.getDoraMetrics(orgId, ...rest)),
      getSuccessRate: (...a) => reportingService.getSuccessRate(...a),
    };
    const bench = await asParent(() => computeTeamBenchmark(flaky, input));
    expect(bench.rows.map((r) => r.state)).toEqual(['ok', 'ok', 'failed']);
    expect(bench.rows[2].successRate).toBeNull();
  });

  it('always includes the parent first and reads a duplicated id once', async () => {
    const bench = await asParent(() => computeTeamBenchmark(reportingService, { ...input, orgIds: [TEAM_A, TEAM_A] }));
    expect(bench.rows.map((r) => r.orgId)).toEqual([PARENT, TEAM_A]);
  });
});

describe('successTotals', () => {
  it('sums the buckets and rounds to one decimal', () => {
    expect(successTotals([
      { period: 'a', succeeded: 2, failed: 1, canceled: 0, success_pct: 66.7 },
      { period: 'b', succeeded: 0, failed: 0, canceled: 0, success_pct: 0 },
    ])).toEqual({ pct: 66.7, runs: 3, succeeded: 2, failed: 1, canceled: 0 });
    expect(successTotals([])).toEqual({ pct: null, runs: 0, succeeded: 0, failed: 0, canceled: 0 });
  });
});

describe('previousDashboardWindow', () => {
  it('is the equal-length window ending just before from (closed windows never share an instant)', () => {
    expect(previousDashboardWindow('2026-11-11T00:00:00.000Z', '2026-11-21T00:00:00.000Z')).toEqual({
      from: '2026-10-31T23:59:59.999Z',
      to: '2026-11-10T23:59:59.999Z',
    });
  });

  it('is null for an unusable window', () => {
    expect(previousDashboardWindow('nope', '2026-11-21')).toBeNull();
    expect(previousDashboardWindow('2026-11-21', '2026-11-01')).toBeNull();
  });
});
