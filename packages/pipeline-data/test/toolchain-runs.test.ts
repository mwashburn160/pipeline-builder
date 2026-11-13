// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toolchain run data (docs/plans/bootstrap-image-versioning.md §6, §7, §9):
 *
 *  - the PURE canary gate (N runs, M orgs, T points, per-org cap ceil(N/M));
 *  - recorded CodePipeline Action events REPLAYED through the real ingest
 *    against the shipped `postgres-init.sql` (PGlite): the synth /
 *    self-mutation rows are stamped with the release from the SEEDED platform
 *    manifest — never from a payload field or anything tag-derived;
 *  - the gate and Affected-view reads over those stamped rows.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/pglite';
import { bootInitDb } from './helpers/pglite-init.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

// The ingest's transactions run on PGlite as the superuser (the route runs the
// ingest elevated; RLS is exercised by rls-integration.test.ts). Cache
// invalidation is fire-and-forget and talks to nothing here.
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn(db),
  withTenantTxRead: (fn: (tx: unknown) => unknown) => fn(db),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('../src/api/reporting/caches.js', () => ({
  invalidateOrgReports: async () => undefined,
}));

const { ingestEvents } = await import('../src/api/reporting/ingest.js');
const {
  canaryPerOrgCap, deployedToolchainOf, evaluateCanaryGate, readAffectedPipelines, readCanaryGate,
  toolchainActionOf, DEFAULT_CANARY_GATE,
} = await import('../src/api/reporting/toolchain-runs.js');
type IngestMetric = import('../src/api/reporting/types.js').IngestMetric;
type IngestEvent = import('../src/api/reporting/types.js').IngestEvent;
type ToolchainOutcome = import('../src/api/reporting/toolchain-runs.js').ToolchainOutcome;

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
}, 120_000);
afterAll(async () => { await pg?.close(); });

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const ORG_C = 'ccccccccccccccccccccccc1';

// -----------------------------------------------------------------------------
// The pure gate
// -----------------------------------------------------------------------------

const runs = (succeeded: number, failed = 0): ToolchainOutcome[] =>
  [...Array<ToolchainOutcome>(failed).fill('failed'), ...Array<ToolchainOutcome>(succeeded).fill('succeeded')];

describe('evaluateCanaryGate (pure)', () => {
  const baseline = { releaseVersion: '1.0.0', runs: 100, failures: 2 }; // 2%

  it('defaults to N=20, M=2, T=5, and caps each org at ceil(N/M)', () => {
    expect(DEFAULT_CANARY_GATE).toEqual({ minRuns: 20, minOrgs: 2, maxFailurePointsAboveDefault: 5 });
    expect(canaryPerOrgCap(DEFAULT_CANARY_GATE)).toBe(10);
    expect(canaryPerOrgCap({ minRuns: 21, minOrgs: 2 })).toBe(11);
    expect(canaryPerOrgCap({ minRuns: 20, minOrgs: 3 })).toBe(7);
  });

  it('opens at exactly N runs across M orgs within T points', () => {
    const r = evaluateCanaryGate({ releaseVersion: '1.1.0', candidate: [{ orgId: ORG_A, outcomes: runs(10) }, { orgId: ORG_B, outcomes: runs(10) }], baseline });
    expect(r).toMatchObject({ passed: true, countedRuns: 20, orgs: 2, failureRate: 0, baselineFailureRate: 2, pointsAboveDefault: -2, shortfalls: [] });
  });

  it('stays closed one run short of N', () => {
    const r = evaluateCanaryGate({ releaseVersion: '1.1.0', candidate: [{ orgId: ORG_A, outcomes: runs(10) }, { orgId: ORG_B, outcomes: runs(9) }], baseline });
    expect(r).toMatchObject({ passed: false, countedRuns: 19, shortfalls: ['runs'] });
  });

  it('one org cannot satisfy N alone: it counts for ceil(N/M) runs only', () => {
    const r = evaluateCanaryGate({ releaseVersion: '1.1.0', candidate: [{ orgId: ORG_A, outcomes: runs(500) }], baseline });
    expect(r).toMatchObject({ passed: false, perOrgCap: 10, countedRuns: 10, totalRuns: 500, orgs: 1, shortfalls: ['runs', 'orgs'] });
  });

  it('a big org plus a token second org is still short of N (the cap binds)', () => {
    const r = evaluateCanaryGate({ releaseVersion: '1.1.0', candidate: [{ orgId: ORG_A, outcomes: runs(500) }, { orgId: ORG_B, outcomes: runs(1) }], baseline });
    expect(r).toMatchObject({ passed: false, countedRuns: 11, orgs: 2, shortfalls: ['runs'] });
  });

  it('stays closed when the failure rate is more than T points above the default', () => {
    // 2/20 = 10% vs 2% → 8 points.
    const r = evaluateCanaryGate({
      releaseVersion: '1.1.0',
      candidate: [{ orgId: ORG_A, outcomes: runs(9, 1) }, { orgId: ORG_B, outcomes: runs(9, 1) }],
      baseline,
    });
    expect(r).toMatchObject({ passed: false, failures: 2, failureRate: 10, pointsAboveDefault: 8, shortfalls: ['failure-rate'] });
  });

  it('opens at exactly T points above the default', () => {
    // 1/20 = 5% vs 0% → 5 points.
    const r = evaluateCanaryGate({
      releaseVersion: '1.1.0',
      candidate: [{ orgId: ORG_A, outcomes: runs(9, 1) }, { orgId: ORG_B, outcomes: runs(10) }],
      baseline: { releaseVersion: '1.0.0', runs: 50, failures: 0 },
    });
    expect(r).toMatchObject({ passed: true, pointsAboveDefault: 5 });
  });

  it('judges the failure rate over the CAPPED runs, newest first — a flood of old outcomes cannot move it', () => {
    // ORG_A's newest 10 are clean; 90 older failures are past the cap.
    const r = evaluateCanaryGate({
      releaseVersion: '1.1.0',
      candidate: [{ orgId: ORG_A, outcomes: [...runs(10), ...Array<ToolchainOutcome>(90).fill('failed')] }, { orgId: ORG_B, outcomes: runs(10) }],
      baseline,
    });
    expect(r).toMatchObject({ passed: true, failures: 0, countedRuns: 20, totalRuns: 110 });
  });

  it('with no default runs in the window, the baseline is 0% (the strict reading)', () => {
    const r = evaluateCanaryGate({
      releaseVersion: '1.1.0',
      candidate: [{ orgId: ORG_A, outcomes: runs(8, 2) }, { orgId: ORG_B, outcomes: runs(10) }],
      baseline: { releaseVersion: '1.0.0', runs: 0, failures: 0 },
    });
    expect(r).toMatchObject({ passed: false, baselineRuns: 0, baselineFailureRate: 0, pointsAboveDefault: 10 });
  });

  it('takes console-set thresholds (Phase 5)', () => {
    const r = evaluateCanaryGate({
      releaseVersion: '1.1.0',
      candidate: [{ orgId: ORG_A, outcomes: runs(2) }, { orgId: ORG_B, outcomes: runs(2) }, { orgId: ORG_C, outcomes: runs(2) }],
      baseline,
      params: { minRuns: 6, minOrgs: 3 },
    });
    expect(r).toMatchObject({ passed: true, perOrgCap: 2, params: { minRuns: 6, minOrgs: 3, maxFailurePointsAboveDefault: 5 } });
  });

  it('with no runs at all, every threshold is short and the rate is unknown', () => {
    const r = evaluateCanaryGate({ releaseVersion: '1.1.0', candidate: [], baseline });
    expect(r).toMatchObject({ passed: false, countedRuns: 0, failureRate: null, pointsAboveDefault: null, shortfalls: ['runs', 'orgs', 'failure-rate'] });
  });
});

describe('deployed toolchain + action identification (pure)', () => {
  const synthRow = { pipelineId: 'p', orgId: ORG_A, stageName: 'Build', actionName: 'cdk-synth-abc', pluginPublisher: null, pluginName: 'cdk-synth', pluginVersion: '1.1.0', stepKey: 'synth' };
  const buildImage = { pipelineId: 'p', orgId: ORG_A, stageName: '(toolchain)', actionName: 'build-image', pluginPublisher: null, pluginName: 'pipeline-bootstrap', pluginVersion: '1.1.0', stepKey: 'build-image' };

  it('takes the release from the build-image entry only', () => {
    expect(deployedToolchainOf([synthRow, buildImage]).get('p')).toEqual({ orgId: ORG_A, releaseVersion: '1.1.0', synth: { stageName: 'Build', actionName: 'cdk-synth-abc' } });
    // The synth row alone names no release (a custom synth plugin could be named anything).
    expect(deployedToolchainOf([synthRow]).size).toBe(0);
    // A listing can never be the bootstrap; a non-release version is not a release.
    expect(deployedToolchainOf([{ ...buildImage, pluginPublisher: 'acme' }]).size).toBe(0);
    expect(deployedToolchainOf([{ ...buildImage, pluginVersion: '1.1.0-dev' }]).size).toBe(0);
  });

  it('identifies the synth action by the manifest, and self-mutation by CDK’s fixed names', () => {
    const d = deployedToolchainOf([synthRow, buildImage]).get('p');
    expect(toolchainActionOf({ eventType: 'ACTION', stageName: 'Build', actionName: 'cdk-synth-abc' }, d)).toBe('synth');
    expect(toolchainActionOf({ eventType: 'ACTION', stageName: 'UpdatePipeline', actionName: 'SelfMutate' }, d)).toBe('self-mutation');
    expect(toolchainActionOf({ eventType: 'STAGE', stageName: 'Build', actionName: 'cdk-synth-abc' }, d)).toBeNull();
    expect(toolchainActionOf({ eventType: 'ACTION', stageName: 'Build', actionName: 'jest' }, d)).toBeNull();
    expect(toolchainActionOf({ eventType: 'ACTION', stageName: 'UpdatePipeline', actionName: 'SelfMutate' }, undefined)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Replayed CodePipeline payloads → the real ingest → PGlite
// -----------------------------------------------------------------------------

/**
 * Recorded EventBridge "CodePipeline Action Execution State Change" events, as
 * AWS delivers them (account/region/ARNs included), for the synth, self-mutation
 * and an ordinary step. Each also carries everything a customer could use to
 * claim a release: a `toolchainRelease` field in detail, a
 * `pb.toolchain-release` style tag value, and a release-looking string in the
 * failure summary.
 */
function recorded(opts: { pipelineName: string; executionId: string; stage: string; action: string; state: 'STARTED' | 'SUCCEEDED' | 'FAILED'; at: string }) {
  return {
    'version': '0',
    'id': randomUUID(),
    'detail-type': 'CodePipeline Action Execution State Change',
    'source': 'aws.codepipeline',
    'account': '123456789012',
    'time': opts.at,
    'region': 'us-east-1',
    'resources': [`arn:aws:codepipeline:us-east-1:123456789012:${opts.pipelineName}`],
    'detail': {
      'pipeline': opts.pipelineName,
      'execution-id': opts.executionId,
      'stage': opts.stage,
      'action': opts.action,
      'state': opts.state,
      'region': 'us-east-1',
      'type': { owner: 'AWS', provider: 'CodeBuild', category: 'Build', version: '1' },
      'version': 3,
      'pipeline-execution-attempt': 1,
      // Customer-controlled claims the stamp must ignore.
      'toolchainRelease': '9.9.9',
      'tags': { 'pb.toolchain-release': '9.9.9' },
      ...(opts.state === 'FAILED' ? { 'execution-result': { 'external-execution-summary': 'toolchain 9.9.9 failed: exit status 1' } } : {}),
    },
  };
}

/**
 * The normalization pipeline-events applies (src/parse.ts): detail.stage →
 * stageName, detail.action → actionName, detail.state → status, the summary →
 * errorMessage, the EventBridge id → sourceEventId. The pipeline id is what the
 * Lambda read from the pipeline's `pb.pipeline-id` tag; the payload ALSO carries
 * a forged `toolchainRelease` the ingest schema doesn't know.
 */
function toIngestEvent(pipelineId: string, ev: ReturnType<typeof recorded>): IngestEvent {
  const d = ev.detail as Record<string, unknown>;
  const summary = (d['execution-result'] as { 'external-execution-summary'?: string } | undefined)?.['external-execution-summary'];
  return {
    pipelineId,
    eventSource: 'codepipeline',
    eventType: 'ACTION',
    status: d.state as string,
    executionId: d['execution-id'] as string,
    stageName: d.stage as string,
    actionName: d.action as string,
    ...(summary ? { errorMessage: summary } : {}),
    ...(d.state !== 'STARTED' ? { completedAt: ev.time } : {}),
    sourceEventId: ev.id,
    detail: d,
    toolchainRelease: '9.9.9',
  } as IngestEvent;
}

async function seedPipeline(orgId: string, release: string | null, opts: { synthAction?: string } = {}): Promise<string> {
  const pipelineId = randomUUID();
  await pg.query('INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name) VALUES ($1, $2, $3)', [pipelineId, orgId, `p-${pipelineId.slice(0, 6)}`]);
  const synthAction = opts.synthAction ?? 'cdk-synth-0a1b2c';
  await pg.query(
    `INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version, step_key)
     VALUES ($1, $2, 'Build', $3, 'cdk-synth', $4, 'synth')`, [pipelineId, orgId, synthAction, release ?? '1.0.0']);
  if (release) {
    await pg.query(
      `INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version, step_key, resolved_via)
       VALUES ($1, $2, '(toolchain)', 'build-image', 'pipeline-bootstrap', $3, 'build-image', 'canary')`, [pipelineId, orgId, release]);
  }
  return pipelineId;
}

async function releaseRow(version: string, createdAt = '2026-01-01T00:00:00Z'): Promise<void> {
  await pg.query('INSERT INTO toolchain_release (release_version, created_by, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [version, 'test', createdAt]);
}

async function stamped(pipelineId: string): Promise<Array<{ stage_name: string; action_name: string; status: string; toolchain_release: string | null }>> {
  const r = await pg.query<{ stage_name: string; action_name: string; status: string; toolchain_release: string | null }>(
    'SELECT stage_name, action_name, status, toolchain_release FROM pipeline_events WHERE pipeline_id = $1 ORDER BY stage_name, action_name, status', [pipelineId]);
  return r.rows;
}

/** Ingest `n` synth outcomes for a pipeline (distinct executions). */
async function synthRuns(pipelineId: string, outcomes: ToolchainOutcome[], startMinute = 0): Promise<void> {
  const events = outcomes.map((o, i) => toIngestEvent(pipelineId, recorded({
    pipelineName: 'p',
    executionId: randomUUID(),
    stage: 'Build',
    action: 'cdk-synth-0a1b2c',
    state: o === 'failed' ? 'FAILED' : 'SUCCEEDED',
    at: new Date(Date.UTC(2026, 5, 1, 0, startMinute + i)).toISOString(),
  })));
  for (let i = 0; i < events.length; i += 100) await ingestEvents(events.slice(i, i + 100));
}

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM pipeline_events; DELETE FROM pipeline_step_manifests; DELETE FROM pipeline_registry;
    DELETE FROM dora_deployments;
    DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history; DELETE FROM toolchain_release;
  `);
});

describe('ingest stamps the release from the PLATFORM manifest', () => {
  it('stamps synth and self-mutation from the seeded manifest, never from the payload', async () => {
    await releaseRow('1.1.0');
    const pipelineId = await seedPipeline(ORG_A, '1.1.0');
    const exec = randomUUID();
    const at = '2026-06-01T10:00:00Z';
    const metrics: IngestMetric[] = [];
    await ingestEvents([
      recorded({ pipelineName: 'acme', executionId: exec, stage: 'Build', action: 'cdk-synth-0a1b2c', state: 'STARTED', at }),
      recorded({ pipelineName: 'acme', executionId: exec, stage: 'Build', action: 'cdk-synth-0a1b2c', state: 'FAILED', at }),
      recorded({ pipelineName: 'acme', executionId: exec, stage: 'UpdatePipeline', action: 'SelfMutate', state: 'SUCCEEDED', at }),
      recorded({ pipelineName: 'acme', executionId: exec, stage: 'Test', action: 'jest', state: 'SUCCEEDED', at }),
    ].map((e) => toIngestEvent(pipelineId, e)), (m) => metrics.push(m));

    expect(await stamped(pipelineId)).toEqual([
      { stage_name: 'Build', action_name: 'cdk-synth-0a1b2c', status: 'FAILED', toolchain_release: '1.1.0' },
      { stage_name: 'Build', action_name: 'cdk-synth-0a1b2c', status: 'STARTED', toolchain_release: '1.1.0' },
      // An ordinary step is never a toolchain run.
      { stage_name: 'Test', action_name: 'jest', status: 'SUCCEEDED', toolchain_release: null },
      { stage_name: 'UpdatePipeline', action_name: 'SelfMutate', status: 'SUCCEEDED', toolchain_release: '1.1.0' },
    ]);
    // The forged 9.9.9 appears nowhere a reader uses.
    const forged = await pg.query("SELECT count(*)::int AS n FROM pipeline_events WHERE toolchain_release = '9.9.9'");
    expect(forged.rows).toEqual([{ n: 0 }]);

    // Metric: terminal outcomes only, labelled from the stamp.
    expect(metrics.filter((m) => m.kind === 'toolchain')).toEqual([
      { kind: 'toolchain', toolchainRelease: '1.1.0', action: 'synth', outcome: 'failed', platformDefaultRelease: null },
      { kind: 'toolchain', toolchainRelease: '1.1.0', action: 'self-mutation', outcome: 'succeeded', platformDefaultRelease: null },
    ]);
  });

  it('follows the manifest when the pipeline is redeployed on another release', async () => {
    await releaseRow('1.0.0');
    await releaseRow('1.1.0');
    const pipelineId = await seedPipeline(ORG_A, '1.0.0');
    await synthRuns(pipelineId, ['succeeded']);
    await pg.query("UPDATE pipeline_step_manifests SET plugin_version = '1.1.0' WHERE pipeline_id = $1", [pipelineId]);
    await synthRuns(pipelineId, ['failed'], 10);
    const r = await pg.query<{ status: string; toolchain_release: string }>('SELECT status, toolchain_release FROM pipeline_events WHERE pipeline_id = $1 ORDER BY completed_at', [pipelineId]);
    expect(r.rows).toEqual([{ status: 'SUCCEEDED', toolchain_release: '1.0.0' }, { status: 'FAILED', toolchain_release: '1.1.0' }]);
  });

  it('stamps nothing for a pipeline whose manifest records no build-image entry', async () => {
    const pipelineId = await seedPipeline(ORG_A, null);
    await synthRuns(pipelineId, ['failed']);
    expect((await stamped(pipelineId)).map((r) => r.toolchain_release)).toEqual([null]);
  });

  it('ignores a build-image row whose org differs from the registry-resolved org', async () => {
    const pipelineId = await seedPipeline(ORG_A, '1.1.0');
    await pg.query("UPDATE pipeline_step_manifests SET org_id = $1 WHERE pipeline_id = $2 AND step_key = 'build-image'", [ORG_B, pipelineId]);
    await synthRuns(pipelineId, ['failed']);
    expect((await stamped(pipelineId)).map((r) => r.toolchain_release)).toEqual([null]);
  });

  it('carries the platform default on the metric for the alert baseline', async () => {
    await releaseRow('1.0.0');
    await pg.query("INSERT INTO toolchain_platform_default (release_version, set_by) VALUES ('1.0.0', 'test')");
    const pipelineId = await seedPipeline(ORG_A, '1.0.0');
    const metrics: IngestMetric[] = [];
    await ingestEvents([toIngestEvent(pipelineId, recorded({ pipelineName: 'p', executionId: randomUUID(), stage: 'Build', action: 'cdk-synth-0a1b2c', state: 'SUCCEEDED', at: '2026-06-01T00:00:00Z' }))], (m) => metrics.push(m));
    expect(metrics.find((m) => m.kind === 'toolchain')).toEqual({ kind: 'toolchain', toolchainRelease: '1.0.0', action: 'synth', outcome: 'succeeded', platformDefaultRelease: '1.0.0' });
  });
});

describe('readCanaryGate over stamped rows', () => {
  async function canaryWorld(): Promise<{ a: string; b: string; base: string }> {
    await releaseRow('1.0.0', '2025-01-01T00:00:00Z');
    await releaseRow('1.1.0', '2026-01-01T00:00:00Z');
    const base = await seedPipeline(ORG_C, '1.0.0');
    await synthRuns(base, runs(48, 2)); // default: 4%
    return { a: await seedPipeline(ORG_A, '1.1.0'), b: await seedPipeline(ORG_B, '1.1.0'), base };
  }

  it('opens only at N runs across M orgs within T points of the default', async () => {
    const { a, b } = await canaryWorld();
    await synthRuns(a, runs(10));
    await synthRuns(b, runs(9));
    const short = await readCanaryGate(db, '1.1.0', '1.0.0');
    expect(short).toMatchObject({ passed: false, countedRuns: 19, orgs: 2, baselineRuns: 50, baselineFailureRate: 4, shortfalls: ['runs'] });

    await synthRuns(b, runs(1), 30);
    expect(await readCanaryGate(db, '1.1.0', '1.0.0')).toMatchObject({ passed: true, countedRuns: 20, failureRate: 0, pointsAboveDefault: -4 });
  });

  it('one org cannot satisfy N alone (the per-org cap), however many runs it reports', async () => {
    const { a } = await canaryWorld();
    await synthRuns(a, runs(200));
    expect(await readCanaryGate(db, '1.1.0', '1.0.0')).toMatchObject({ passed: false, perOrgCap: 10, countedRuns: 10, totalRuns: 200, orgs: 1, shortfalls: ['runs', 'orgs'] });
  });

  it('closes on a failure rate more than T points over the default', async () => {
    const { a, b } = await canaryWorld();
    await synthRuns(a, runs(8, 2));
    await synthRuns(b, runs(10));
    // 2/20 = 10% vs 4% → 6 points.
    expect(await readCanaryGate(db, '1.1.0', '1.0.0')).toMatchObject({ passed: false, failureRate: 10, pointsAboveDefault: 6, shortfalls: ['failure-rate'] });
  });

  it('counts terminal SYNTH runs only — self-mutation and STARTED rows do not count', async () => {
    const { a, b } = await canaryWorld();
    const at = '2026-06-02T00:00:00Z';
    for (const p of [a, b]) {
      const evs = Array.from({ length: 10 }, () => randomUUID()).flatMap((exec) => [
        recorded({ pipelineName: 'p', executionId: exec, stage: 'Build', action: 'cdk-synth-0a1b2c', state: 'STARTED', at }),
        recorded({ pipelineName: 'p', executionId: exec, stage: 'UpdatePipeline', action: 'SelfMutate', state: 'FAILED', at }),
      ]).map((e) => toIngestEvent(p, e));
      await ingestEvents(evs);
    }
    expect(await readCanaryGate(db, '1.1.0', '1.0.0')).toMatchObject({ passed: false, countedRuns: 0, totalRuns: 0 });
  });

  it('only counts runs since the release was registered', async () => {
    const { a, b } = await canaryWorld();
    await synthRuns(a, runs(10));
    await synthRuns(b, runs(10));
    await pg.query("UPDATE toolchain_release SET created_at = now() + interval '1 day' WHERE release_version = '1.1.0'");
    expect(await readCanaryGate(db, '1.1.0', '1.0.0')).toMatchObject({ passed: false, countedRuns: 0, baselineRuns: 0 });
  });
});

describe('readAffectedPipelines', () => {
  it('lists pipelines deployed on R whose LATEST synth failed, grouped by org', async () => {
    await releaseRow('1.1.0');
    const failedA1 = await seedPipeline(ORG_A, '1.1.0');
    const failedA2 = await seedPipeline(ORG_A, '1.1.0');
    const healed = await seedPipeline(ORG_A, '1.1.0');
    const failedB = await seedPipeline(ORG_B, '1.1.0');
    const otherRelease = await seedPipeline(ORG_B, '1.0.0');
    const neverRan = await seedPipeline(ORG_C, '1.1.0');
    void neverRan;

    await synthRuns(failedA1, ['succeeded', 'failed']);
    await synthRuns(failedA2, ['failed']);
    await synthRuns(healed, ['failed', 'succeeded']);
    await synthRuns(failedB, ['failed']);
    await synthRuns(otherRelease, ['failed']);

    const r = await readAffectedPipelines(db, '1.1.0');
    expect(r.releaseVersion).toBe('1.1.0');
    expect(r.totalPipelines).toBe(3);
    expect(r.orgs).toEqual([
      { orgId: ORG_A, pipelines: 2, pipelineIds: [failedA1, failedA2].sort() },
      { orgId: ORG_B, pipelines: 1, pipelineIds: [failedB] },
    ]);
  });

  it('a self-mutation failure is not a synth failure', async () => {
    await releaseRow('1.1.0');
    const p = await seedPipeline(ORG_A, '1.1.0');
    await synthRuns(p, ['succeeded']);
    await ingestEvents([toIngestEvent(p, recorded({ pipelineName: 'p', executionId: randomUUID(), stage: 'UpdatePipeline', action: 'SelfMutate', state: 'FAILED', at: '2026-06-03T00:00:00Z' }))]);
    expect((await readAffectedPipelines(db, '1.1.0')).totalPipelines).toBe(0);
  });
});
