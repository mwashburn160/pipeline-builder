// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Toolchain CONSOLE service (docs/plans/bootstrap-image-versioning.md §5,
 * §6, §8, §9, §10, §11, Phase 5) end to end through the Phase 2-4 services,
 * against a REAL Postgres (PGlite, the shipped postgres-init.sql, as the
 * RLS-enforced app role): releases, adoption, canary replace + move, the
 * blast-radius preview, promotion (guards, refusals, audience-specific
 * notices), yank-restore, delete refusal, the Affected view + recovery notice
 * and the Cleanup candidates.
 *
 * Replaced: pipeline-data's `withTenantTx` (bound to PGlite) and
 * `findVersionReferences` (its own suite), the platform org-name / parent
 * lookups (`setToolchainConsoleDepsForTests`) and the notification relay (a
 * recording client — who hears what is under test).
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { type AnyFn, bindTestAuditService, stubModule } from '@pipeline-builder/api-core/testing';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');

const SYSTEM = realApiCore.SYSTEM_ORG_ID;
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

const mockRecordAudit = bindTestAuditService('plugin');
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
  findVersionReferences: jest.fn<AnyFn>(async () => []),
}));
jest.unstable_mockModule('../src/services/declared-resolution-refresh.js', () => ({ refreshDeclaredResolutions: jest.fn(async () => undefined) }));

const consoleSvc = await import('../src/services/toolchain-console-service.js');
const releaseSvc = await import('../src/services/toolchain-release-service.js');
const { pluginService } = await import('../src/services/plugin-service.js');
const { setEcosystemNotifyClientForTests } = await import('../src/services/ecosystem-notifications.js');

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const C = 'ccccccccccccccccccccccc1';
const D = 'ddddddddddddddddddddddd1';
const TEAM = 'eeeeeeeeeeeeeeeeeeeeeee1';
const NAMES: Record<string, string> = { [A]: 'Acme', [B]: 'Beta', [C]: 'Cyan' };
const PARENTS: Record<string, string> = { [TEAM]: A };

const sent: Array<{ event: string; recipients: any[]; subject: string; text: string }> = [];
const send = jest.fn(async (req: any) => { sent.push(req); return { ok: true } as const; });

const TOOLCHAIN = { pipelineManager: '4.4.20', awsCdk: '2.1148.0', cdkAssets: '4.8.0', esbuild: '0.28.1', pnpm: '12.14.0', node: '26.13.0' };
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

async function upload(name: 'pipeline-bootstrap' | 'cdk-synth', version: string) {
  return realPipelineData.runWithTenantContext({ orgId: SYSTEM, isSuperAdmin: false }, () => pluginService.deployVersion({
    orgId: SYSTEM,
    name,
    version,
    pluginType: (name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep') as never,
    computeType: 'SMALL' as never,
    metadata: name === 'pipeline-bootstrap' ? realApiCore.toolchainMetadata(TOOLCHAIN) : {},
    visibility: 'public',
    buildType: 'prebuilt',
    imageDigest: digest(),
  }, 'loader', { isSystemAdmin: true, canPublish: true }));
}

/** A complete release; scanned and clean unless told otherwise. */
async function release(version: string, opts: { scanned?: boolean } = {}) {
  await upload('pipeline-bootstrap', version);
  await upload('cdk-synth', version);
  if (opts.scanned !== false) await raw.query('UPDATE plugins SET scanned_at = now(), vuln_critical_fixable = 0, vuln_high_fixable = 1 WHERE version = $1', [version]);
}

async function pipeline(orgId: string, opts: { pin?: string; deployed?: string; via?: string } = {}): Promise<string> {
  const project = `p-${randomUUID().slice(0, 8)}`;
  const props = { project, organization: 'acme', ...(opts.pin ? { toolchain: { release: opts.pin } } : {}) };
  const { rows } = await raw.query<{ id: string }>(
    "INSERT INTO pipelines (org_id, created_by, updated_by, project, organization, pipeline_name, props) VALUES ($1, 'u', 'u', $2, 'acme', $2, $3) RETURNING id::text AS id",
    [orgId, project, JSON.stringify(props)]);
  const id = rows[0]!.id;
  if (opts.deployed) {
    await raw.query(
      `INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version, step_key, resolved_via)
       VALUES ($1, $2, '(toolchain)', 'build-image', 'pipeline-bootstrap', $3, 'build-image', $4)`, [id, orgId, opts.deployed, opts.via ?? 'default']);
  }
  return id;
}

async function synth(pipelineId: string | null, orgId: string, releaseVersion: string, status: 'SUCCEEDED' | 'FAILED', minutesAgo = 0) {
  await raw.query(
    `INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name, action_name, completed_at, toolchain_release)
     VALUES ($1, $2, 'codepipeline', 'ACTION', $3, $4, 'Build', 'cdk-synth-0a1b', now() - ($5 || ' minutes')::interval, $6)`,
    [pipelineId ?? randomUUID(), orgId, status, randomUUID(), String(minutesAgo), releaseVersion]);
}

const orgDefault = (orgId: string, v: string) =>
  raw.query("INSERT INTO org_toolchain_default (org_id, release_version, set_by) VALUES ($1, $2, 'u')", [orgId, v]);
const initial = (v: string) => releaseSvc.setPlatformDefault({ releaseVersion: v, kind: 'initial', actor: 'service:deploy-bootstrap' });
const platformDefault = async () => (await raw.query<{ release_version: string }>('SELECT release_version FROM toolchain_platform_default')).rows[0]?.release_version ?? null;

function audits(action: string) {
  return mockRecordAudit.mock.calls.map((c) => c[0] as { action: string; outcome?: string; details: Record<string, unknown> }).filter((e) => e.action === action);
}

/** Wait for the fire-and-forget notices a write sends after COMMIT. */
async function settled(): Promise<void> {
  let last = -1;
  for (let i = 0; i < 40 && sent.length !== last; i++) {
    last = sent.length;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(() => {
  setEcosystemNotifyClientForTests({ send });
  consoleSvc.setToolchainConsoleDepsForTests({
    orgNames: async (ids) => Object.fromEntries(ids.filter((id) => NAMES[id]).map((id) => [id, NAMES[id]!])),
    getParent: async (id) => PARENTS[id],
  });
}, 120_000);
afterAll(async () => {
  setEcosystemNotifyClientForTests(undefined);
  consoleSvc.setToolchainConsoleDepsForTests(null);
  await raw.close();
});
beforeEach(async () => {
  jest.clearAllMocks();
  sent.length = 0;
  await raw.exec(`
    DELETE FROM toolchain_platform_default; DELETE FROM toolchain_default_history; DELETE FROM toolchain_rollout;
    DELETE FROM org_toolchain_default; DELETE FROM org_toolchain_default_history; DELETE FROM toolchain_release;
    DELETE FROM pipeline_events; DELETE FROM pipeline_step_manifests; DELETE FROM plugins; DELETE FROM pipelines;`);
});

describe('Releases panel', () => {
  it('lists every release newest first with status, completeness, toolchain, both halves and canary size', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await release('1.2.0');
    await release('1.3.0');
    await release('1.4.0');
    await upload('pipeline-bootstrap', '1.5.0');
    await initial('1.0.0');
    await consoleSvc.replaceRollout('1.1.0', [A, B], 'u-op');
    await releaseSvc.deprecateRelease({ releaseVersion: '1.2.0', actor: 'u-op' });
    await releaseSvc.yankRelease({ releaseVersion: '1.3.0', actor: 'u-op', reason: 'bad' });
    await consoleSvc.setReleaseNotes('1.4.0', '  Fixes synth on Node 26.  ', 'u-op');

    const out = await consoleSvc.listConsoleReleases();
    expect(out.platformDefault).toBe('1.0.0');
    expect(out.releases.map((r) => [r.releaseVersion, r.status, r.complete, r.canaryOrgCount])).toEqual([
      ['1.5.0', 'available', false, 0],
      ['1.4.0', 'available', true, 0],
      ['1.3.0', 'yanked', true, 0],
      ['1.2.0', 'deprecated', true, 0],
      ['1.1.0', 'canary', true, 2],
      ['1.0.0', 'default', true, 0],
    ]);
    const r140 = out.releases.find((r) => r.releaseVersion === '1.4.0')!;
    expect(r140).toMatchObject({
      releaseNotes: 'Fixes synth on Node 26.',
      toolchain: TOOLCHAIN,
      halves: {
        bootstrap: { digest: expect.stringMatching(/^sha256:/), scan: { scannedAt: expect.any(String), criticalFixable: 0, highFixable: 1, kev: 0 } },
        synth: { digest: expect.stringMatching(/^sha256:/), scan: { criticalFixable: 0 } },
      },
    });
    expect(typeof r140.createdAt).toBe('string');
    expect(out.releases[0]!.halves).toEqual({ bootstrap: expect.objectContaining({ scan: null }), synth: null });
  });

  it('release notes: edited and audited; an empty string clears them; an unknown release is 404', async () => {
    await release('1.0.0');
    await expect(consoleSvc.setReleaseNotes('1.0.0', 'Notes', 'u-op')).resolves.toEqual({ releaseVersion: '1.0.0', releaseNotes: 'Notes' });
    await expect(consoleSvc.setReleaseNotes('1.0.0', '   ', 'u-op')).resolves.toEqual({ releaseVersion: '1.0.0', releaseNotes: null });
    await expect(consoleSvc.setReleaseNotes('9.9.9', 'x', 'u-op')).rejects.toMatchObject({ statusCode: 404 });
    expect(audits('toolchain.release.notes').map((a) => a.outcome)).toEqual(['success', 'success', 'failure']);
  });
});

describe('Adoption panel', () => {
  it('counts deployed pipelines by resolvedVia and per org, with pins and org defaults (adoption equals in-use counts)', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await pipeline(A, { deployed: '1.0.0', via: 'default' });
    await pipeline(A, { deployed: '1.0.0', via: 'default' });
    await pipeline(A, { deployed: '1.0.0', via: 'pin', pin: '1.0.0' });
    await pipeline(C, { pin: '1.0.0' }); // pinned, not deployed yet
    await pipeline(C, { deployed: '1.1.0', via: 'canary' }); // another release
    await orgDefault(B, '1.0.0');

    const out = await consoleSvc.getReleaseAdoption('1.0.0');
    expect(out.byResolvedVia).toEqual({ 'pin': 1, 'org-default': 0, 'canary': 0, 'default': 2 });
    expect(out.orgs).toEqual([
      { orgId: A, orgName: 'Acme', pipelines: 3, pinned: 1, orgDefault: false },
      { orgId: C, orgName: 'Cyan', pipelines: 0, pinned: 1, orgDefault: false },
      { orgId: B, orgName: 'Beta', pipelines: 0, pinned: 0, orgDefault: true },
    ]);
    await expect(consoleSvc.getReleaseAdoption('7.7.7')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('shows an org id as its name when the platform cannot name it', async () => {
    await release('1.0.0');
    await pipeline(D, { deployed: '1.0.0' });
    expect((await consoleSvc.getReleaseAdoption('1.0.0')).orgs).toEqual([{ orgId: D, orgName: D, pipelines: 1, pinned: 0, orgDefault: false }]);
  });
});

describe('Canary panel + rollout', () => {
  it('replaces the set (added / removed), moves an org from another release and reports it, audits, and tells the added orgs', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await release('1.2.0');
    await initial('1.0.0');
    await orgDefault(B, '1.0.0');

    const first = await consoleSvc.replaceRollout('1.1.0', [A, B.toUpperCase(), A], 'u-op');
    expect(first).toEqual({
      members: [{ orgId: A, orgName: 'Acme', hasOrgDefault: false }, { orgId: B, orgName: 'Beta', hasOrgDefault: true }],
      added: [A, B],
      removed: [],
      moved: [],
    });
    await settled();
    expect(sent.map((n) => [n.subject, n.recipients.map((r) => r.orgId)])).toEqual(expect.arrayContaining([
      ['Your organization joined the canary for toolchain 1.1.0', [A]],
      ['Your organization joined the canary for toolchain 1.1.0', [B]],
    ]));
    expect(sent.find((n) => n.recipients[0].orgId === B)!.text).toContain('no effect while your organization default is set');
    expect(sent.every((n) => n.event === 'N34' && n.recipients.every((r) => r.permission === 'toolchain:manage'))).toBe(true);

    sent.length = 0;
    const second = await consoleSvc.replaceRollout('1.1.0', [B, C], 'u-op');
    expect(second).toMatchObject({ added: [C], removed: [A], moved: [] });
    expect(second.members.map((m) => m.orgId)).toEqual([B, C]);

    // One canary per org: C moves from 1.1.0 to 1.2.0, and the move is reported.
    const moved = await consoleSvc.replaceRollout('1.2.0', [C], 'u-op');
    expect(moved).toMatchObject({ added: [C], removed: [], moved: [{ orgId: C, fromReleaseVersion: '1.1.0' }] });
    expect((await consoleSvc.getCanary('1.1.0')).members.map((m) => m.orgId)).toEqual([B]);
    expect(audits('toolchain.rollout.update').at(-1)).toMatchObject({
      outcome: 'success', details: { releaseVersion: '1.2.0', added: [C], removed: [], moved: [{ orgId: C, fromReleaseVersion: '1.1.0' }] },
    });

    // An empty set clears it.
    await expect(consoleSvc.replaceRollout('1.2.0', [], 'u-op')).resolves.toMatchObject({ members: [], removed: [C] });
  });

  it('a team inherits its root\'s org default: the picker flags "no effect"', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await orgDefault(A, '1.0.0');
    const out = await consoleSvc.replaceRollout('1.1.0', [TEAM], 'u-op');
    expect(out.members).toEqual([{ orgId: TEAM, orgName: TEAM, hasOrgDefault: true }]);
  });

  it('refuses a release failing the canary guards (codes pass through), the platform default, the system org and an unknown release', async () => {
    await release('1.0.0');
    await release('1.1.0', { scanned: false });
    await initial('1.0.0');
    await expect(consoleSvc.replaceRollout('1.1.0', [A], 'u-op')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_UNSCANNED' });
    await expect(consoleSvc.replaceRollout('1.0.0', [A], 'u-op')).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    await expect(consoleSvc.replaceRollout('1.0.0', [SYSTEM], 'u-op')).rejects.toMatchObject({ statusCode: 400 });
    await expect(consoleSvc.replaceRollout('7.7.7', [A], 'u-op')).rejects.toMatchObject({ statusCode: 404 });
    expect(audits('toolchain.rollout.update').every((a) => a.outcome === 'failure')).toBe(true);
    expect((await raw.query('SELECT count(*)::int AS n FROM toolchain_rollout')).rows).toEqual([{ n: 0 }]);
  });

  it('the gate: counted runs, orgs and failure rate against the default, with the console thresholds; waived for a former default', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await synth(null, 'org-base', '1.0.0', 'SUCCEEDED');
    await synth(null, A, '1.1.0', 'SUCCEEDED');
    await synth(null, B, '1.1.0', 'FAILED');
    const closed = await consoleSvc.getCanary('1.1.0');
    expect(closed.gate).toMatchObject({
      passes: false, runs: 2, orgs: 2, failureRate: 50, defaultFailureRate: 0, thresholds: { n: 20, m: 2, t: 5 }, waived: false, baselineReleaseVersion: '1.0.0',
    });
    const open = await consoleSvc.getCanary('1.1.0', { n: 2, m: 2, t: 60 });
    expect(open.gate).toMatchObject({ passes: true, thresholds: { n: 2, m: 2, t: 60 }, shortfalls: [] });
    expect((await consoleSvc.getCanary('1.0.0')).gate).toMatchObject({ passes: true, waived: true });
  });
});

describe('Set as platform default — preview, guards, promotion, notices', () => {
  /** A: follows (2 unpinned + 1 pinned); B: own default; C: canary of another release; D: follows; TEAM: inherits A (follows). */
  async function world() {
    await release('1.0.0');
    await release('1.1.0');
    await release('1.2.0');
    await initial('1.0.0');
    await pipeline(A);
    await pipeline(A);
    await pipeline(A, { pin: '1.0.0' });
    await pipeline(B);
    await pipeline(C);
    await pipeline(D);
    await orgDefault(B, '1.0.0');
    await consoleSvc.replaceRollout('1.2.0', [C], 'u-op');
    sent.length = 0;
  }

  it('the preview shows the blast radius and every §8 guard, without writing', async () => {
    await world();
    const out = await consoleSvc.previewDefault('1.1.0');
    expect(out.currentDefault).toBe('1.0.0');
    expect(out.blastRadius).toEqual({ followingPipelines: 3, followingOrgs: 2, orgsWithOwnDefault: 1, pinnedPipelines: 1 });
    expect(out.guards).toEqual([
      { code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', ok: true },
      { code: 'TOOLCHAIN_GUARD_UNSCANNED', ok: true },
      { code: 'TOOLCHAIN_GUARD_VULN_FLOOR', ok: true },
      { code: 'TOOLCHAIN_GUARD_METADATA', ok: true },
      { code: 'TOOLCHAIN_GUARD_CANARY_GATE', ok: false, detail: expect.stringContaining('has not passed the canary gate') },
    ]);
    expect((await consoleSvc.previewDefault('1.1.0', { n: 1, m: 1, t: 100 })).guards.at(-1)).toMatchObject({ ok: false }); // no runs at all
    expect(await platformDefault()).toBe('1.0.0');

    // A team that inherits its root's default is "own default" too.
    await orgDefault(A, '1.0.0');
    expect((await consoleSvc.previewDefault('1.1.0')).blastRadius).toEqual({ followingPipelines: 1, followingOrgs: 1, orgsWithOwnDefault: 2, pinnedPipelines: 1 });
  });

  it('the preview names the failing guard for an unscanned or incomplete release', async () => {
    await release('1.0.0');
    await release('1.1.0', { scanned: false });
    await upload('pipeline-bootstrap', '1.2.0');
    expect((await consoleSvc.previewDefault('1.1.0')).guards.filter((g) => !g.ok).map((g) => g.code)).toEqual(['TOOLCHAIN_GUARD_UNSCANNED', 'TOOLCHAIN_GUARD_CANARY_GATE']);
    const incomplete = (await consoleSvc.previewDefault('1.2.0')).guards;
    expect(incomplete[0]).toMatchObject({ code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', ok: false, detail: expect.stringContaining('missing: cdk-synth') });
    expect(incomplete.slice(1).every((g) => !g.ok && /Not checked/.test(g.detail ?? ''))).toBe(true);
    await expect(consoleSvc.previewDefault('7.7.7')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('promotion refuses with the guard codes (canary gate, stale expected default), then passes with an override and notifies by audience', async () => {
    await world();
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0' }, 'u-op')).rejects.toMatchObject({
      statusCode: 409, code: 'TOOLCHAIN_GUARD_CANARY_GATE', details: { gate: { passed: false } },
    });
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: null, overrideReason: 'x' }, 'u-op')).rejects.toMatchObject({
      statusCode: 409, code: 'TOOLCHAIN_DEFAULT_CHANGED',
    });
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', overrideReason: 'CVE hotfix' }, 'u-op'))
      .resolves.toEqual({ platformDefault: '1.1.0', changed: true });
    expect(await platformDefault()).toBe('1.1.0');
    expect(audits('toolchain.default.set').at(-1)).toMatchObject({ outcome: 'success', details: { gateOverride: { reason: 'CVE hotfix' } } });

    await settled();
    const following = sent.find((n) => n.subject === 'Pipeline toolchain is updating to 1.1.0')!;
    expect(following.recipients.map((r) => r.orgId).sort()).toEqual([A, D]);
    expect(following.text).toContain("effective on each pipeline's next run");
    const newer = sent.find((n) => n.subject === 'A newer platform toolchain (1.1.0) is available')!;
    expect(newer.recipients.map((r) => r.orgId)).toEqual([B]);
    expect(newer.text).toContain('Your org stays on 1.0.0 until you change it.');
    // The canary member of another release hears nothing.
    expect(sent.some((n) => n.recipients.some((r) => r.orgId === C))).toBe(false);
  });

  it('the console thresholds open the gate: promotion with no override', async () => {
    await world();
    await synth(null, A, '1.1.0', 'SUCCEEDED');
    await synth(null, D, '1.1.0', 'SUCCEEDED');
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', canaryGate: { n: 2, m: 2, t: 5 } }, 'u-op'))
      .resolves.toEqual({ platformDefault: '1.1.0', changed: true });
    expect(audits('toolchain.default.set').at(-1)?.details).toEqual({ releaseVersion: '1.1.0', previousReleaseVersion: '1.0.0' });
  });

  it('re-promoting the current default changes nothing and announces nothing', async () => {
    await world();
    await expect(consoleSvc.promoteRelease('1.0.0', { expectedCurrentDefault: '1.0.0' }, 'u-op')).resolves.toEqual({ platformDefault: '1.0.0', changed: false });
    await settled();
    expect(sent).toEqual([]);
  });

  it('announcePromotion on its own: the audiences and their counts', async () => {
    await world();
    await expect(consoleSvc.announcePromotion('1.2.0')).resolves.toEqual({ followingOrgs: 2, ownDefaultOrgs: 1 });
  });
});

describe('lifecycle, history', () => {
  it('yank of the default restores the previous one; deprecate; delete refused while in use; history newest first', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await initial('1.0.0');
    await consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', overrideReason: 'go' }, 'u-op');
    await expect(consoleSvc.yankConsoleRelease('1.1.0', 'synth regression', 'u-op')).resolves.toEqual({ restoredDefault: '1.0.0' });
    expect(await platformDefault()).toBe('1.0.0');
    await expect(consoleSvc.yankConsoleRelease('1.0.0', 'no', 'u-op')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_DEFAULT_REQUIRED' });

    const { history } = await consoleSvc.getDefaultHistory();
    expect(history.map((h) => [h.releaseVersion, h.previousReleaseVersion, h.kind])).toEqual([
      ['1.0.0', '1.1.0', 'restore'],
      ['1.1.0', '1.0.0', 'set'],
      ['1.0.0', null, 'initial'],
    ]);
    expect(history[1]).toMatchObject({ setBy: 'u-op', reason: 'go', setAt: expect.any(String) });

    await pipeline(A, { pin: '1.1.0' });
    await expect(consoleSvc.deleteConsoleRelease('1.1.0', 'u-op')).rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_VERSION_IN_USE', details: { pinnedPipelines: 1 } });
    await expect(consoleSvc.deleteConsoleRelease('1.0.0', 'u-op')).rejects.toMatchObject({ code: 'PLUGIN_VERSION_IN_USE', details: { platformDefault: true } });

    await release('1.2.0');
    await consoleSvc.deprecateConsoleRelease('1.2.0', 'u-op', 'superseded');
    expect((await consoleSvc.listConsoleReleases()).releases.find((r) => r.releaseVersion === '1.2.0')?.status).toBe('deprecated');
    await consoleSvc.deleteConsoleRelease('1.2.0', 'u-op');
    expect((await consoleSvc.listConsoleReleases()).releases.map((r) => r.releaseVersion)).not.toContain('1.2.0');
  });
});

describe('Affected + recovery notice', () => {
  it('lists pipelines on the release whose latest synth failed, by org, and tells each org its own pipelines', async () => {
    await release('1.0.0');
    const broken = await pipeline(A, { deployed: '1.0.0' });
    const healed = await pipeline(B, { deployed: '1.0.0' });
    const otherRelease = await pipeline(C, { deployed: '1.1.0' });
    await synth(broken, A, '1.0.0', 'SUCCEEDED', 10);
    await synth(broken, A, '1.0.0', 'FAILED', 1);
    await synth(healed, B, '1.0.0', 'FAILED', 10);
    await synth(healed, B, '1.0.0', 'SUCCEEDED', 1);
    await synth(otherRelease, C, '1.1.0', 'FAILED', 1);

    expect(await consoleSvc.getAffected('1.0.0')).toEqual({
      releaseVersion: '1.0.0',
      orgs: [{ orgId: A, orgName: 'Acme', pipelineCount: 1, pipelineIds: [broken] }],
    });

    await expect(consoleSvc.notifyAffected('1.0.0', 'u-op')).resolves.toEqual({ notifiedOrgs: 1, notifiedPipelines: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'N34', recipients: [{ kind: 'org_permission', orgId: A, permission: 'pipelines:write' }] });
    expect(sent[0]!.text).toContain(`pipeline-manager pipeline deploy --id ${broken}`);
    expect(sent[0]!.text).not.toContain(healed);
    expect(audits('toolchain.recovery.notify').at(-1)).toMatchObject({
      outcome: 'success', details: { releaseVersion: '1.0.0', affectedOrgs: 1, affectedPipelines: 1, notifiedOrgs: 1, notifiedPipelines: 1 },
    });

    sent.length = 0;
    await expect(consoleSvc.notifyAffected('9.9.9', 'u-op')).resolves.toEqual({ notifiedOrgs: 0, notifiedPipelines: 0 });
    expect(sent).toEqual([]);
  });

  it('a relay failure for one org is counted out, not thrown', async () => {
    await release('1.0.0');
    const p = await pipeline(A, { deployed: '1.0.0' });
    await synth(p, A, '1.0.0', 'FAILED');
    send.mockImplementationOnce(async () => { throw new Error('relay down'); });
    await expect(consoleSvc.notifyAffected('1.0.0', 'u-op')).resolves.toEqual({ notifiedOrgs: 0, notifiedPipelines: 0 });
  });
});

describe('Cleanup candidates', () => {
  async function defaults(...versions: string[]) {
    let minute = 100;
    for (const v of versions) {
      await raw.query("INSERT INTO toolchain_release (release_version, created_by) VALUES ($1, 'loader') ON CONFLICT DO NOTHING", [v]);
      await raw.query("INSERT INTO toolchain_default_history (release_version, set_by, kind, set_at) VALUES ($1, 'op', 'set', now() - ($2 || ' minutes')::interval)", [v, String(minute--)]);
    }
    await raw.query(`INSERT INTO toolchain_platform_default (singleton, release_version, set_by) VALUES (true, $1, 'op')
      ON CONFLICT (singleton) DO UPDATE SET release_version = EXCLUDED.release_version`, [versions.at(-1)]);
  }

  it('nothing until K defaults exist; then unreferenced releases older than the last K defaults', async () => {
    await release('1.0.0');
    await release('1.1.0');
    await release('1.2.0');
    await release('1.3.0');
    await defaults('2.0.0', '2.1.0', '2.2.0', '2.3.0');
    expect(await consoleSvc.getCleanupCandidates()).toEqual({ candidates: [] });

    await defaults('2.4.0');
    await pipeline(A, { pin: '1.1.0' });
    await pipeline(B, { deployed: '1.2.0' });
    await orgDefault(C, '1.3.0');
    await release('3.0.0'); // newer than the floor: kept
    expect(await consoleSvc.getCleanupCandidates()).toEqual({ candidates: [{ releaseVersion: '1.0.0', createdAt: expect.any(String) }] });
  });
});
