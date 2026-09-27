// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bespoke report sections' queries, against a REAL Postgres.
 *
 * Every one of these is raw SQL with CTEs, window functions and `jsonb_each`, and
 * the rollup work earlier in this feature already produced two statements that
 * typechecked and would not run. So these execute.
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
import { bootInitDb } from './helpers/pglite-init.js';

let db: PGlite;

const ORG = 'org-analytics';
const TEAM = 'org-team';
const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';
const PIPE_A = randomUUID();
const PIPE_B = randomUUID();
const PIPE_TEAM = randomUUID();

beforeAll(async () => {
  db = await bootInitDb();
  for (const [id, org, project, name, source] of [
    [PIPE_A, ORG, 'web', 'web-deploy', 'template'],
    [PIPE_B, ORG, 'api', 'api-deploy', 'manual'],
    [PIPE_TEAM, TEAM, 'mobile', 'mobile-deploy', 'ai'],
  ] as const) {
    await db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, creation_source, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', $4, $5, '{}'::jsonb, 'u1', 'u1')`,
      [id, org, project, name, source],
    );
  }
}, 120_000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.query('DELETE FROM execution_daily_rollups');
  await db.query('DELETE FROM dora_deployments');
  await db.query('DELETE FROM pipeline_plugin_resolution');
  await db.query('DELETE FROM plugin_vuln_exposure');
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
  await db.query(
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
  );
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
  await db.query(
    `INSERT INTO dora_deployments
       (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, commit_sha)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    Object.values(row),
  );
}

// ── Pipeline breakdown ──────────────────────────────────────────────────────

const BREAKDOWN = `
  WITH totals AS (
    SELECT r.pipeline_id,
           SUM(r.runs)::int AS runs, SUM(r.succeeded)::int AS succeeded,
           SUM(r.failed)::int AS failed, MAX(r.p95_ms)::int AS p95_ms,
           SUM(r.build_seconds)::int AS build_seconds
    FROM execution_daily_rollups r
    WHERE r.org_id = $1 AND r.day >= $2::timestamptz AND r.day < $3::timestamptz
      AND r.stage_name = ''
    GROUP BY r.pipeline_id
  ),
  deploys AS (
    SELECT pipeline_id, COUNT(*)::int AS deploys FROM dora_deployments
    WHERE org_id = $1 AND deployed_at >= $2::timestamptz AND deployed_at < $3::timestamptz
      AND succeeded = true
    GROUP BY pipeline_id
  ),
  last_fail AS (
    SELECT DISTINCT ON (pipeline_id) pipeline_id, day, stage_name
    FROM execution_daily_rollups
    WHERE org_id = $1 AND day >= $2::timestamptz AND day < $3::timestamptz
      AND stage_name <> '' AND failed > 0
    ORDER BY pipeline_id, day DESC, failed DESC
  )
  SELECT t.pipeline_id, p.pipeline_name, p.project, t.runs, t.succeeded, t.failed,
         t.p95_ms, t.build_seconds, COALESCE(d.deploys, 0) AS deploys,
         f.day AS last_failure_at, f.stage_name AS last_failure_stage,
         CASE WHEN t.runs > 0 THEN ROUND((t.succeeded::numeric / t.runs) * 100, 1) ELSE NULL END AS success_pct
  FROM totals t
  LEFT JOIN deploys d ON d.pipeline_id = t.pipeline_id
  LEFT JOIN last_fail f ON f.pipeline_id = t.pipeline_id
  LEFT JOIN pipelines p ON p.id::text = t.pipeline_id
  ORDER BY success_pct ASC NULLS LAST, t.runs DESC
  LIMIT $4
`;

const breakdown = (limit = 10) => db.query<Record<string, unknown>>(BREAKDOWN, [ORG, FROM, TO, limit]).then((r) => r.rows);

describe('the pipeline breakdown', () => {
  it('runs, and joins the pipeline name in', async () => {
    await seedRollup();
    const rows = await breakdown();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pipeline_name: 'web-deploy', project: 'web', runs: 10 });
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
    expect(Number(r?.success_pct)).toBeCloseTo(93.3, 1);
  });

  it('excludes days outside the window', async () => {
    await seedRollup({ day: '2026-08-31T00:00:00Z', runs: 100 });
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 5 });
    expect((await breakdown())[0]?.runs).toBe(5);
  });

  /**
   * WORST FIRST, and ties break on volume: a 50%-success pipeline that ran twice
   * must not outrank one that ran two hundred times.
   */
  it('sorts worst first, breaking ties on volume', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 200, succeeded: 100, failed: 100 });
    await seedRollup({ pipelineId: PIPE_B, runs: 2, succeeded: 1, failed: 1 });
    const rows = await breakdown();
    expect(rows[0]?.pipeline_id).toBe(PIPE_A);
  });

  /** A pipeline nobody ran is not a pipeline that failed. */
  it('gives a pipeline with no runs a NULL success rate, not 0', async () => {
    await seedRollup({ runs: 0, succeeded: 0, failed: 0 });
    expect((await breakdown())[0]?.success_pct).toBeNull();
  });

  it('puts the un-rateable pipelines last, not first', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 0, succeeded: 0 });
    await seedRollup({ pipelineId: PIPE_B, runs: 10, succeeded: 5, failed: 5 });
    expect((await breakdown())[0]?.pipeline_id).toBe(PIPE_B);
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
    expect((await breakdown())[0]?.last_failure_stage).toBe('Deploy');
  });

  it('keeps another org out', async () => {
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM });
    expect(await breakdown()).toEqual([]);
  });

  it('honours the limit', async () => {
    await seedRollup({ pipelineId: PIPE_A });
    await seedRollup({ pipelineId: PIPE_B });
    expect(await breakdown(1)).toHaveLength(1);
  });
});

// ── Failure analysis ────────────────────────────────────────────────────────

const CATEGORIES = `
  SELECT key AS category, SUM(value::int)::int AS count
  FROM execution_daily_rollups r, jsonb_each(r.failures_by_category)
  WHERE r.org_id = $1 AND r.day >= $2::timestamptz AND r.day < $3::timestamptz
    AND r.stage_name = ''
  GROUP BY key
`;

describe('failure analysis', () => {
  it('unrolls the category map and sums across days', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', failed: 3, categories: { dependency: 2, timeout: 1 } });
    await seedRollup({ day: '2026-09-11T00:00:00Z', failed: 2, categories: { dependency: 2 } });
    const rows = (await db.query<Record<string, unknown>>(CATEGORIES, [ORG, FROM, TO])).rows;
    const map = Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
    expect(map).toEqual({ dependency: 4, timeout: 1 });
  });

  it('returns nothing when no failure carried a category', async () => {
    await seedRollup({ categories: {} });
    expect((await db.query(CATEGORIES, [ORG, FROM, TO])).rows).toEqual([]);
  });

  const TOP_BY_CATEGORY = `
    SELECT category, pipeline_id, pipeline_name, count FROM (
      SELECT e.key AS category, r.pipeline_id, p.pipeline_name,
             SUM(e.value::int)::int AS count,
             ROW_NUMBER() OVER (PARTITION BY e.key ORDER BY SUM(e.value::int) DESC) AS rn
      FROM execution_daily_rollups r
      CROSS JOIN LATERAL jsonb_each(r.failures_by_category) e
      LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
      WHERE r.org_id = $1 AND r.day >= $2::timestamptz AND r.day < $3::timestamptz
        AND r.stage_name = ''
      GROUP BY e.key, r.pipeline_id, p.pipeline_name
    ) ranked WHERE rn <= $4
  `;

  it('ranks the pipelines a category hit hardest', async () => {
    await seedRollup({ pipelineId: PIPE_A, failed: 5, categories: { dependency: 5 } });
    await seedRollup({ pipelineId: PIPE_B, failed: 1, categories: { dependency: 1 } });
    const rows = (await db.query<Record<string, unknown>>(TOP_BY_CATEGORY, [ORG, FROM, TO, 3])).rows;
    expect(rows[0]).toMatchObject({ category: 'dependency', pipeline_id: PIPE_A, count: 5 });
  });

  it('caps the per-category list', async () => {
    await seedRollup({ pipelineId: PIPE_A, categories: { build: 3 } });
    await seedRollup({ pipelineId: PIPE_B, categories: { build: 2 } });
    expect((await db.query(TOP_BY_CATEGORY, [ORG, FROM, TO, 1])).rows).toHaveLength(1);
  });
});

// ── Resource consumption ────────────────────────────────────────────────────

const RESOURCES = `
  SELECT p.project, r.pipeline_id, p.pipeline_name,
         SUM(r.build_seconds)::int AS build_seconds, SUM(r.runs)::int AS runs
  FROM execution_daily_rollups r
  LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
  WHERE r.org_id = $1 AND r.day >= $2::timestamptz AND r.day < $3::timestamptz
    AND r.stage_name = ''
  GROUP BY p.project, r.pipeline_id, p.pipeline_name
  ORDER BY build_seconds DESC
  LIMIT $4
`;

describe('resource consumption', () => {
  it('totals build seconds per pipeline, biggest first', async () => {
    await seedRollup({ pipelineId: PIPE_A, buildSeconds: 100 });
    await seedRollup({ pipelineId: PIPE_B, buildSeconds: 900 });
    const rows = (await db.query<Record<string, unknown>>(RESOURCES, [ORG, FROM, TO, 20])).rows;
    expect(rows[0]).toMatchObject({ pipeline_id: PIPE_B, build_seconds: 900 });
    expect(rows[0]?.project).toBe('api');
  });
});

// ── Promotion view ──────────────────────────────────────────────────────────

const PROMOTION = `
  SELECT commit_sha, environment, MIN(deployed_at) AS deployed_at
  FROM dora_deployments
  WHERE org_id = $1 AND deployed_at >= $2::timestamptz AND deployed_at < $3::timestamptz
    AND succeeded = true AND commit_sha IS NOT NULL
  GROUP BY commit_sha, environment
  ORDER BY MIN(deployed_at) DESC
`;

describe('the promotion view', () => {
  it('collects each commit\'s environments in the order it reached them', async () => {
    const sha = 'a'.repeat(40);
    await seedDeploy({ commit_sha: sha, environment: 'dev', deployed_at: '2026-09-10T08:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'staging', deployed_at: '2026-09-10T10:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T14:00:00Z' });
    const rows = (await db.query<Record<string, unknown>>(PROMOTION, [ORG, FROM, TO])).rows;
    expect(rows).toHaveLength(3);
    const order = rows
      .sort((a, b) => String(a.deployed_at).localeCompare(String(b.deployed_at)))
      .map((r) => r.environment);
    expect(order).toEqual(['dev', 'staging', 'production']);
  });

  /**
   * The number worth reading. A commit that reached staging and stopped is work
   * that is finished and not delivered — invisible to deployment frequency, success
   * rate and lead time, because by all three nothing happened.
   */
  it('shows a commit that stopped short of production', async () => {
    const stuck = 'b'.repeat(40);
    await seedDeploy({ commit_sha: stuck, environment: 'dev' });
    await seedDeploy({ commit_sha: stuck, environment: 'staging' });
    const rows = (await db.query<Record<string, unknown>>(PROMOTION, [ORG, FROM, TO])).rows;
    expect(rows.map((r) => r.environment).sort()).toEqual(['dev', 'staging']);
    expect(rows.some((r) => r.environment === 'production')).toBe(false);
  });

  it('ignores failed deploys and commitless ones', async () => {
    await seedDeploy({ commit_sha: 'c'.repeat(40), succeeded: false });
    await seedDeploy({ commit_sha: null });
    expect((await db.query(PROMOTION, [ORG, FROM, TO])).rows).toEqual([]);
  });

  it('takes the EARLIEST arrival when a commit deployed twice to one environment', async () => {
    const sha = 'd'.repeat(40);
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T10:00:00Z' });
    await seedDeploy({ commit_sha: sha, environment: 'production', deployed_at: '2026-09-10T18:00:00Z' });
    const rows = (await db.query<Record<string, unknown>>(PROMOTION, [ORG, FROM, TO])).rows;
    expect(rows).toHaveLength(1);
    expect(new Date(String(rows[0]?.deployed_at)).toISOString()).toBe('2026-09-10T10:00:00.000Z');
  });
});

// ── Outdated plugins / vulnerabilities ──────────────────────────────────────

const OUTDATED = `
  SELECT r.pipeline_id, p.pipeline_name, r.stage_name, r.step_name,
         COALESCE(r.plugin_publisher || '/', '') || r.plugin_name AS plugin,
         r.resolved_version, r.latest_version, r.version_gap, r.within_policy
  FROM pipeline_plugin_resolution r
  LEFT JOIN pipelines p ON p.id::text = r.pipeline_id
  WHERE r.org_id = $1 AND (r.version_gap IN ('major','minor','patch') OR r.within_policy = false)
  ORDER BY CASE r.version_gap WHEN 'major' THEN 0 WHEN 'minor' THEN 1 WHEN 'patch' THEN 2 ELSE 3 END,
           r.pipeline_id
  LIMIT $2
`;

const seedResolution = (over: Record<string, unknown> = {}) => db.query(
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
);

describe('outdated plugins', () => {
  it('puts the biggest gap first and formats the plugin reference', async () => {
    await seedResolution({ step_name: 'patch-step', version_gap: 'patch' });
    await seedResolution({ step_name: 'major-step', version_gap: 'major' });
    const rows = (await db.query<Record<string, unknown>>(OUTDATED, [ORG, 50])).rows;
    expect(rows[0]).toMatchObject({ version_gap: 'major', plugin: 'acme/trivy' });
  });

  it('omits the publisher prefix for an own-org plugin', async () => {
    await seedResolution({ plugin_publisher: null, plugin_name: 'local-tool' });
    expect((await db.query<Record<string, unknown>>(OUTDATED, [ORG, 50])).rows[0]?.plugin).toBe('local-tool');
  });

  it('includes an up-to-date step that is OUTSIDE the org policy', async () => {
    await seedResolution({ version_gap: 'none', within_policy: false });
    expect((await db.query(OUTDATED, [ORG, 50])).rows).toHaveLength(1);
  });

  it('excludes an up-to-date, in-policy step', async () => {
    await seedResolution({ version_gap: 'none', within_policy: true });
    expect((await db.query(OUTDATED, [ORG, 50])).rows).toEqual([]);
  });

  it('excludes a step whose gap could not be determined', async () => {
    await seedResolution({ version_gap: null, resolved_version: 'latest' });
    expect((await db.query(OUTDATED, [ORG, 50])).rows).toEqual([]);
  });
});

const VULNS = `
  SELECT v.pipeline_id, p.pipeline_name,
         COALESCE(v.plugin_publisher || '/', '') || v.plugin_name AS plugin,
         v.plugin_version, v.source, v.critical_count, v.high_count
  FROM plugin_vuln_exposure v
  LEFT JOIN pipelines p ON p.id::text = v.pipeline_id
  WHERE v.org_id = $1 AND v.fixed_at IS NULL
    AND (v.triage_state NOT IN ('accepted','false_positive')
         OR (v.triage_state = 'accepted' AND v.accepted_until IS NOT NULL AND v.accepted_until <= NOW()))
  ORDER BY v.critical_count DESC, v.high_count DESC
  LIMIT $2
`;

const seedVuln = (over: Record<string, unknown> = {}) => db.query(
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
);

describe('plugin vulnerabilities', () => {
  it('shows open exposures, Criticals first, and says declared vs deployed', async () => {
    await seedVuln({ plugin_version: '1.0.0', critical_count: 0, high_count: 9, source: 'declared' });
    await seedVuln({ plugin_version: '1.1.0', critical_count: 3, high_count: 1, source: 'deployed' });
    const rows = (await db.query<Record<string, unknown>>(VULNS, [ORG, 50])).rows;
    expect(rows[0]).toMatchObject({ critical_count: 3, source: 'deployed' });
    expect(rows[1]).toMatchObject({ high_count: 9, source: 'declared' });
  });

  it('excludes a fixed exposure', async () => {
    await seedVuln({ fixed_at: '2026-09-15T00:00:00Z' });
    expect((await db.query(VULNS, [ORG, 50])).rows).toEqual([]);
  });

  it('excludes a live acceptance and a false positive', async () => {
    await seedVuln({ plugin_version: '1.0.0', triage_state: 'accepted', accepted_until: '2099-01-01T00:00:00Z' });
    await seedVuln({ plugin_version: '1.1.0', triage_state: 'false_positive' });
    expect((await db.query(VULNS, [ORG, 50])).rows).toEqual([]);
  });

  /** An acceptance past its deadline is not an acceptance. */
  it('INCLUDES an acceptance whose deadline has passed', async () => {
    await seedVuln({ triage_state: 'accepted', accepted_until: '2020-01-01T00:00:00Z' });
    expect((await db.query(VULNS, [ORG, 50])).rows).toHaveLength(1);
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────

const ADOPTION = `
  WITH scoped AS (
    SELECT id::text AS id, org_id, creation_source FROM pipelines
    WHERE org_id = ANY($1) AND deleted_at IS NULL
  ),
  active AS (
    SELECT DISTINCT pipeline_id, org_id FROM execution_daily_rollups
    WHERE org_id = ANY($1) AND day >= $2::timestamptz AND day < $3::timestamptz
      AND stage_name = '' AND runs > 0
  ),
  tracked AS (
    SELECT DISTINCT pipeline_id FROM dora_deployments
    WHERE org_id = ANY($1) AND deployed_at >= $2::timestamptz AND deployed_at < $3::timestamptz
  )
  SELECT (SELECT COUNT(*) FROM scoped)::int AS total_pipelines,
         (SELECT COUNT(*) FROM active)::int AS active_pipelines,
         (SELECT COUNT(DISTINCT org_id) FROM active)::int AS active_teams,
         (SELECT COUNT(*) FROM tracked)::int AS deploy_tracked,
         (SELECT COALESCE(jsonb_object_agg(COALESCE(creation_source,'unknown'), n), '{}'::jsonb)
            FROM (SELECT creation_source, COUNT(*)::int AS n FROM scoped GROUP BY creation_source) s
         ) AS by_source
`;

const adoption = (orgs: string[]) => db.query<Record<string, unknown>>(ADOPTION, [orgs, FROM, TO]).then((r) => r.rows[0]);

describe('adoption and coverage', () => {
  it('counts pipelines, active pipelines and creation source', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 5 });
    const r = await adoption([ORG]);
    expect(r).toMatchObject({ total_pipelines: 2, active_pipelines: 1 });
    expect(r?.by_source).toEqual({ template: 1, manual: 1 });
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
    const r = await adoption([ORG]);
    expect(r).toMatchObject({ active_pipelines: 2, deploy_tracked: 1 });
  });

  it('counts the teams that had activity in a rollup', async () => {
    await seedRollup({ orgId: ORG, pipelineId: PIPE_A, runs: 1 });
    await seedRollup({ orgId: TEAM, pipelineId: PIPE_TEAM, runs: 1 });
    const r = await adoption([ORG, TEAM]);
    expect(r).toMatchObject({ active_teams: 2, total_pipelines: 3 });
  });

  it('does not count a dormant pipeline as active', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 0 });
    expect((await adoption([ORG]))?.active_pipelines).toBe(0);
  });

  it('reports an empty source map rather than null for an org with no pipelines', async () => {
    expect((await adoption(['org-nobody']))?.by_source).toEqual({});
  });
});

// ── Needs-attention inputs ──────────────────────────────────────────────────
//
// These three queries feed the section that DECIDES rather than describes, so a wrong
// answer here becomes a confident, wrong flag in front of a manager. Each statement is
// executed, and a drift guard below checks the module still contains the same SQL — the
// copies in this file would otherwise be free to diverge from the code they stand for.

const STREAKS = `
    WITH days AS (
      SELECT pipeline_id, day,
             SUM(succeeded)::int AS succeeded,
             SUM(failed)::int    AS failed
      FROM execution_daily_rollups
      WHERE org_id = $1
        AND day >= $2::timestamptz AND day < $3::timestamptz
      GROUP BY pipeline_id, day
    ),
    last_ok AS (
      SELECT pipeline_id, MAX(day) AS last_success_day
      FROM days WHERE succeeded > 0
      GROUP BY pipeline_id
    )
    SELECT d.pipeline_id,
           l.last_success_day,
           COALESCE(SUM(d.failed) FILTER (
             WHERE l.last_success_day IS NULL OR d.day > l.last_success_day
           ), 0)::int AS streak
    FROM days d
    LEFT JOIN last_ok l ON l.pipeline_id = d.pipeline_id
    GROUP BY d.pipeline_id, l.last_success_day
`;

const UNTRACKED = `
    WITH active AS (
      SELECT pipeline_id
      FROM execution_daily_rollups
      WHERE org_id = $1
        AND day >= $2::timestamptz AND day < $3::timestamptz
        AND stage_name = ''
      GROUP BY pipeline_id
      HAVING SUM(runs) > 0
    ),
    tracked AS (
      SELECT DISTINCT pipeline_id
      FROM dora_deployments
      WHERE org_id = $1
        AND deployed_at >= $2::timestamptz AND deployed_at < $3::timestamptz
    )
    SELECT a.pipeline_id FROM active a
    WHERE NOT EXISTS (SELECT 1 FROM tracked t WHERE t.pipeline_id = a.pipeline_id)
`;

const VULNERABLE = `
    SELECT DISTINCT pipeline_id
    FROM plugin_vuln_exposure
    WHERE org_id = $1
      AND fixed_at IS NULL
      AND critical_count > 0
      AND triage_state <> 'accepted'
`;

const streaks = async (from = '2026-07-01T00:00:00Z') =>
  (await db.query<{ pipeline_id: string; last_success_day: Date | null; streak: number }>(
    STREAKS, [ORG, from, TO],
  )).rows;

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
  await db.query(
    `INSERT INTO plugin_vuln_exposure
       (id, org_id, pipeline_id, plugin_name, plugin_version, source,
        critical_count, high_count, triage_state, fixed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    Object.values(row),
  );
}

describe('failure streaks', () => {
  it('counts the trailing run of days on which nothing succeeded', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 5, succeeded: 5, failed: 0 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    await seedRollup({ day: '2026-09-12T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    const rows = await streaks();
    expect(rows[0]?.streak).toBe(4);
    expect(new Date(String(rows[0]?.last_success_day)).toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('EXCLUDES the day of the last success, so the count is a true lower bound', async () => {
    // The rollup is per day, so within a day that had a success there is no way to tell
    // whether the failures came before or after it. Counting them would let the evidence
    // claim a run of failures that a success sat in the middle of.
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 4, succeeded: 1, failed: 3 });
    expect((await streaks())[0]?.streak).toBe(0);
  });

  it('counts every failure when a pipeline has never succeeded in the lookback', async () => {
    await seedRollup({ day: '2026-09-10T00:00:00Z', runs: 3, succeeded: 0, failed: 3 });
    await seedRollup({ day: '2026-09-11T00:00:00Z', runs: 1, succeeded: 0, failed: 1 });
    const row = (await streaks())[0];
    expect(row?.streak).toBe(4);
    // Null rather than a date, which is what makes rule 4 say "no successful run in this
    // period" instead of an age nobody can compute.
    expect(row?.last_success_day).toBeNull();
  });

  it('reads PAST the report window, so "last succeeded 40 days ago" is answerable', async () => {
    await seedRollup({ day: '2026-08-01T00:00:00Z', runs: 2, succeeded: 2, failed: 0 });
    await seedRollup({ day: '2026-09-20T00:00:00Z', runs: 2, succeeded: 0, failed: 2 });
    // A query bounded by the report's own 30-day window could never produce this.
    const row = (await streaks('2026-07-01T00:00:00Z'))[0];
    expect(new Date(String(row?.last_success_day)).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns nothing for an org with no rollup rows', async () => {
    expect(await streaks()).toEqual([]);
  });
});

describe('untracked pipelines', () => {
  it('names a pipeline that RAN and produced no deploy rows', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 4 });
    const rows = (await db.query<{ pipeline_id: string }>(UNTRACKED, [ORG, FROM, TO])).rows;
    // A measurement gap, not a failure, and the reason a deployment-frequency number can
    // be quietly wrong. Nothing else in the report would say so.
    expect(rows.map((r) => r.pipeline_id)).toEqual([PIPE_A]);
  });

  it('does not name a pipeline that deployed', async () => {
    await seedRollup({ pipelineId: PIPE_A, runs: 4 });
    await seedDeploy({ pipeline_id: PIPE_A });
    expect((await db.query(UNTRACKED, [ORG, FROM, TO])).rows).toEqual([]);
  });

  it('does not name a DORMANT pipeline', async () => {
    // Zero runs is not a measurement gap — there was nothing to measure.
    await seedRollup({ pipelineId: PIPE_A, runs: 0 });
    expect((await db.query(UNTRACKED, [ORG, FROM, TO])).rows).toEqual([]);
  });

  it('reads the pipeline grain only, so a stage row cannot make one look active', async () => {
    await seedRollup({ pipelineId: PIPE_A, stageName: 'Build', runs: 9 });
    expect((await db.query(UNTRACKED, [ORG, FROM, TO])).rows).toEqual([]);
  });
});

describe('vulnerable pipelines', () => {
  it('names a pipeline with an open Critical exposure', async () => {
    await seedExposure();
    const rows = (await db.query<{ pipeline_id: string }>(VULNERABLE, [ORG])).rows;
    expect(rows.map((r) => r.pipeline_id)).toEqual([PIPE_A]);
  });

  it('does not name one whose exposure is FIXED', async () => {
    await seedExposure({ fixed_at: '2026-09-15T00:00:00Z' });
    // Point-in-time, not windowed: a Critical that was open last Tuesday and is fixed
    // today is not something to put in front of a manager.
    expect((await db.query(VULNERABLE, [ORG])).rows).toEqual([]);
  });

  it('does not name one whose exposure was ACCEPTED', async () => {
    await seedExposure({ triage_state: 'accepted' });
    // Someone with the authority to accept a risk already decided about it in writing,
    // with a reason and a deadline. Re-raising it weekly teaches the reader to skip the
    // section; the LAPSE of that acceptance is a separate finding.
    expect((await db.query(VULNERABLE, [ORG])).rows).toEqual([]);
  });

  it('ignores High-only findings', async () => {
    await seedExposure({ critical_count: 0, high_count: 5 });
    expect((await db.query(VULNERABLE, [ORG])).rows).toEqual([]);
  });

  it('does not cross org boundaries', async () => {
    await seedExposure({ org_id: TEAM, pipeline_id: PIPE_TEAM });
    expect((await db.query(VULNERABLE, [ORG])).rows).toEqual([]);
  });
});

describe('the SQL in this file matches the module', () => {
  /**
   * A drift guard, because the statements above are COPIES.
   *
   * The module builds its SQL through a tagged template with interpolated bind
   * fragments, so it cannot be handed straight to PGlite — which is why these copies
   * exist at all. Without this test they would be free to drift, and then these tests
   * would be proving that a string in a test file runs.
   */
  it('contains each executed statement\'s distinctive lines', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/api/reporting/analytics-queries.ts', import.meta.url), 'utf8');
    const distinctive = [
      'COALESCE(SUM(d.failed) FILTER (',
      'LEFT JOIN last_ok l ON l.pipeline_id = d.pipeline_id',
      'WHERE NOT EXISTS (SELECT 1 FROM tracked t WHERE t.pipeline_id = a.pipeline_id)',
      "AND triage_state <> 'accepted'",
    ];
    for (const line of distinctive) expect(src).toContain(line);
  });
});
