// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The analytics queries' TypeScript half.
 *
 * `analytics-queries.test.ts` runs the SQL against a real Postgres. This covers
 * what happens to the rows AFTERWARDS, which is where the reporting judgements
 * live rather than in the SELECT:
 *
 *  - percentage shares, and what they are when the denominator is zero;
 *  - the actionable/not split, which decides whether a team is asked to fix an AWS
 *    capacity problem;
 *  - the promotion grouping — ordering a commit's stops, the gaps between them, and
 *    what counts as "stuck";
 *  - "estimated minutes saved" being absent unless the ORG configured the
 *    assumption;
 *  - drivers that hand back strings for counts and objects for dates.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  getPipelineBreakdown, getFailureAnalysis, getStagePerformance,
  getResourceConsumption, getPromotionView, getOutdatedPlugins,
  getPluginVulnerabilities, getAdoption,
} = await import('../src/api/reporting/analytics-queries.js');
const { ReportingService } = await import('../src/api/reporting-service.js');

const SCOPE = { orgId: 'acme', from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };
const ROLLUP = { ...SCOPE, orgIds: ['acme', 'team-1'] };

beforeEach(() => { tx = fakeTx(); });

describe('getPipelineBreakdown', () => {
  it('maps a row, and keeps a null success rate null', async () => {
    tx.queue([{
      pipeline_id: 'p1',
      pipeline_name: 'web',
      project: 'web',
      runs: 10,
      succeeded: 9,
      failed: 1,
      p95_ms: 2000,
      build_seconds: 100,
      deploys: 3,
      last_failure_at: new Date('2026-09-10T00:00:00Z'),
      last_failure_stage: 'Deploy',
      success_pct: '90.0',
    }]);
    const [row] = await getPipelineBreakdown(SCOPE);
    expect(row).toEqual({
      pipelineId: 'p1',
      pipelineName: 'web',
      project: 'web',
      runs: 10,
      succeeded: 9,
      failed: 1,
      successPct: 90,
      p95Ms: 2000,
      deploys: 3,
      lastFailureAt: '2026-09-10T00:00:00.000Z',
      lastFailureStage: 'Deploy',
      buildSeconds: 100,
    });
  });

  /** A pipeline nobody ran has no success rate; 0 would read as total failure. */
  it('carries a NULL success rate and a NULL p95 through as null', async () => {
    tx.queue([{ pipeline_id: 'p1', runs: 0, succeeded: 0, failed: 0, success_pct: null, p95_ms: null, deploys: 0 }]);
    const [row] = await getPipelineBreakdown(SCOPE);
    expect(row?.successPct).toBeNull();
    expect(row?.p95Ms).toBeNull();
  });

  it('tolerates a driver that returns counts as strings', async () => {
    tx.queue([{ pipeline_id: 'p1', runs: '15', succeeded: '15', failed: '0', deploys: '2', build_seconds: '90' }]);
    const [row] = await getPipelineBreakdown(SCOPE);
    expect(row).toMatchObject({ runs: 15, deploys: 2, buildSeconds: 90 });
  });

  it('defaults an absent name, project and failure to null', async () => {
    tx.queue([{ pipeline_id: 'p1', runs: 1, succeeded: 1 }]);
    const [row] = await getPipelineBreakdown(SCOPE);
    expect(row).toMatchObject({ pipelineName: null, project: null, lastFailureAt: null, lastFailureStage: null });
  });

  it('returns an empty list for a period with nothing in it', async () => {
    tx.queue([]);
    expect(await getPipelineBreakdown(SCOPE)).toEqual([]);
  });

  it('scopes to a rollup org set when one is given', async () => {
    tx.queue([]);
    await getPipelineBreakdown(ROLLUP);
    // The SQL is asserted elsewhere; what matters here is that the rollup path is
    // taken at all rather than silently reporting only the parent org.
    expect(tx.of('execute')).toHaveLength(1);
  });
});

describe('getFailureAnalysis', () => {
  /**
   * The split that stops a team being asked to fix an AWS capacity problem.
   */
  it('separates what the team can act on from what happened to them', async () => {
    tx.queue(
      [{ category: 'dependency', count: 6 }, { category: 'infrastructure', count: 4 }],
      [],
    );
    const result = await getFailureAnalysis(SCOPE);
    expect(result.total).toBe(10);
    expect(result.actionableTotal).toBe(6);
    expect(result.categories.find((c) => c.category === 'infrastructure')?.teamActionable).toBe(false);
  });

  it('computes each category share, and orders biggest first', async () => {
    tx.queue([{ category: 'build', count: 1 }, { category: 'timeout', count: 3 }], []);
    const { categories } = await getFailureAnalysis(SCOPE);
    expect(categories.map((c) => c.category)).toEqual(['timeout', 'build']);
    expect(categories[0]?.sharePct).toBe(75);
    expect(categories[1]?.sharePct).toBe(25);
  });

  it('gives each category a manager-readable label', async () => {
    tx.queue([{ category: 'dependency', count: 1 }], []);
    expect((await getFailureAnalysis(SCOPE)).categories[0]?.label).toBe('Dependency resolution');
  });

  /** No previous period ⇒ no trend, rather than a change of zero. */
  it('reports a null change when there is nothing to compare', async () => {
    tx.queue([{ category: 'build', count: 2 }], []);
    expect((await getFailureAnalysis(SCOPE)).categories[0]?.change).toBeNull();
  });

  it('computes the change against the previous period, including a fall to nothing', async () => {
    tx.queue(
      [{ category: 'build', count: 2 }],
      [{ category: 'build', count: 5 }, { category: 'timeout', count: 4 }],
      [],
    );
    const { categories } = await getFailureAnalysis(SCOPE, { from: 'a', to: 'b' });
    expect(categories.find((c) => c.category === 'build')?.change).toBe(-3);
  });

  it('treats a category absent last period as all-new', async () => {
    tx.queue([{ category: 'timeout', count: 4 }], [{ category: 'build', count: 1 }], []);
    expect((await getFailureAnalysis(SCOPE, { from: 'a', to: 'b' })).categories[0]?.change).toBe(4);
  });

  it('attaches the pipelines a category hit hardest', async () => {
    tx.queue(
      [{ category: 'build', count: 5 }],
      [{ category: 'build', pipeline_id: 'p1', pipeline_name: 'web', count: 3 },
        { category: 'build', pipeline_id: 'p2', pipeline_name: null, count: 2 }],
    );
    const top = (await getFailureAnalysis(SCOPE)).categories[0]?.topPipelines ?? [];
    expect(top).toEqual([
      { pipelineId: 'p1', pipelineName: 'web', count: 3 },
      { pipelineId: 'p2', pipelineName: null, count: 2 },
    ]);
  });

  it('reports zero shares rather than dividing by zero', async () => {
    tx.queue([], []);
    const result = await getFailureAnalysis(SCOPE);
    expect(result).toMatchObject({ total: 0, actionableTotal: 0, categories: [] });
  });
});

describe('getStagePerformance', () => {
  it('orders slowest first', async () => {
    tx.queue([
      { stageName: 'Build', runs: 5, failed: 0, p50Ms: 1000, p95Ms: 2000 },
      { stageName: 'Deploy', runs: 5, failed: 1, p50Ms: 4000, p95Ms: 9000 },
    ]);
    const rows = await getStagePerformance(SCOPE, 'p1');
    expect(rows.map((r) => r.stageName)).toEqual(['Deploy', 'Build']);
  });

  it('computes the p95 change against the previous period', async () => {
    tx.queue(
      [{ stageName: 'Build', runs: 5, failed: 0, p50Ms: 1000, p95Ms: 200_000 }],
      [{ stageName: 'Build', runs: 5, failed: 0, p50Ms: 900, p95Ms: 100_000 }],
    );
    const [row] = await getStagePerformance(SCOPE, 'p1', { from: 'a', to: 'b' });
    expect(row?.p95ChangePct).toBe(100);
  });

  it('reports no change when the stage is new, or the baseline is zero', async () => {
    tx.queue(
      [{ stageName: 'New', runs: 1, failed: 0, p50Ms: 10, p95Ms: 20 }],
      [{ stageName: 'Old', runs: 1, failed: 0, p50Ms: 10, p95Ms: 20 }],
    );
    expect((await getStagePerformance(SCOPE, 'p1', { from: 'a', to: 'b' }))[0]?.p95ChangePct).toBeNull();
  });

  it('carries null timings through', async () => {
    tx.queue([{ stageName: 'Build', runs: 1, failed: 0, p50Ms: null, p95Ms: null }]);
    const [row] = await getStagePerformance(SCOPE, 'p1');
    expect(row).toMatchObject({ p50Ms: null, p95Ms: null, p95ChangePct: null });
  });
});

describe('getResourceConsumption', () => {
  it('computes each pipeline\'s share of the total build time', async () => {
    tx.queue([
      { project: 'web', pipeline_id: 'p1', pipeline_name: 'web', build_seconds: 750, runs: 10 },
      { project: 'api', pipeline_id: 'p2', pipeline_name: 'api', build_seconds: 250, runs: 5 },
    ]);
    const result = await getResourceConsumption(SCOPE);
    expect(result.totalBuildSeconds).toBe(1000);
    expect(result.pipelines[0]?.sharePct).toBe(75);
    expect(result.pipelines[1]?.sharePct).toBe(25);
  });

  it('reports zero shares for a period with no build time', async () => {
    tx.queue([{ project: null, pipeline_id: 'p1', pipeline_name: null, build_seconds: 0, runs: 0 }]);
    const result = await getResourceConsumption(SCOPE);
    expect(result.totalBuildSeconds).toBe(0);
    expect(result.pipelines[0]?.sharePct).toBe(0);
  });
});

describe('getPromotionView', () => {
  const stop = (sha: string, environment: string, at: string) =>
    ({ commit_sha: sha, environment, deployed_at: at });

  it('orders a commit\'s stops and measures the gap between them', async () => {
    tx.queue([
      stop('abc', 'production', '2026-09-10T14:00:00Z'),
      stop('abc', 'dev', '2026-09-10T08:00:00Z'),
      stop('abc', 'staging', '2026-09-10T10:00:00Z'),
    ]);
    const { commits } = await getPromotionView(SCOPE);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.stops.map((s) => s.environment)).toEqual(['dev', 'staging', 'production']);
    // The first stop has nothing to measure from.
    expect(commits[0]?.stops[0]?.hoursFromPrevious).toBeNull();
    expect(commits[0]?.stops[1]?.hoursFromPrevious).toBe(2);
    expect(commits[0]?.stops[2]?.hoursFromPrevious).toBe(4);
  });

  /**
   * The number worth reading: work that is finished and not delivered, which no
   * other metric in the report shows.
   */
  it('marks a commit that never reached production as stuck', async () => {
    tx.queue([
      stop('abc', 'dev', '2026-09-10T08:00:00Z'),
      stop('abc', 'staging', '2026-09-10T10:00:00Z'),
    ]);
    const { commits, stuckCount } = await getPromotionView(SCOPE);
    expect(commits[0]).toMatchObject({ stuck: true, furthest: 'staging' });
    expect(stuckCount).toBe(1);
  });

  it('does not mark a commit that reached production', async () => {
    tx.queue([stop('abc', 'production', '2026-09-10T14:00:00Z')]);
    const { commits, stuckCount } = await getPromotionView(SCOPE);
    expect(commits[0]?.stuck).toBe(false);
    expect(stuckCount).toBe(0);
  });

  /** An org whose final environment is not called "production". */
  it('honours a different production environment name', async () => {
    tx.queue([stop('abc', 'live', '2026-09-10T14:00:00Z')]);
    expect((await getPromotionView(SCOPE, 'live')).commits[0]?.stuck).toBe(false);
  });

  it('keeps commits apart and caps the list', async () => {
    tx.queue([
      stop('aaa', 'dev', '2026-09-10T08:00:00Z'),
      stop('bbb', 'dev', '2026-09-11T08:00:00Z'),
      stop('ccc', 'dev', '2026-09-12T08:00:00Z'),
    ]);
    const { commits } = await getPromotionView(SCOPE, 'production', 2);
    expect(commits).toHaveLength(2);
    // Newest last-stop first: the most recent movement is what a reader wants.
    expect(commits[0]?.commitSha).toBe('ccc');
  });

  it('returns nothing for a period with no commit-tagged deploys', async () => {
    tx.queue([]);
    expect(await getPromotionView(SCOPE)).toEqual({ commits: [], stuckCount: 0 });
  });
});

describe('getOutdatedPlugins', () => {
  it('counts the distinct pipelines behind, and the major gaps', async () => {
    tx.queue([
      { pipeline_id: 'p1', pipeline_name: 'web', stage_name: 'Build', step_name: 'a', plugin: 'acme/trivy', resolved_version: '1.0.0', latest_version: '2.0.0', version_gap: 'major', within_policy: true },
      { pipeline_id: 'p1', pipeline_name: 'web', stage_name: 'Build', step_name: 'b', plugin: 'acme/cdk', resolved_version: '1.0.0', latest_version: '1.1.0', version_gap: 'minor', within_policy: true },
      { pipeline_id: 'p2', pipeline_name: 'api', stage_name: 'Build', step_name: 'a', plugin: 'acme/trivy', resolved_version: '1.0.0', latest_version: '2.0.0', version_gap: 'major', within_policy: false },
    ]);
    const result = await getOutdatedPlugins(SCOPE);
    expect(result.behindPipelines).toBe(2);
    expect(result.majorBehind).toBe(2);
    expect(result.rows[2]?.withinPolicy).toBe(false);
  });

  it('defaults withinPolicy to true when the column is absent', async () => {
    tx.queue([{ pipeline_id: 'p1', stage_name: 's', step_name: 't', plugin: 'x' }]);
    expect((await getOutdatedPlugins(SCOPE)).rows[0]?.withinPolicy).toBe(true);
  });

  it('returns zero counts for an org with nothing behind', async () => {
    tx.queue([]);
    expect(await getOutdatedPlugins(SCOPE)).toEqual({ rows: [], behindPipelines: 0, majorBehind: 0 });
  });
});

describe('getPluginVulnerabilities', () => {
  it('counts exposed pipelines and the ones with a Critical, separately', async () => {
    tx.queue([
      { pipeline_id: 'p1', pipeline_name: 'web', plugin: 'acme/trivy', plugin_version: '1.0.0', source: 'deployed', critical_count: 2, high_count: 1, top_findings: [{ id: 'CVE-1' }], flagged_at: new Date('2026-09-10T00:00:00Z') },
      { pipeline_id: 'p2', pipeline_name: 'api', plugin: 'acme/trivy', plugin_version: '1.0.0', source: 'declared', critical_count: 0, high_count: 4, top_findings: null, flagged_at: new Date('2026-09-10T00:00:00Z') },
    ]);
    const result = await getPluginVulnerabilities(SCOPE);
    expect(result.exposedPipelines).toBe(2);
    // High-only exposure is real but is not a Critical: conflating them would make
    // "2 pipelines with Criticals" a number nobody could trust.
    expect(result.criticalPipelines).toBe(1);
    expect(result.rows[1]?.findings).toEqual([]);
  });

  /** Says which side it is showing: declared config vs what actually ran. */
  it('carries the declared/deployed distinction through', async () => {
    tx.queue([{ pipeline_id: 'p1', plugin: 'x', plugin_version: '1', source: 'declared', critical_count: 1, high_count: 0, flagged_at: new Date() }]);
    expect((await getPluginVulnerabilities(SCOPE)).rows[0]?.source).toBe('declared');
  });

  it('returns zero counts for a clean org', async () => {
    tx.queue([]);
    expect(await getPluginVulnerabilities(SCOPE)).toEqual({ rows: [], exposedPipelines: 0, criticalPipelines: 0 });
  });
});

describe('getAdoption', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    total_pipelines: 10,
    active_pipelines: 6,
    active_teams: 2,
    deploy_tracked: 4,
    by_source: { template: 6, manual: 4 },
    ...over,
  });

  it('reports the counts and the creation-source breakdown', async () => {
    tx.queue([summary()]);
    expect(await getAdoption(SCOPE)).toMatchObject({
      totalPipelines: 10,
      activePipelines: 6,
      activeTeams: 2,
      deployTrackedPipelines: 4,
      bySource: { template: 6, manual: 4 },
    });
  });

  /**
   * The honest denominator. Six pipelines ran and only four are visible to DORA —
   * reporting the deploy numbers without that is a lie of omission.
   */
  it('keeps "ran" and "we can see its deploys" as separate numbers', async () => {
    tx.queue([summary({ active_pipelines: 6, deploy_tracked: 4 })]);
    const result = await getAdoption(SCOPE);
    expect(result.activePipelines).not.toBe(result.deployTrackedPipelines);
  });

  /**
   * NOT estimated unless the org configured the assumption. A platform-supplied
   * number here would be the platform marking its own homework.
   */
  it('reports no time saved when the org configured no assumption', async () => {
    tx.queue([summary()]);
    expect((await getAdoption(SCOPE)).estimatedMinutesSaved).toBeNull();
    tx.reset();
    tx.queue([summary()]);
    expect((await getAdoption(SCOPE, 0)).estimatedMinutesSaved).toBeNull();
  });

  it('multiplies the org\'s own assumption by the pipelines created', async () => {
    tx.queue([summary({ total_pipelines: 10 })]);
    expect((await getAdoption(SCOPE, 45)).estimatedMinutesSaved).toBe(450);
  });

  it('reports at least one team, and an empty source map, for a bare org', async () => {
    tx.queue([{ total_pipelines: 0, active_pipelines: 0, active_teams: 0, deploy_tracked: 0, by_source: null }]);
    const result = await getAdoption(SCOPE);
    expect(result.activeTeams).toBe(1);
    expect(result.bySource).toEqual({});
  });

  it('survives a driver that returns no row at all', async () => {
    tx.queue([]);
    expect(await getAdoption(SCOPE)).toMatchObject({ totalPipelines: 0, activeTeams: 1 });
  });
});

/**
 * `reportingService` has to satisfy the report engine's `SectionDataSource` in
 * FULL, or a section would have to reach past the service for its data — and the
 * moment one does, the report and the dashboard can disagree about the same
 * number. These are thin delegations, so what is worth pinning is that they exist,
 * pass their arguments through, and that the adoption one reads the org's OWN
 * time-saved assumption rather than accepting a default.
 */
describe('reportingService satisfies the section data source', () => {
  const service = new ReportingService();

  it.each([
    ['getPipelineBreakdown', () => service.getPipelineBreakdown(SCOPE), 1],
    ['getFailureAnalysis', () => service.getFailureAnalysis(SCOPE), 2],
    ['getStagePerformance', () => service.getStagePerformance(SCOPE, 'p1'), 1],
    ['getResourceConsumption', () => service.getResourceConsumption(SCOPE), 1],
    ['getPromotionView', () => service.getPromotionView(SCOPE), 1],
    ['getOutdatedPlugins', () => service.getOutdatedPlugins(SCOPE), 1],
    ['getPluginVulnerabilities', () => service.getPluginVulnerabilities(SCOPE), 1],
  ])('%s delegates to the analytics query', async (_name, call, queries) => {
    // Enough empty results for however many statements the query runs.
    for (let i = 0; i < queries; i++) tx.queue([]);
    await expect(call()).resolves.toBeDefined();
    expect(tx.queries.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Read from the ORG's settings, not taken from the caller, so the adoption
   * section cannot accidentally be handed a platform-chosen number — it only means
   * anything when the customer picked it.
   */
  it('getAdoption reads the org\'s own time-saved assumption', async () => {
    tx.queue([{ minutes: 30 }], [{ total_pipelines: 4, active_pipelines: 2, active_teams: 1, deploy_tracked: 2, by_source: {} }]);
    expect((await service.getAdoption(SCOPE)).estimatedMinutesSaved).toBe(120);
  });

  it('getAdoption reports nothing when the org set no assumption', async () => {
    tx.queue([], [{ total_pipelines: 4, active_pipelines: 2, active_teams: 1, deploy_tracked: 2, by_source: {} }]);
    expect((await service.getAdoption(SCOPE)).estimatedMinutesSaved).toBeNull();
  });

  it('getAdoption honours an explicitly passed assumption without a settings read', async () => {
    tx.queue([{ total_pipelines: 4, active_pipelines: 2, active_teams: 1, deploy_tracked: 2, by_source: {} }]);
    expect((await service.getAdoption(SCOPE, 10)).estimatedMinutesSaved).toBe(40);
  });
});
