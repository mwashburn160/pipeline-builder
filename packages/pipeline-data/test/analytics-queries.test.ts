// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bespoke report sections' queries, against a REAL Postgres.
 *
 * Every one of these is raw SQL with CTEs, window functions and `jsonb_each`, and
 * the rollup work earlier in this feature already produced two statements that
 * typechecked and would not run. So these execute.
 *
 * They execute the MODULE's functions — `getPipelineBreakdown`, `getFailureAnalysis`
 * and the rest — through the real `withTenantTxRead`, as the application role, under
 * the init script's RLS, via the package's testing entry. (This file used to run
 * hand-copied strings of each statement, guarded by a "the copy still contains these
 * lines" check; that proved a string in a test file ran, not that the module did.)
 *
 * Beyond "does it run", each test pins a judgement the query encodes:
 *
 *  - the breakdown reads the PIPELINE grain only (summing stage rows too would
 *    count every run once per stage);
 *  - a pipeline with no runs has a NULL success rate, not 0%;
 *  - worst first, with ties broken on volume;
 *  - failures split into what the team can act on and what happened to them;
 *  - "stuck" commits — work finished and not delivered, which no other metric shows;
 *  - the deploy-tracking denominator, without which every DORA number is a lie of
 *    omission.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  getAdoption,
  getFailureAnalysis,
  getOutdatedPlugins,
  getPipelineBreakdown,
  getPipelineStreaks,
  getPluginVulnerabilities,
  getPromotionView,
  getResourceConsumption,
  getUntrackedPipelines,
  getVulnerablePipelines,
  type AnalyticsScope,
} from '../src/api/reporting/analytics-queries.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
/** Raw SQL as the bootstrap superuser — fixtures across every org. */
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-analytics';
const TEAM = 'org-team';
const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';
const PIPE_A = randomUUID();
const PIPE_B = randomUUID();
const PIPE_TEAM = randomUUID();

/** The report scope, read the way a request does: inside the caller org's tenant scope. */
const SCOPE: AnalyticsScope = { orgId: ORG, from: FROM, to: TO };
const asOrg = <T>(fn: () => Promise<T>, orgId = ORG) => asTenantContext({ orgId }, fn);

beforeAll(async () => {
  tdb = await bootTenantDb();
  for (const [id, org, project, name, source] of [
    [PIPE_A, ORG, 'web', 'web-deploy', 'template'],
    [PIPE_B, ORG, 'api', 'api-deploy', 'manual'],
    [PIPE_TEAM, TEAM, 'mobile', 'mobile-deploy', 'ai'],
  ] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, creation_source, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', $4, $5, '{}'::jsonb, 'u1', 'u1')`,
      [id, org, project, name, source],
    ));
  }
}, 120_000);

afterAll(async () => { await tdb?.close(); });

beforeEach(async () => {
  await owner((db) => db.exec(`
    DELETE FROM execution_daily_rollups;
    DELETE FROM dora_deployments;
    DELETE FROM pipeline_plugin_resolution;
    DELETE FROM plugin_vuln_exposure;
  `));
});

interface RollupSeed {
  orgId?: string;
  pipelineId?: string;
  stageName?: string;
  day?: string;
  runs?: number;
  succeeded?: number;
  failed?: number;
  categories?: Record<string, number>;
  p50?: number | null;
  p95?: number | null;
  buildSeconds?: number;
}

async function seedRollup(seed: RollupSeed = {}): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO execution_daily_rollups
       (org_id, day, pipeline_id, stage_name, runs, succeeded, failed,
        failures_by_category, p50_ms, p90_ms, p95_ms, build_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,$10,$11)`,
    [
      seed.orgId ?? ORG,
      seed.day ?? '2026-09-10T00:00:00Z',
      seed.pipelineId ?? PIPE_A,
      seed.stageName ?? '',
      seed.runs ?? 10,
      seed.succeeded ?? 10,
      seed.failed ?? 0,
      JSON.stringify(seed.categories ?? {}),
      seed.p50 === undefined ? 1000 : seed.p50,
      seed.p95 === undefined ? 2000 : seed.p95,
      seed.buildSeconds ?? 100,
    ],
  ));
}

async function seedDeploy(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    org_id: ORG,
    execution_id: randomUUID(),
    environment: 'production',
    pipeline_id: PIPE_A,
    deployed_at: '2026-09-10T12:00:00Z',
    succeeded: true,
    commit_sha: null,
    ...over,
  };
  await owner((db) => db.query(
    `INSERT INTO dora_deployments
       (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, commit_sha)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    Object.values(row),
  ));
}

// ── Pipeline breakdown ──────────────────────────────────────────────────────

const breakdown = (limit = 10, scope: AnalyticsScope = SCOPE) => asOrg(() => getPipelineBreakdown(scope, limit));

describe('the pipeline breakdown', () => {
  it('runs, and joins the pipeline name in', async () => {
    await seedRollup();
    const rows = await breakdown();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pipelineId: PIPE_A, pipelineName: 'web-deploy', project: 'web', runs: 10, successPct: 100 });
  });

  /** Summing the stage rows too would count every run once per stage. */
  it('reads the pipeline grain only, not the stage rows', async () => {
    await seedRollup({ stageName: '', runs: 10, succeeded: 10 });
    await seedRollup({ stageName: 'Build', runs: 10, succeeded: 10 });
    await seedRollup({ stageName: 'Deploy', runs: 10, succeeded: 10 });
    expect((await breakdown())[0]?.runs).toBe(10);
  });

  it('sums across days in the window', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 10, succeeded: 9, failed: 1 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 5, succeeded: 5 });
    const [r] = await breakdown();
    expect(r).toMatchObject({ runs: 15, succeeded: 14, failed: 1 });
    expect(r?.successPct).toBeCloseTo(93.3, 1);
  });

  it('excludes days outside the window', async () => {
    await seedRollup({ day: '2026-08-31T00:00:00Z', runs: 100 });
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 5 });
    expect((await breakdown())[0]?.runs).toBe(5);
  });

  /**
   * The rollup `day` is a UTC date; a report's window is LOCAL midnights. A Chicago
   * September starts at 05:00Z on the 1st, and comparing that instant to the Sept 1
   * row directly would drop it (and pick up Oct 1's).
   */
  it('maps a local-time window onto UTC rollup days', async () => {
    await seedRollup({ day: '2026-09-01T00:00:00Z', runs: 3 });
    await seedRollup({ day: '2026-10-01T00:00:00Z', runs: 100 });
    const rows = await breakdown(10, {
      orgId: ORG, from: '2026-09-01T05:00:00Z', to: '2026-10-01T05:00:00Z', tz: 'America/Chicago',
    });
    expect(rows[0]?.runs).toBe(3);
  });

  /**
   * WORST FIRST, and ties break on volume: a 50%-success pipeline that ran twice
   * must not outrank one that ran two hundred times.
   */
  it('sorts worst first, breaking ties on volume', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 200, succeeded: 100, failed: 100 });
    await seedRollup({ pipelineId: PIPE_B, runs: 2, succeeded: 1, failed: 1 });
    expect((await breakdown()).map((r) => r.pipelineId)).toEqual([PIPE_A, PIPE_B]);
  });

  /** A pipeline nobody ran is not a pipeline that failed. */
  it('gives a pipeline with no runs a NULL success rate, not 0', async () => {
    await seedRollup({ runs: 0, succeeded: 0, failed: 0 });
    expect((await breakdown())[0]?.successPct).toBeNull();
  });

  it('puts the un-rateable pipelines last, not first', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 0, succeeded: 0 });
    await seedRollup({ pipelineId: PIPE_B, runs: 10, succeeded: 5, failed: 5 });
    expect((await breakdown())[0]?.pipelineId).toBe(PIPE_B);
  });

  it('counts only SUCCESSFUL deploys', async () => {
    await seedRollup();
    await seedDeploy({ succeeded: true });
    await seedDeploy({ succeeded: false });
    expect((await breakdown())[0]?.deploys).toBe(1);
  });

  it('reports zero deploys rather than null for a pipeline with none', async () => {
    await seedRollup();
    expect((await breakdown())[0]?.deploys).toBe(0);
  });

  it('names the most recent failing stage, for "what to look at first"', async () => {
    await seedRollup({ stageName: '', runs: 10, failed: 2, succeeded: 8 });
    await seedRollup({ stageName: 'Build', day: '2026-09-09T00:00:00Z', failed: 1, runs: 1, succeeded: 0 });
    await seedRollup({ stageName: 'Deploy', day: '2026-09-11T00:00:00Z', failed: 1, runs: 1, succeeded: 0 });
    const [r] = await breakdown();
    expect(r).toMatchObject({ lastFailureStage: 'Deploy', lastFailureAt: '2026-09-11T00:00:00.000Z' });
  });

  it('keeps another org out', async () => {
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM });
    expect(await breakdown()).toEqual([]);
  });

  /**
   * A parent's rollup runs ELEVATED (FORCE RLS would otherwise filter every child
   * team's rows out under the parent's own tenant), and the `= ANY(ids)` predicate
   * over the anchor-validated subtree is then the only tenancy gate.
   */
  it('reads a parent\'s team subtree in a rollup', async () => {
    await seedRollup({ orgId: ORG, pipelineId: PIPE_A });
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM });
    const rows = await breakdown(10, { ...SCOPE, orgIds: [ORG, TEAM] });
    expect(new Set(rows.map((r) => r.pipelineId))).toEqual(new Set([PIPE_A, PIPE_TEAM]));
  });

  it('collapses a subtree that omits the requesting org to the single-org scope', async () => {
    await seedRollup({ orgId: ORG, pipelineId: PIPE_A });
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM });
    const rows = await breakdown(10, { ...SCOPE, orgIds: [TEAM, 'org-elsewhere'] });
    expect(rows.map((r) => r.pipelineId)).toEqual([PIPE_A]);
  });

  it('honours the limit', async () => {
    await seedRollup({ pipelineId: PIPE_A });
    await seedRollup({ pipelineId: PIPE_B });
    expect(await breakdown(1)).toHaveLength(1);
  });
});

// ── Failure analysis ────────────────────────────────────────────────────────

describe('failure analysis', () => {
  it('unrolls the category map and sums across days, biggest first', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', failed: 3, categories: { dependency: 2, timeout: 1 } });
    await seedRollup({ day: '2026-09-11T00:00:00Z', failed: 2, categories: { dependency: 2 } });
    const { categories, total } = await asOrg(() => getFailureAnalysis(SCOPE));
    expect(categories.map((c) => [c.category, c.count])).toEqual([['dependency', 4], ['timeout', 1]]);
    expect(total).toBe(5);
    expect(categories[0]?.sharePct).toBe(80);
  });

  /** A week of cloud throttling is a different conversation from a week of broken tests. */
  it('splits what the team can act on from what happened to it', async () => {
    await seedRollup({ failed: 5, categories: { unit_test: 3, infrastructure: 2 } });
    const r = await asOrg(() => getFailureAnalysis(SCOPE));
    expect(r.actionableTotal).toBe(3);
    expect(r.categories.find((c) => c.category === 'infrastructure')?.teamActionable).toBe(false);
  });

  it('reports the change against the previous period', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', failed: 5, categories: { build: 5 } });
    await seedRollup({ day: '2026-08-10T00:00:00Z', failed: 2, categories: { build: 2 } });
    const r = await asOrg(() => getFailureAnalysis(SCOPE, { from: '2026-08-01T00:00:00Z', to: FROM }));
    expect(r.categories[0]).toMatchObject({ category: 'build', count: 5, change: 3 });
  });

  it('returns nothing when no failure carried a category', async () => {
    await seedRollup({ categories: {} });
    const r = await asOrg(() => getFailureAnalysis(SCOPE));
    expect(r).toEqual({ categories: [], total: 0, actionableTotal: 0 });
  });

  it('ranks the pipelines a category hit hardest, with their names', async () => {
    await seedRollup({ pipelineId: PIPE_A, failed: 5, categories: { dependency: 5 } });
    await seedRollup({ pipelineId: PIPE_B, failed: 1, categories: { dependency: 1 } });
    const [dep] = (await asOrg(() => getFailureAnalysis(SCOPE))).categories;
    expect(dep?.topPipelines[0]).toEqual({ pipelineId: PIPE_A, pipelineName: 'web-deploy', count: 5 });
  });

  it('caps the per-category list at three', async () => {
    for (const p of [PIPE_A, PIPE_B, randomUUID(), randomUUID()]) {
      await seedRollup({ pipelineId: p, categories: { build: 3 } });
    }
    const [build] = (await asOrg(() => getFailureAnalysis(SCOPE))).categories;
    expect(build?.count).toBe(12);
    expect(build?.topPipelines).toHaveLength(3);
  });
});

// ── Resource consumption ────────────────────────────────────────────────────

describe('resource consumption', () => {
  it('totals build seconds per pipeline, biggest first, with a share', async () => {
    await seedRollup({ pipelineId: PIPE_A, buildSeconds: 100 });
    await seedRollup({ pipelineId: PIPE_B, buildSeconds: 900 });
    const r = await asOrg(() => getResourceConsumption(SCOPE));
    expect(r.totalBuildSeconds).toBe(1000);
    expect(r.pipelines[0]).toMatchObject({ pipelineId: PIPE_B, project: 'api', buildSeconds: 900, sharePct: 90 });
  });
});

// ── Promotion view ──────────────────────────────────────────────────────────

describe('the promotion view', () => {
  it('collects each commit\'s environments in the order it reached them', async () => {
    const sha = 'a'.repeat(40);
    await seedDeploy({ commit_sha: sha, environment: 'dev', deployed_at: '2026-09-10T08:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'staging', deployed_at: '2026-09-10T10:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T14:00:00Z' });
    const { commits, stuckCount } = await asOrg(() => getPromotionView(SCOPE));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.stops.map((s) => [s.environment, s.hoursFromPrevious])).toEqual([
      ['dev', null], ['staging', 2], ['production', 4],
    ]);
    expect(commits[0]).toMatchObject({ furthest: 'production', stuck: false });
    expect(stuckCount).toBe(0);
  });

  /**
   * The number worth reading. A commit that reached staging and stopped is work
   * that is finished and not delivered — invisible to deployment frequency, success
   * rate and lead time, because by all three nothing happened.
   */
  it('shows a commit that stopped short of production', async () => {
    const stuck = 'b'.repeat(40);
    await seedDeploy({ commit_sha: stuck, environment: 'dev', deployed_at: '2026-09-10T08:00:00Z' });
    await seedDeploy({ commit_sha: stuck, environment: 'staging', deployed_at: '2026-09-10T09:00:00Z' });
    const { commits, stuckCount } = await asOrg(() => getPromotionView(SCOPE));
    expect(commits[0]).toMatchObject({ commitSha: stuck, furthest: 'staging', stuck: true });
    expect(stuckCount).toBe(1);
  });

  it('ignores failed deploys and commitless ones', async () => {
    await seedDeploy({ commit_sha: 'c'.repeat(40), succeeded: false });
    await seedDeploy({ commit_sha: null });
    expect(await asOrg(() => getPromotionView(SCOPE))).toEqual({ commits: [], stuckCount: 0 });
  });

  it('takes the EARLIEST arrival when a commit deployed twice to one environment', async () => {
    const sha = 'd'.repeat(40);
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T10:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T18:00:00Z' });
    const { commits } = await asOrg(() => getPromotionView(SCOPE));
    expect(commits[0]?.stops).toEqual([{ environment: 'production', deployedAt: '2026-09-10T10:00:00.000Z', hoursFromPrevious: null }]);
  });
});

// ── Outdated plugins / vulnerabilities ──────────────────────────────────────

const seedResolution = (over: Record<string, unknown> = {}) => owner((db) => db.query(
  `INSERT INTO pipeline_plugin_resolution
     (org_id, pipeline_id, stage_name, step_name, plugin_publisher, plugin_name,
      resolved_version, latest_version, version_gap, within_policy)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  Object.values({
    org_id: ORG,
    pipeline_id: PIPE_A,
    stage_name: 'Build',
    step_name: 'scan',
    plugin_publisher: 'acme',
    plugin_name: 'trivy',
    resolved_version: '1.0.0',
    latest_version: '2.0.0',
    version_gap: 'major',
    within_policy: true,
    ...over,
  }),
));

const outdated = () => asOrg(() => getOutdatedPlugins(SCOPE));

describe('outdated plugins', () => {
  it('puts the biggest gap first and formats the plugin reference', async () => {
    await seedResolution({ step_name: 'patch-step', version_gap: 'patch' });
    await seedResolution({ step_name: 'major-step', version_gap: 'major' });
    const r = await outdated();
    expect(r.rows[0]).toMatchObject({ gap: 'major', plugin: 'acme/trivy', inUse: '1.0.0', latest: '2.0.0', pipelineName: 'web-deploy' });
    expect(r).toMatchObject({ behindPipelines: 1, majorBehind: 1 });
  });

  it('omits the publisher prefix for an own-org plugin', async () => {
    await seedResolution({ plugin_publisher: null, plugin_name: 'local-tool' });
    expect((await outdated()).rows[0]?.plugin).toBe('local-tool');
  });

  it('includes an up-to-date step that is OUTSIDE the org policy', async () => {
    await seedResolution({ version_gap: 'none', within_policy: false });
    const { rows } = await outdated();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.withinPolicy).toBe(false);
  });

  it('excludes an up-to-date, in-policy step', async () => {
    await seedResolution({ version_gap: 'none', within_policy: true });
    expect((await outdated()).rows).toEqual([]);
  });

  it('excludes a step whose gap could not be determined', async () => {
    await seedResolution({ version_gap: null, resolved_version: 'latest' });
    expect((await outdated()).rows).toEqual([]);
  });
});

const seedVuln = (over: Record<string, unknown> = {}) => owner((db) => db.query(
  `INSERT INTO plugin_vuln_exposure
     (id, org_id, pipeline_id, plugin_publisher, plugin_name, plugin_version,
      source, critical_count, high_count, triage_state, accepted_until, fixed_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  Object.values({
    id: randomUUID(),
    org_id: ORG,
    pipeline_id: PIPE_A,
    plugin_publisher: 'acme',
    plugin_name: 'trivy',
    plugin_version: '1.0.0',
    source: 'deployed',
    critical_count: 2,
    high_count: 5,
    triage_state: 'open',
    accepted_until: null,
    fixed_at: null,
    ...over,
  }),
));

const vulns = () => asOrg(() => getPluginVulnerabilities(SCOPE));

describe('plugin vulnerabilities', () => {
  it('shows open exposures, Criticals first, and says declared vs deployed', async () => {
    await seedVuln({ plugin_version: '1.0.0', critical_count: 0, high_count: 9, source: 'declared' });
    await seedVuln({ plugin_version: '1.1.0', critical_count: 3, high_count: 1, source: 'deployed' });
    const r = await vulns();
    expect(r.rows[0]).toMatchObject({ critical: 3, source: 'deployed', version: '1.1.0', plugin: 'acme/trivy' });
    expect(r.rows[1]).toMatchObject({ high: 9, source: 'declared' });
    expect(r).toMatchObject({ exposedPipelines: 1, criticalPipelines: 1 });
  });

  it('excludes a fixed exposure', async () => {
    await seedVuln({ fixed_at: '2026-09-15T00:00:00Z' });
    expect((await vulns()).rows).toEqual([]);
  });

  it('excludes a live acceptance and a false positive', async () => {
    await seedVuln({ plugin_version: '1.0.0', triage_state: 'accepted', accepted_until: '2099-01-01T00:00:00Z' });
    await seedVuln({ plugin_version: '1.1.0', triage_state: 'false_positive' });
    expect((await vulns()).rows).toEqual([]);
  });

  /** An acceptance past its deadline is not an acceptance. */
  it('INCLUDES an acceptance whose deadline has passed', async () => {
    await seedVuln({ triage_state: 'accepted', accepted_until: '2020-01-01T00:00:00Z' });
    expect((await vulns()).rows).toHaveLength(1);
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────

const adoption = (orgIds?: string[], orgId = ORG) =>
  asOrg(() => getAdoption({ orgId, orgIds, from: FROM, to: TO }), orgId);

describe('adoption and coverage', () => {
  it('counts pipelines, active pipelines and creation source', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 5 });
    const r = await adoption();
    expect(r).toMatchObject({ totalPipelines: 2, activePipelines: 1, activeTeams: 1 });
    expect(r.bySource).toEqual({ template: 1, manual: 1 });
  });

  /**
   * The honest denominator for everything DORA says. A pipeline that has not
   * re-synthed with deploy tags produces no deploy rows, so it is invisible to
   * deployment frequency — and reporting "4 deploys" without saying that half the
   * pipelines cannot be seen is the most misleading thing this feature could do.
   */
  it('separates "ran" from "we can see its deploys"', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 5 });
    await seedRollup({ pipelineId: PIPE_B, runs: 5 });
    await seedDeploy({ pipeline_id: PIPE_A });
    expect(await adoption()).toMatchObject({ activePipelines: 2, deployTrackedPipelines: 1 });
  });

  it('counts the teams that had activity in a rollup', async () => {
    await seedRollup({ orgId: ORG, pipelineId: PIPE_A, runs: 1 });
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM, runs: 1 });
    expect(await adoption([ORG, TEAM])).toMatchObject({ activeTeams: 2, totalPipelines: 3 });
  });

  it('does not count a dormant pipeline as active', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 0 });
    expect((await adoption()).activePipelines).toBe(0);
  });

  it('reports an empty source map rather than null for an org with no pipelines', async () => {
    expect((await adoption(undefined, 'org-nobody')).bySource).toEqual({});
  });
});

// ── Needs-attention inputs ──────────────────────────────────────────────────
//
// These three queries feed the section that DECIDES rather than describes, so a wrong
// answer here becomes a confident, wrong flag in front of a manager.

const streaks = () => asOrg(() => getPipelineStreaks(SCOPE));

async function seedExposure(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    id: randomUUID(),
    org_id: ORG,
    pipeline_id: PIPE_A,
    plugin_name: 'scan',
    plugin_version: '1.0.0',
    source: 'declared',
    critical_count: 2,
    high_count: 0,
    triage_state: 'open',
    fixed_at: null,
    ...over,
  };
  await owner((db) => db.query(
    `INSERT INTO plugin_vuln_exposure
       (id, org_id, pipeline_id, plugin_name, plugin_version, source,
        critical_count, high_count, triage_state, fixed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    Object.values(row),
  ));
}

describe('failure streaks', () => {
  it('counts the trailing run of days on which nothing succeeded', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 5, succeeded: 5, failed: 0 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    await seedRollup({ day: '2026-09-12T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    const [row] = await streaks();
    expect(row?.consecutiveFailures).toBe(4);
    expect(row?.lastSuccessAt?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('EXCLUDES the day of the last success, so the count is a true lower bound', async () => {
    // The rollup is per day, so within a day that had a success there is no way to tell
    // whether the failures came before or after it. Counting them would let the evidence
    // claim a run of failures that a success sat in the middle of.
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 4, succeeded: 1, failed: 3 });
    expect((await streaks())[0]?.consecutiveFailures).toBe(0);
  });

  it('counts every failure when a pipeline has never succeeded in the lookback', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 3, succeeded: 0, failed: 3 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 1, succeeded: 0, failed: 1 });
    const [row] = await streaks();
    expect(row?.consecutiveFailures).toBe(4);
    // Null rather than a date, which is what makes rule 4 say "no successful run in this
    // period" instead of an age nobody can compute.
    expect(row?.lastSuccessAt).toBeNull();
  });

  it('reads PAST the report window, so "last succeeded 40 days ago" is answerable', async () => {
    await seedRollup({ day: '2026-08-01T00:00:00Z', runs: 2, succeeded: 2, failed: 0 });
    await seedRollup({ day: '2026-09-20T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    // A query bounded by the report's own 30-day window could never produce this.
    const [row] = await streaks();
    expect(row?.lastSuccessAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns nothing for an org with no rollup rows', async () => {
    expect(await streaks()).toEqual([]);
  });

  it('reads the PIPELINE grain only — stage rows neither inflate the streak nor fake a success', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 2, succeeded: 2, failed: 0 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    // The same two failed runs, as seen by each of their stages: summing these
    // in would count every failure three times.
    await seedRollup({ day: '2026-09-11T00:00:00Z', stageName: 'Build', runs: 2, succeeded: 0, failed: 2 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', stageName: 'Deploy', runs: 2, succeeded: 0, failed: 2 });
    // A stage that SUCCEEDED inside a failed run must not mark the day ok.
    await seedRollup({ day: '2026-09-12T00:00:00Z', runs: 1, succeeded: 0, failed: 1 });
    await seedRollup({ day: '2026-09-12T00:00:00Z', stageName: 'Source', runs: 1, succeeded: 1, failed: 0 });

    const [row] = await streaks();
    expect(row?.consecutiveFailures).toBe(3);
    expect(row?.lastSuccessAt?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('a pipeline with only stage rows contributes nothing', async () => {
    await seedRollup({ day: '2026-09-11T00:00:00Z', stageName: 'Build', runs: 2, succeeded: 0, failed: 2 });
    expect(await streaks()).toEqual([]);
  });
});

const untracked = () => asOrg(() => getUntrackedPipelines(SCOPE));

describe('untracked pipelines', () => {
  it('names a pipeline that RAN and produced no deploy rows', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 4 });
    // A measurement gap, not a failure, and the reason a deployment-frequency number can
    // be quietly wrong. Nothing else in the report would say so.
    expect(await untracked()).toEqual([PIPE_A]);
  });

  it('does not name a pipeline that deployed', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 4 });
    await seedDeploy({ pipeline_id: PIPE_A });
    expect(await untracked()).toEqual([]);
  });

  it('does not name a DORMANT pipeline', async () => {
    // Zero runs is not a measurement gap — there was nothing to measure.
    await seedRollup({ pipelineId: PIPE_A, runs: 0 });
    expect(await untracked()).toEqual([]);
  });

  it('reads the pipeline grain only, so a stage row cannot make one look active', async () => {
    await seedRollup({ pipelineId: PIPE_A, stageName: 'Build', runs: 9 });
    expect(await untracked()).toEqual([]);
  });
});

const vulnerable = () => asOrg(() => getVulnerablePipelines(SCOPE));

describe('vulnerable pipelines', () => {
  it('names a pipeline with an open Critical exposure', async () => {
    await seedExposure();
    expect(await vulnerable()).toEqual([PIPE_A]);
  });

  it('does not name one whose exposure is FIXED', async () => {
    await seedExposure({ fixed_at: '2026-09-15T00:00:00Z' });
    // Point-in-time, not windowed: a Critical that was open last Tuesday and is fixed
    // today is not something to put in front of a manager.
    expect(await vulnerable()).toEqual([]);
  });

  it('does not name one whose exposure was ACCEPTED', async () => {
    await seedExposure({ triage_state: 'accepted' });
    // Someone with the authority to accept a risk already decided about it in writing,
    // with a reason and a deadline. Re-raising it weekly teaches the reader to skip the
    // section; the LAPSE of that acceptance is a separate finding.
    expect(await vulnerable()).toEqual([]);
  });

  /** The SAME live predicate as the vulnerability section: the two once disagreed. */
  it('does not name a false positive', async () => {
    await seedExposure({ triage_state: 'false_positive' });
    expect(await vulnerable()).toEqual([]);
  });

  it('DOES name one whose acceptance has lapsed', async () => {
    await seedVuln({ triage_state: 'accepted', accepted_until: '2020-01-01T00:00:00Z' });
    expect(await vulnerable()).toEqual([PIPE_A]);
  });

  it('ignores High-only findings', async () => {
    await seedExposure({ critical_count: 0, high_count: 5 });
    expect(await vulnerable()).toEqual([]);
  });

  it('does not cross org boundaries', async () => {
    await seedExposure({ org_id: TEAM, pipeline_id: PIPE_TEAM });
    expect(await vulnerable()).toEqual([]);
  });
});
