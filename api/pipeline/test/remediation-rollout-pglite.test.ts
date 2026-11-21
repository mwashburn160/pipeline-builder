// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 3 of the nightly plugin CVE remediation (helpers/remediation-rollout.ts)
 * against a REAL Postgres (PGlite + the shipped init script, as the app role
 * under RLS): who is proposed / queued / skipped, the per-pipeline election
 * (pipeline → team → root, re-read just before each move), canary then batch
 * waves, rollback detection through the stored step-to-plugin mapping, the
 * live-only / KEV-safe rollback target, the two-rollback pause, unhealthy
 * runners, cancel and the idempotent start.
 *
 * The move itself (the plugin-upgrades apply path) and the step plan are fakes
 * here — their own suites cover them; everything the engine reads or writes in
 * SQL is real.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
// The apply path and the contract resolver have their own suites; the engine reaches them only through deps.
jest.unstable_mockModule('../src/helpers/plugin-upgrade-apply.js', () => ({
  applyUpgradeToPipeline: jest.fn(), redeployPipeline: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  recordPipelineResolution: jest.fn(), resolveContractPlugin: jest.fn(),
}));

const engineModule = await import('../src/helpers/remediation-rollout.js');
const { createRolloutEngine, checkRollbackTarget, loadRows, summarize, runStates } = engineModule;
type MovePlan = import('../src/helpers/remediation-rollout.js').MovePlan;
type RolloutDeps = import('../src/helpers/remediation-rollout.js').RolloutDeps;
const { readOrgRolloutSettings, electionRefusal } = await import('../src/helpers/remediation-settings.js');
const { pipelineService } = await import('../src/services/pipeline-service.js');
const { runWithTenantContext } = await import('@pipeline-builder/pipeline-data');
const { setRunnerDepsForTesting } = await import('../src/runners/deps.js');

process.env.JWT_SECRET ||= 'remediation-rollout-test-secret';

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const TEAM = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = 'cccccccccccccccccccccccc';
const PLUGIN = 'trivy';
const FROM = '1.4.2';
const TO = '1.4.3';

let clock = new Date('2026-11-20T12:00:00Z');
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

const plans = new Map<string, MovePlan>();
const moveCalls: Array<{ pipelineId: string; rollback: boolean; actor: string }> = [];
const moveFailures = new Set<string>();
const reports: Array<{ remediationId: string; body: any }> = [];
const changeRequests: string[] = [];
/** What each retried redeploy answers, in order (default: started). */
const redeployOutcomes: Array<'ok' | 'fail'> = [];
const redeployCalls: string[] = [];
/** Per pipeline: the move answers ok with no run (its redeploy did not start). */
const redeployFailsOnMove = new Set<string>();
/** Per pipeline: the move refuses because its install has another change pending. */
const installPendingOnMove = new Set<string>();
let rollbackTarget: Awaited<ReturnType<RolloutDeps['rollbackTarget']>> = { ok: true };

const STEP_PIN: MovePlan = { kind: 'step_pin', steps: [{ stepKey: 'Build/trivy' } as never], install: null };

const deps: RolloutDeps = {
  now: () => clock,
  settings: (orgId, rootOrgId) => readOrgRolloutSettings(orgId, rootOrgId),
  plan: async (pipeline) => plans.get(pipeline.id) ?? STEP_PIN,
  move: async ({ row, rollback, actor }) => {
    moveCalls.push({ pipelineId: row.pipelineId, rollback: !!rollback, actor: actor.userId });
    if (moveFailures.has(row.pipelineId)) return { ok: false, error: 'Compliance blocked: rule r1' };
    if (installPendingOnMove.has(row.pipelineId)) return { ok: false, error: 'install_change_pending' };
    if (redeployFailsOnMove.has(row.pipelineId)) return { ok: true, runRequestId: null, note: 'redeploy_failed' };
    const runId = randomUUID();
    await owner((q) => q.query(
      `INSERT INTO pipeline_run_requests (id, org_id, pipeline_id, action, requested_by, expires_at, status, result_execution_id)
       VALUES ($1, $2, $3, 'start', 'system:plugin-remediation', now() + interval '1 day', 'started', $4)`,
      [runId, row.orgId, row.pipelineId, `exec-${row.pipelineId}-${moveCalls.length}`],
    ));
    return { ok: true, runRequestId: runId };
  },
  requestInstallChange: async (install) => { changeRequests.push(install.id); },
  redeploy: async ({ row }) => {
    redeployCalls.push(row.pipelineId);
    if ((redeployOutcomes.shift() ?? 'ok') === 'fail') return { ok: true, runRequestId: null, note: 'redeploy_failed' };
    const runId = randomUUID();
    await owner((q) => q.query(
      `INSERT INTO pipeline_run_requests (id, org_id, pipeline_id, action, requested_by, expires_at, status, result_execution_id)
       VALUES ($1, $2, $3, 'start', 'system:plugin-remediation', now() + interval '1 day', 'started', $4)`,
      [runId, row.orgId, row.pipelineId, `exec-redeploy-${row.pipelineId}`],
    ));
    return { ok: true, runRequestId: runId };
  },
  rollbackTarget: async () => rollbackTarget,
  report: async (remediationId, body) => { reports.push({ remediationId, body }); return 'ok'; },
  // The platform org hierarchy: TEAM is a team under ROOT; OTHER is its own root.
  ancestors: async (orgId) => (orgId === TEAM ? [ROOT] : []),
};

const engine = createRolloutEngine(deps);

/** A live pipeline of `orgId` on `trivy@1.4.2` (a declared resolution row; `root` for a team). */
async function pipelineOn(orgId: string, opts: { election?: string; root?: string; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await owner(async (q) => {
    await q.query(
      `INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props, remediation_upgrades)
       VALUES ($1, $2, 'acme', $3, $4, '{}'::jsonb, $5)`,
      [id, `proj-${id.slice(0, 8)}`, orgId, opts.name ?? `pipe-${id.slice(0, 8)}`, opts.election ?? 'inherit'],
    );
    await q.query(
      `INSERT INTO pipeline_plugin_resolution (org_id, pipeline_id, stage_name, step_name, plugin_name, declared_version, resolved_version, root_org_id)
       VALUES ($1, $2, 'Build', 'trivy', $3, $4, $4, $5)`,
      [orgId, id, PLUGIN, FROM, opts.root ?? null],
    );
  });
  return id;
}

async function settings(orgId: string, values: { rollout?: string | null; allowPipelineApply?: boolean }) {
  await owner((q) => q.query(
    `INSERT INTO plugin_remediation_settings (org_id, rollout, allow_pipeline_apply) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET rollout = EXCLUDED.rollout, allow_pipeline_apply = EXCLUDED.allow_pipeline_apply`,
    [orgId, values.rollout ?? null, values.allowPipelineApply ?? true],
  ));
}

const startBody = (orgId: string | null = ROOT) => ({
  orgId,
  plugin: PLUGIN,
  publisher: null,
  fromVersion: FROM,
  toVersion: TO,
  toPluginId: randomUUID(),
  advisoryIds: ['CVE-2026-0001'],
  criticalCleared: 1,
  highCleared: 0,
  kev: false,
});

const stateOf = async (remediationId: string) => Object.fromEntries((await loadRows(remediationId)).map((r) => [r.pipelineId, r.state]));

/** A terminal PIPELINE event (a finished run) for every moved pipeline of the remediation. */
async function finishRuns(remediationId: string, status = 'SUCCEEDED') {
  const rows = (await loadRows(remediationId)).filter((r) => r.state === 'moved');
  await owner(async (q) => {
    for (const r of rows) {
      await q.query(
        `INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, created_at)
         VALUES ($1, $2, 'codepipeline', 'PIPELINE', $3, $4)`,
        [r.pipelineId, r.orgId, status, new Date(clock.getTime() + 1000).toISOString()],
      );
    }
  });
}

/** A failed ACTION on `stage/action` of `pipelineId`, after the move — of the moved run (its result execution) unless `executionId` says otherwise. */
async function failAction(pipelineId: string, orgId: string, stage = 'Build', action = 'trivy', executionId?: string | null) {
  await owner(async (q) => {
    const exec = executionId !== undefined ? executionId : (await q.query<{ e: string | null }>(
      `SELECT rr.result_execution_id AS e FROM pipeline_remediation_upgrades u JOIN pipeline_run_requests rr ON rr.id = u.run_request_id
       WHERE u.pipeline_id = $1 ORDER BY u.updated_at DESC LIMIT 1`, [pipelineId])).rows[0]?.e ?? null;
    await q.query(
      `INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, stage_name, action_name, execution_id, created_at)
       VALUES ($1, $2, 'codepipeline', 'ACTION', 'FAILED', $3, $4, $5, $6)`,
      [pipelineId, orgId, stage, action, exec, new Date(clock.getTime() + 2000).toISOString()],
    );
  });
}

async function manifest(pipelineId: string, orgId: string, stage: string, action: string, plugin: string, version: string) {
  await owner((q) => q.query(
    'INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version) VALUES ($1, $2, $3, $4, $5, $6)',
    [pipelineId, orgId, stage, action, plugin, version],
  ));
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec(`
    DELETE FROM pipeline_remediation_upgrades; DELETE FROM pipeline_events; DELETE FROM pipeline_run_requests;
    DELETE FROM pipeline_step_manifests; DELETE FROM pipeline_plugin_resolution; DELETE FROM pipeline_registry;
    DELETE FROM pipeline_runners; DELETE FROM plugin_remediation_settings; DELETE FROM plugin_vuln_exposure; DELETE FROM pipelines;
    DELETE FROM plugins WHERE name = 'trivy'; DELETE FROM plugin_installs; DELETE FROM plugin_listings; DELETE FROM publishers WHERE handle = 'acme';`));
  plans.clear();
  moveCalls.length = 0;
  moveFailures.clear();
  reports.length = 0;
  changeRequests.length = 0;
  redeployOutcomes.length = 0;
  redeployCalls.length = 0;
  redeployFailsOnMove.clear();
  installPendingOnMove.clear();
  setRunnerDepsForTesting(null);
  rollbackTarget = { ok: true };
  clock = new Date('2026-11-20T12:00:00Z');
  jest.clearAllMocks();
});

describe('start: who is proposed, queued or skipped', () => {
  it('propose (the root default) opens a proposal per pipeline and moves nothing', async () => {
    const a = await pipelineOn(ROOT);
    const b = await pipelineOn(ROOT);
    await pipelineOn(OTHER); // another org's own plugin of the same name: out of scope
    const rem = randomUUID();
    const out = await engine.start(rem, startBody());
    expect(out).toMatchObject({ created: true, orgDefault: 'propose' });
    expect(out.counts.proposed).toBe(2);
    expect(await stateOf(rem)).toEqual({ [a]: 'proposed', [b]: 'proposed' });
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect(reports[0]!.body.summary).toMatchObject({ status: 'done', counts: { eligible: 2, proposed: 2 } });
  });

  it('a pipeline set to off is never moved, and is counted as opted out', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const off = await pipelineOn(ROOT, { election: 'off' });
    const on = await pipelineOn(ROOT);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    expect(await stateOf(rem)).toEqual({ [off]: 'skipped_opt_out', [on]: 'queued' });
    await engine.tick();
    expect(moveCalls.map((m) => m.pipelineId)).toEqual([on]);
    expect((await stateOf(rem))[off]).toBe('skipped_opt_out');
    expect(reports.at(-1)!.body.summary.counts).toMatchObject({ skippedOptOut: 1, moved: 1, eligible: 1 });
  });

  it('a pipeline electing apply under an org propose is moved only when allowPipelineApply is true', async () => {
    const allowed = await pipelineOn(ROOT, { election: 'apply' });
    const r1 = randomUUID();
    await engine.start(r1, startBody());
    expect((await stateOf(r1))[allowed]).toBe('queued');

    await settings(ROOT, { rollout: 'propose', allowPipelineApply: false });
    const r2 = randomUUID();
    await engine.start(r2, startBody());
    expect((await stateOf(r2))[allowed]).toBe('proposed');
    expect(await electionRefusal('apply', ROOT)).toMatch(/does not allow pipelines to choose Apply/);
    expect(await electionRefusal('off', ROOT)).toBeNull();
    expect(await electionRefusal('propose', ROOT)).toBeNull();
  });

  it('a team on inherit follows the root; its own setting wins when set; team pins are only proposed', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const teamPipe = await pipelineOn(TEAM, { root: ROOT });
    plans.set(teamPipe, { kind: 'redeploy', steps: [], install: null });
    const r1 = randomUUID();
    await engine.start(r1, startBody());
    expect((await stateOf(r1))[teamPipe]).toBe('queued');
    expect(await readOrgRolloutSettings(TEAM, ROOT)).toMatchObject({ team: 'inherit', root: 'apply', orgDefault: 'apply' });

    plans.set(teamPipe, STEP_PIN);
    const r2 = randomUUID();
    await engine.start(r2, startBody());
    expect((await stateOf(r2))[teamPipe]).toBe('proposed');

    await settings(TEAM, { rollout: 'off' });
    const r3 = randomUUID();
    await engine.start(r3, startBody());
    expect((await stateOf(r3))[teamPipe]).toBe('skipped_opt_out');
  });

  it('an approval-gated install gets a change request instead of a move', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    plans.set(p, { kind: 'install_pin', steps: [], install: { id: 'inst-1', orgId: ROOT, gated: true } });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    expect((await stateOf(rem))[p]).toBe('change_requested');
    expect(changeRequests).toEqual(['inst-1']);
    await engine.tick();
    expect(moveCalls).toEqual([]);
  });

  it('a team never moves the install it inherits from its root: it gets a proposal', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const teamPipe = await pipelineOn(TEAM, { root: ROOT });
    plans.set(teamPipe, { kind: 'install_pin', steps: [], install: { id: 'root-inst', orgId: ROOT, gated: false } });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    expect((await stateOf(rem))[teamPipe]).toBe('proposed');
    await engine.tick();
    expect(moveCalls).toEqual([]);
  });

  it('writes no row for a pipeline outside the rollout\'s org: a resolution row CLAIMING the root does not make another org a team', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const own = await pipelineOn(ROOT);
    const team = await pipelineOn(TEAM, { root: ROOT });
    // OTHER is not under ROOT, whatever its resolution row recorded as root.
    const foreign = await pipelineOn(OTHER, { root: ROOT });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    const rows = await loadRows(rem);
    expect(rows.map((r) => r.pipelineId).sort()).toEqual([own, team].sort());
    expect(rows.find((r) => r.pipelineId === team)?.orgId).toBe(TEAM);
    await engine.tick();
    expect(moveCalls.map((m) => m.pipelineId)).not.toContain(foreign);
  });

  it('refuses the row when the org hierarchy cannot be confirmed (fail-closed), and still writes the root\'s own', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const own = await pipelineOn(ROOT);
    await pipelineOn(TEAM, { root: ROOT });
    const failing = createRolloutEngine({ ...deps, ancestors: async () => { throw new Error('platform down'); } });
    const rem = randomUUID();
    await failing.start(rem, startBody());
    expect((await loadRows(rem)).map((r) => r.pipelineId)).toEqual([own]);
  });

  it('rowOrgAdmits: the row org must be the pipeline\'s org, and the scope its own org or an ancestor', async () => {
    const { rowOrgAdmits } = engineModule;
    const anc = deps.ancestors;
    expect(await rowOrgAdmits({ pipelineOrgId: ROOT, rowOrgId: ROOT, scopeOrgId: ROOT }, anc)).toBe(true);
    expect(await rowOrgAdmits({ pipelineOrgId: ROOT, rowOrgId: ROOT.toUpperCase(), scopeOrgId: null }, anc)).toBe(true);
    expect(await rowOrgAdmits({ pipelineOrgId: TEAM, rowOrgId: TEAM, scopeOrgId: ROOT }, anc)).toBe(true);
    expect(await rowOrgAdmits({ pipelineOrgId: TEAM, rowOrgId: ROOT, scopeOrgId: ROOT }, anc)).toBe(false);
    expect(await rowOrgAdmits({ pipelineOrgId: OTHER, rowOrgId: OTHER, scopeOrgId: ROOT }, anc)).toBe(false);
    expect(await rowOrgAdmits({ pipelineOrgId: ROOT, rowOrgId: ROOT, scopeOrgId: TEAM }, anc)).toBe(false);
  });

  it('is idempotent per remediation, and a new toVersion re-targets the open rows', async () => {
    const p = await pipelineOn(ROOT);
    const rem = randomUUID();
    expect((await engine.start(rem, startBody())).created).toBe(true);
    const again = await engine.start(rem, startBody());
    expect(again.created).toBe(false);
    expect(again.counts.proposed).toBe(1);
    await engine.start(rem, { ...startBody(), toVersion: '1.5.0' });
    const [row] = await loadRows(rem);
    expect(row).toMatchObject({ pipelineId: p, toVersion: '1.5.0', state: 'proposed' });
  });
});

describe('apply: waves', () => {
  it('runs a canary of up to 5 (recently successful first), waits for its runs, then a batch', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await pipelineOn(ROOT));
    // Two pipelines ran successfully this week: they lead the canary.
    const recent = [ids[6]!, ids[7]!];
    await owner(async (q) => {
      for (const id of recent) {
        await q.query(`INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, created_at)
          VALUES ($1, $2, 'codepipeline', 'PIPELINE', 'SUCCEEDED', $3)`, [id, ROOT, new Date(clock.getTime() - 86_400_000).toISOString()]);
      }
    });
    const rem = randomUUID();
    await engine.start(rem, startBody());

    await engine.tick();
    expect(moveCalls).toHaveLength(5);
    expect(moveCalls.map((m) => m.pipelineId)).toEqual(expect.arrayContaining(recent));
    expect(moveCalls.every((m) => m.actor === 'system:plugin-remediation')).toBe(true);
    expect(reports.at(-1)!.body.summary).toMatchObject({ status: 'canary', waves: [{ index: 0, kind: 'canary', outcome: 'running' }] });

    // The canary runs have not finished: nothing else moves.
    advance(60_000);
    await engine.tick();
    expect(moveCalls).toHaveLength(5);

    await finishRuns(rem);
    advance(60_000);
    await engine.tick();
    expect(moveCalls).toHaveLength(8);
    const rows = await loadRows(rem);
    expect(rows.filter((r) => r.wave === 0)).toHaveLength(5);
    expect(rows.filter((r) => r.wave === 1)).toHaveLength(3);
    // The batch's runs started (the fake's requests are `started`): done.
    const summary = summarize(rows, TO, await runStates(rem), clock);
    expect(summary).toMatchObject({ status: 'done', counts: { moved: 8 } });
    expect(summary.waves.map((w) => [w.kind, w.outcome])).toEqual([['canary', 'succeeded'], ['batch', 'succeeded']]);
  });

  it('honours an election changed mid-rollout before the pipeline is moved', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    expect((await stateOf(rem))[p]).toBe('queued');
    await owner((q) => q.query('UPDATE pipelines SET remediation_upgrades = \'off\' WHERE id = $1', [p]));
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect((await stateOf(rem))[p]).toBe('skipped_opt_out');
  });

  it('records a failed move (compliance, validation) as failed without stopping the wave', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const bad = await pipelineOn(ROOT);
    const good = await pipelineOn(ROOT);
    moveFailures.add(bad);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    const rows = await loadRows(rem);
    expect(rows.find((r) => r.pipelineId === bad)).toMatchObject({ state: 'failed', error: 'Compliance blocked: rule r1' });
    expect(rows.find((r) => r.pipelineId === good)).toMatchObject({ state: 'moved' });
  });

  it('skips a pipeline whose runner is unhealthy, counts it separately, and retries it in a later wave', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    const runnerId = randomUUID();
    await owner(async (q) => {
      await q.query('INSERT INTO pipeline_runners (id, org_id, label, status, health) VALUES ($1, $2, \'prod\', \'active\', \'unreachable\')', [runnerId, ROOT]);
      await q.query('INSERT INTO pipeline_registry (id, pipeline_id, org_id, pipeline_name, runner_id) VALUES ($1, $2, $3, \'p\', $4)', [randomUUID(), p, ROOT, runnerId]);
    });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect((await stateOf(rem))[p]).toBe('skipped_runner');
    expect(reports.at(-1)!.body.summary.counts).toMatchObject({ skippedRunner: 1, moved: 0 });

    // Healthy again, but not retried before the hour is up.
    await owner((q) => q.query('UPDATE pipeline_runners SET health = \'healthy\''));
    clock = new Date(Date.now() + 60_000);
    await engine.tick();
    expect(moveCalls).toEqual([]);
    // `updated_at` is the trigger's (wall-clock) stamp of the skip: an hour past it, the row is retried.
    clock = new Date(Date.now() + 3_600_000 + 60_000);
    await engine.tick();
    expect(moveCalls.map((m) => m.pipelineId)).toEqual([p]);
    expect((await stateOf(rem))[p]).toBe('moved');
  });
});

describe('rollback', () => {
  async function moved(n: number) {
    await settings(ROOT, { rollout: 'apply' });
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push(await pipelineOn(ROOT));
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    return { rem, ids };
  }

  it('a failed canary run on a step using the new version rolls that pipeline back and stops the rollout', async () => {
    const { rem, ids } = await moved(7);
    const canary = (await loadRows(rem)).filter((r) => r.wave === 0);
    expect(canary).toHaveLength(5);
    const victim = canary[0]!.pipelineId;
    await manifest(victim, ROOT, 'Build', 'trivy', PLUGIN, TO);
    await failAction(victim, ROOT, 'Build', 'trivy');
    await finishRuns(rem);
    advance(60_000);
    await engine.tick();

    const rows = await loadRows(rem);
    expect(rows.find((r) => r.pipelineId === victim)).toMatchObject({ state: 'rolled_back', rolledBackTo: FROM });
    expect(moveCalls.filter((m) => m.rollback).map((m) => m.pipelineId)).toEqual([victim]);
    // Stopped: the two queued pipelines never moved.
    expect(rows.filter((r) => r.state === 'queued')).toHaveLength(2);
    expect(reports.at(-1)!.body.summary).toMatchObject({ status: 'paused', pausedReason: 'canary_failed' });
    expect(reports.at(-1)!.body.events).toEqual([expect.objectContaining({ kind: 'rolled_back', pipelineId: victim, fromVersion: TO, toVersion: FROM })]);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.remediation.rolled_back', targetType: 'plugin_remediation', targetId: rem }));
    void ids;
  });

  it('maps failed actions through the step-to-plugin mapping: another plugin\'s failure does not roll back', async () => {
    const { rem, ids } = await moved(1);
    await manifest(ids[0]!, ROOT, 'Build', 'trivy', PLUGIN, TO);
    await manifest(ids[0]!, ROOT, 'Test', 'unit', 'jest', '2.0.0');
    await failAction(ids[0]!, ROOT, 'Test', 'unit');
    advance(60_000);
    await engine.tick();
    expect((await stateOf(rem))[ids[0]!]).toBe('moved');
  });

  it('with no mapping, any failed run in the 24 h window rolls back; one after it does not', async () => {
    const { rem, ids } = await moved(2);
    await failAction(ids[0]!, ROOT, 'Deploy', 'cfn');
    advance(60_000);
    await engine.tick();
    expect((await stateOf(rem))[ids[0]!]).toBe('rolled_back');

    // Past the window: a later failure is not the fix's.
    advance(25 * 3_600_000);
    await failAction(ids[1]!, ROOT, 'Deploy', 'cfn');
    await engine.tick();
    expect((await stateOf(rem))[ids[1]!]).toBe('moved');
  });

  it('two rollbacks in one rollout pause it', async () => {
    const { rem } = await moved(7);
    await finishRuns(rem);
    advance(60_000);
    await engine.tick(); // the batch of 2 moves
    const batch = (await loadRows(rem)).filter((r) => r.wave === 1);
    expect(batch).toHaveLength(2);
    for (const r of batch) await failAction(r.pipelineId, ROOT);
    advance(60_000);
    await engine.tick();
    expect(reports.at(-1)!.body.summary).toMatchObject({ status: 'paused', pausedReason: 'rollbacks', counts: { rolledBack: 2 } });
  });

  it('a deleted previous version blocks the rollback and pauses the rollout', async () => {
    const { rem, ids } = await moved(1);
    rollbackTarget = { ok: false, reason: 'previous_version_deleted' };
    await failAction(ids[0]!, ROOT);
    advance(60_000);
    await engine.tick();
    expect((await loadRows(rem))[0]).toMatchObject({ state: 'rollback_blocked', error: 'previous_version_deleted' });
    expect(moveCalls.filter((m) => m.rollback)).toEqual([]);
    expect(reports.at(-1)!.body.summary).toMatchObject({ status: 'paused', pausedReason: 'rollback_target_deleted' });
    expect(reports.at(-1)!.body.events).toEqual([expect.objectContaining({ kind: 'rollback_blocked', pipelineId: ids[0] })]);
  });
});

describe('the rollback target (real SQL)', () => {
  const row = (pipelineId: string) => ({
    id: randomUUID(),
    orgId: ROOT,
    remediationId: randomUUID(),
    pipelineId,
    pluginName: PLUGIN,
    pluginPublisher: null,
    fromVersion: FROM,
    toVersion: TO,
    mode: 'apply' as const,
    state: 'moved' as const,
    wave: 0,
    movedAt: clock,
    runRequestId: null,
    rolledBackAt: null,
    rolledBackTo: null,
    error: null,
    createdAt: clock,
    updatedAt: clock,
  });
  const kevSummary = {
    critical: 1,
    high: 0,
    criticalFixable: 1,
    highFixable: 0,
    kev: 1,
    findings: [{ id: 'CVE-2026-9999', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.0', fixedIn: ['3.0.1'], kev: true }],
  };

  it('is refused when the previous version is gone', async () => {
    const p = await pipelineOn(ROOT);
    expect(await checkRollbackTarget(row(p), null)).toEqual({ ok: false, reason: 'previous_version_deleted' });
    await owner((q) => q.query('INSERT INTO plugins (org_id, name, version, deleted_at) VALUES ($1, $2, $3, now())', [ROOT, PLUGIN, FROM]));
    expect(await checkRollbackTarget(row(p), null)).toEqual({ ok: false, reason: 'previous_version_deleted' });
  });

  it('allows a live, KEV-free previous version', async () => {
    const p = await pipelineOn(ROOT);
    await owner((q) => q.query('INSERT INTO plugins (org_id, name, version) VALUES ($1, $2, $3)', [ROOT, PLUGIN, FROM]));
    expect(await checkRollbackTarget(row(p), null)).toEqual({ ok: true });
  });

  it('never restores a KEV-listed Critical without a risk acceptance covering it', async () => {
    const p = await pipelineOn(ROOT);
    await owner((q) => q.query('INSERT INTO plugins (org_id, name, version, scan_summary) VALUES ($1, $2, $3, $4::jsonb)', [ROOT, PLUGIN, FROM, JSON.stringify(kevSummary)]));
    expect(await checkRollbackTarget(row(p), null)).toEqual({ ok: false, reason: 'previous_version_kev' });

    await owner((q) => q.query(
      `INSERT INTO plugin_vuln_exposure (id, org_id, pipeline_id, plugin_name, plugin_version, source, triage_state, accepted_until, accepted_finding_keys, accepted_kev, triage_reason)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'declared', 'accepted', now() + interval '30 days', $5, true, 'vendor patch pending')`,
      [ROOT, p, PLUGIN, FROM, ['CVE-2026-9999|openssl|3.0.0']],
    ));
    expect(await checkRollbackTarget(row(p), null)).toEqual({ ok: true });
  });
});

describe('superseded rows', () => {
  it('a pipeline deleted mid-rollout is superseded without reporting the rollout cancelled', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await pipelineOn(ROOT));
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    const queued = (await loadRows(rem)).find((r) => r.state === 'queued')!;
    await owner((q) => q.query('UPDATE pipelines SET deleted_at = now() WHERE id = $1', [queued.pipelineId]));
    await finishRuns(rem);
    advance(60_000);
    await engine.tick();
    const rows = await loadRows(rem);
    expect(rows.find((r) => r.id === queued.id)).toMatchObject({ state: 'superseded', error: 'pipeline_deleted' });
    expect(summarize(rows, TO, await runStates(rem), clock).status).toBe('done');
  });
});

describe('applyProposal', () => {
  it('never moves a listing install for a caller who may not change installs', async () => {
    const p = await pipelineOn(ROOT);
    const install = { id: 'inst-1', orgId: ROOT, gated: false };
    plans.set(p, { kind: 'step_pin', steps: [{ stepKey: 'Build/trivy' } as never], install });
    const seen: Array<unknown> = [];
    const spy = createRolloutEngine({ ...deps, move: async (input) => { seen.push(input.plan.install); return deps.move(input); } });
    const rem = randomUUID();
    await spy.start(rem, startBody());
    const [row] = await loadRows(rem);
    const pipeline = (await engineModule.loadPipeline(p))!;
    expect((await spy.applyProposal(row!, pipeline, { userId: 'u1', requestedBy: 'u1' }, null)).ok).toBe(true);
    expect(seen).toEqual([null]);
    await owner((q) => q.query('UPDATE pipeline_remediation_upgrades SET state = \'proposed\' WHERE id = $1', [row!.id]));
    await spy.applyProposal(row!, pipeline, { userId: 'u1', requestedBy: 'u1' }, null, { moveInstall: true });
    expect(seen).toEqual([null, install]);
  });
});

describe('cancel', () => {
  it('drops queued moves and supersedes proposals; moved pipelines stay; unknown answers false', async () => {
    await settings(ROOT, { rollout: 'apply' });
    for (let i = 0; i < 6; i += 1) await pipelineOn(ROOT);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    expect(await engine.cancel(rem)).toBe(true);
    const rows = await loadRows(rem);
    expect(rows.filter((r) => r.state === 'moved')).toHaveLength(5);
    expect(rows.filter((r) => r.state === 'superseded')).toHaveLength(1);
    expect(summarize(rows, TO, await runStates(rem), clock).status).toBe('cancelled');
    expect(await engine.cancel(randomUUID())).toBe(false);
  });
});

describe('the opted-out list filter (real SQL)', () => {
  it('lists only the pipelines with that election', async () => {
    const off = await pipelineOn(ROOT, { election: 'off' });
    await pipelineOn(ROOT);
    await owner((q) => q.query('UPDATE pipelines SET visibility = \'org\''));
    const page = await runWithTenantContext({ orgId: ROOT, isSuperAdmin: false }, () =>
      pipelineService.findPaginated({ remediationUpgrades: 'off' } as never, ROOT, { limit: 25, offset: 0 }));
    expect(page.data.map((p: { id: string }) => p.id)).toEqual([off]);
  });
});

describe('an install with another change request pending', () => {
  const PENDING_INSTALL = { id: 'inst-p', orgId: ROOT, gated: false, pendingChange: true };

  it('holds only that pipeline (waiting_change_request); the rest of the rollout moves, and it is not done', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const held = await pipelineOn(ROOT);
    const other = await pipelineOn(ROOT);
    plans.set(held, { kind: 'install_pin', steps: [], install: PENDING_INSTALL });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    expect((await stateOf(rem))[held]).toBe('waiting_change_request');
    await engine.tick();
    expect(moveCalls.map((m) => m.pipelineId)).toEqual([other]);
    expect(await stateOf(rem)).toEqual({ [held]: 'waiting_change_request', [other]: 'moved' });
    await finishRuns(rem);
    advance(60_000);
    await engine.tick();
    expect(reports.at(-1)!.body.summary.status).not.toBe('done');
    expect(reports.at(-1)!.body.summary.counts).toMatchObject({ waitingChangeRequest: 1, moved: 1 });
  });

  it('a move refused because the install got a change request meanwhile waits instead of failing', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    installPendingOnMove.add(p);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    expect((await loadRows(rem))[0]).toMatchObject({ state: 'waiting_change_request' });
  });

  it('approved: the worker resumes it and moves it as planned', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    plans.set(p, { kind: 'install_pin', steps: [], install: PENDING_INSTALL });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    expect(moveCalls).toEqual([]);
    // The approver moved the install to the fix: what is left is a redeploy.
    plans.set(p, { kind: 'redeploy', steps: [], install: null });
    advance(60_000);
    await engine.tick();
    expect(moveCalls.map((m) => m.pipelineId)).toEqual([p]);
    expect((await stateOf(rem))[p]).toBe('moved');
  });

  it('rejected: the worker ends it as skipped with the reason', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    plans.set(p, { kind: 'install_pin', steps: [], install: PENDING_INSTALL });
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    // Decided without moving the install: still pinned to the flagged version.
    plans.set(p, { kind: 'install_pin', steps: [], install: { ...PENDING_INSTALL, pendingChange: false } });
    advance(60_000);
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect((await loadRows(rem))[0]).toMatchObject({ state: 'dismissed', error: 'change_request_rejected' });
    expect(reports.at(-1)!.body.summary.status).toBe('done');
  });
});

describe('install change helpers (real SQL)', () => {
  async function install(pinned: string, pending: object | null = null): Promise<string> {
    return owner(async (q) => {
      const pub = await q.query<{ id: string }>('INSERT INTO publishers (handle, display_name) VALUES (\'acme\', \'Acme\') ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id');
      const listing = await q.query<{ id: string }>('INSERT INTO plugin_listings (publisher_id, name) VALUES ($1, $2) RETURNING id', [pub.rows[0]!.id, `l-${randomUUID().slice(0, 8)}`]);
      const inst = await q.query<{ id: string }>(
        `INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, installed_by, pending_change)
         VALUES ($1, $2, 'pinned', $3, 'u1', $4::jsonb) RETURNING id`,
        [ROOT, listing.rows[0]!.id, pinned, pending ? JSON.stringify(pending) : null],
      );
      return inst.rows[0]!.id;
    });
  }
  const pendingOf = async (id: string) => (await owner((q) => q.query<{ p: unknown }>('SELECT pending_change AS p FROM plugin_installs WHERE id = $1', [id]))).rows[0]!.p;
  const ref = { remediationId: randomUUID(), plugin: 'scan', publisher: 'acme', fromVersion: FROM, toVersion: TO };

  it('opens a change request only while the install is still pinned to the flagged version', async () => {
    const moved = await install('1.5.0');
    await engineModule.requestInstallChange({ id: moved, orgId: ROOT, gated: true }, ref);
    expect(await pendingOf(moved)).toBeNull();
    const still = await install(FROM);
    await engineModule.requestInstallChange({ id: still, orgId: ROOT, gated: true }, ref);
    expect(await pendingOf(still)).toMatchObject({ version: TO, versionPolicy: 'pinned' });
  });

  it('moving an install with a change pending answers pending, not changed', async () => {
    const id = await install(FROM, { version: '1.6.0', versionPolicy: 'pinned', requestedBy: 'u2', requestedAt: clock.toISOString() });
    expect(await engineModule.moveInstallPin({ id, orgId: ROOT, gated: false }, ref, { userId: 'u1', requestedBy: 'u1' })).toBe('pending');
    expect(await engineModule.installHasPendingChange(id)).toBe(true);
    const other = await install('1.5.0');
    expect(await engineModule.moveInstallPin({ id: other, orgId: ROOT, gated: false }, ref, { userId: 'u1', requestedBy: 'u1' })).toBe('changed');
    const free = await install(FROM);
    expect(await engineModule.moveInstallPin({ id: free, orgId: ROOT, gated: false }, ref, { userId: 'u1', requestedBy: 'u1' })).toBe('moved');
  });
});

describe('a move whose redeploy did not start', () => {
  it('is moved_pending_redeploy, counted, keeps the rollout open, and is retried until the redeploy starts', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    redeployFailsOnMove.add(p);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    clock = new Date(Date.now());
    await engine.tick();
    expect((await loadRows(rem))[0]).toMatchObject({ state: 'moved_pending_redeploy', wave: 0 });
    expect(reports.at(-1)!.body.summary).toMatchObject({ status: 'canary', counts: { movedPendingRedeploy: 1, moved: 0 } });

    // Not retried before the retry interval.
    clock = new Date(Date.now() + 60_000);
    await engine.tick();
    expect(redeployCalls).toEqual([]);

    clock = new Date(Date.now() + engineModule.REDEPLOY_RETRY_MS + 60_000);
    await engine.tick();
    expect(redeployCalls).toEqual([p]);
    const [row] = await loadRows(rem);
    expect(row).toMatchObject({ state: 'moved', error: null });
    expect(row!.runRequestId).not.toBeNull();
  });

  it('ends as failed once the retries run out', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    redeployFailsOnMove.add(p);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    for (let i = 0; i < engineModule.REDEPLOY_MAX_ATTEMPTS + 2; i += 1) {
      redeployOutcomes.push('fail');
      // Each retry is due: `updated_at` is the trigger's wall-clock stamp, so step past the interval from it.
      clock = new Date(Date.now() + engineModule.REDEPLOY_RETRY_MS + 60_000);
      await engine.tick();
    }
    expect(redeployCalls).toHaveLength(engineModule.REDEPLOY_MAX_ATTEMPTS - 1);
    expect((await loadRows(rem))[0]).toMatchObject({ state: 'failed', error: 'redeploy_retries_exhausted' });
    expect(reports.at(-1)!.body.summary.status).toBe('done');
  });
});

describe('runner health', () => {
  it('a skipped_runner row past the retry age ends as failed (runner_unhealthy_expired)', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await owner((q) => q.query(
      `UPDATE pipeline_remediation_upgrades SET state = 'skipped_runner', wave = 0, error = 'runner_unhealthy',
         created_at = now() - interval '8 days', updated_at = now() - interval '2 hours'`));
    clock = new Date(Date.now());
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect((await loadRows(rem))[0]).toMatchObject({ pipelineId: p, state: 'failed', error: 'runner_unhealthy_expired' });
  });

  it('an unlinked pipeline whose org\'s eligible runners are all unhealthy is skipped', async () => {
    setRunnerDepsForTesting({ hierarchy: { ancestors: async () => [], descendants: async () => [], names: async () => ({}) } });
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    await owner((q) => q.query('INSERT INTO pipeline_runners (id, org_id, label, status, health) VALUES ($1, $2, \'prod\', \'active\', \'unreachable\')', [randomUUID(), ROOT]));
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    expect(moveCalls).toEqual([]);
    expect((await stateOf(rem))[p]).toBe('skipped_runner');

    // One healthy eligible runner is enough.
    await owner((q) => q.query('INSERT INTO pipeline_runners (id, org_id, label, status, health) VALUES ($1, $2, \'dr\', \'active\', \'healthy\')', [randomUUID(), ROOT]));
    expect(await engineModule.runnerHealthy(p, ROOT, null)).toBe(true);
  });
});

describe('a no-mapping rollback', () => {
  it('only fires on a failure of the moved run (its result execution) when the move started one', async () => {
    await settings(ROOT, { rollout: 'apply' });
    const p = await pipelineOn(ROOT);
    const rem = randomUUID();
    await engine.start(rem, startBody());
    await engine.tick();
    await failAction(p, ROOT, 'Deploy', 'cfn', 'exec-someone-elses-run');
    advance(60_000);
    await engine.tick();
    expect((await stateOf(rem))[p]).toBe('moved');
    await failAction(p, ROOT, 'Deploy', 'cfn');
    advance(60_000);
    await engine.tick();
    expect((await stateOf(rem))[p]).toBe('rolled_back');
  });
});
