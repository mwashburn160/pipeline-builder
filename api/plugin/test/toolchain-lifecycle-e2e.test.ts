// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain's whole platform-side LIFECYCLE, in order, as one
 * deployment lives it (docs/plans/bootstrap-image-versioning.md Phase 6,
 * steps 1-3), against a REAL Postgres (PGlite with the shipped
 * postgres-init.sql, RLS enforced):
 *
 *   1. fresh install: both halves uploaded, the initial default set (D14);
 *   2. a second release uploaded (what `upgrade-toolchain.sh` does): it is
 *      `available` and reaches NO pipeline;
 *   3. canary -> promote (the gate opened by real run rows) -> rollback ->
 *      re-promote -> yank-restore, through the console service.
 *
 * After every step the RESOLVER — what the plugin lookup answers
 * `pipeline-manager pipeline synth` with — is asserted for a canary org, a
 * following org and an org with its own default: the release, how it was
 * reached, and that both halves (digests and the toolchain versions the synth
 * pins `cliVersion` / `cdkAssetsCliVersion` from) come from that ONE release.
 * What the synth does with that answer is pipeline-core's pipeline-builder
 * suite and pipeline-manager's toolchain suite.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
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

const CANARY = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const CANARY_2 = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const FOLLOWER = 'ccccccccccccccccccccccc2';
const OWN_DEFAULT = 'ddddddddddddddddddddddd2';
const NAMES: Record<string, string> = { [CANARY]: 'Canary', [CANARY_2]: 'Canary Two', [FOLLOWER]: 'Follower', [OWN_DEFAULT]: 'Own' };

const toolchainOf = (v: string) => ({ pipelineManager: `4.4.${v.split('.')[1]}`, awsCdk: `2.11${v.split('.')[1]}0.0`, cdkAssets: '4.8.0', esbuild: '0.28.1', pnpm: '12.14.0', node: '26.13.0' });
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

/** The digests each release's halves were uploaded with. */
const uploaded = new Map<string, { bootstrap: string; synth: string }>();

async function upload(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, imageDigest: string) {
  return realPipelineData.runWithTenantContext({ orgId: SYSTEM, isSuperAdmin: false }, () => pluginService.deployVersion({
    orgId: SYSTEM,
    name,
    version,
    pluginType: (name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep') as never,
    computeType: 'SMALL' as never,
    metadata: name === 'pipeline-bootstrap' ? realApiCore.toolchainMetadata(toolchainOf(version)) : {},
    visibility: 'public',
    buildType: 'prebuilt',
    imageDigest,
  }, 'official-catalog-loader', { isSystemAdmin: true, canPublish: true }));
}

/** What `load-plugins.sh --category toolchain` does for one release: bootstrap first, then cdk-synth; then the async scan lands. */
async function installRelease(version: string) {
  const d = { bootstrap: digest(), synth: digest() };
  await upload('pipeline-bootstrap', version, d.bootstrap);
  await upload('cdk-synth', version, d.synth);
  await raw.query('UPDATE plugins SET scanned_at = now(), vuln_critical_fixable = 0, vuln_high_fixable = 0 WHERE version = $1', [version]);
  uploaded.set(version, d);
}

async function synthRun(orgId: string, releaseVersion: string, status: 'SUCCEEDED' | 'FAILED') {
  await raw.query(
    `INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name, action_name, completed_at, toolchain_release)
     VALUES ($1, $2, 'codepipeline', 'ACTION', $3, $4, 'Build', 'cdk-synth-0a1b', now(), $5)`,
    [randomUUID(), orgId, status, randomUUID(), releaseVersion]);
}

async function pipeline(orgId: string) {
  const project = `p-${randomUUID().slice(0, 8)}`;
  await raw.query(
    "INSERT INTO pipelines (org_id, created_by, updated_by, project, organization, pipeline_name, props) VALUES ($1, 'u', 'u', $2, 'acme', $2, $3)",
    [orgId, project, JSON.stringify({ project, organization: 'acme' })]);
}

/** The resolver, exactly as the plugin lookup runs it, with the test DB and a flat hierarchy. */
const resolve = (orgId: string) => realPipelineData.resolveManagedToolchainWith({
  read: (fn) => realPipelineData.runWithTenantContext({ isSuperAdmin: true }, () => testDb.withTenantTx((tx) => fn(tx as never))),
  getParent: async () => undefined,
}, { orgId });

/** Assert `orgId` resolves `releaseVersion` via `via`, with BOTH halves from that one release. */
async function expectResolves(orgId: string, releaseVersion: string, via: string) {
  const r = await resolve(orgId);
  const d = uploaded.get(releaseVersion)!;
  expect({ org: NAMES[orgId], release: r.releaseVersion, via: r.resolvedVia }).toEqual({ org: NAMES[orgId], release: releaseVersion, via });
  expect(r.bootstrap).toMatchObject({ orgId: SYSTEM, name: 'pipeline-bootstrap', version: releaseVersion, imageDigest: d.bootstrap });
  expect(r.synth).toMatchObject({ orgId: SYSTEM, name: 'cdk-synth', version: releaseVersion, imageDigest: d.synth });
  expect(realApiCore.toolchainFromMetadata(r.bootstrap.metadata)).toEqual(toolchainOf(releaseVersion));
}

const platformDefault = async () => (await raw.query<{ release_version: string }>('SELECT release_version FROM toolchain_platform_default')).rows[0]?.release_version ?? null;
const statusOf = async (v: string) => (await consoleSvc.listConsoleReleases()).releases.find((r) => r.releaseVersion === v)?.status;
/** Every toolchain audit action so far (the jest config clears mocks between tests, so they are collected after each). */
const auditActions: string[] = [];
afterEach(() => {
  auditActions.push(...mockRecordAudit.mock.calls.map((c) => (c[0] as { action: string }).action).filter((a) => a.startsWith('toolchain.')));
});

beforeAll(async () => {
  setEcosystemNotifyClientForTests({ send: jest.fn(async () => ({ ok: true }) as const) });
  consoleSvc.setToolchainConsoleDepsForTests({
    orgNames: async (ids) => Object.fromEntries(ids.filter((id) => NAMES[id]).map((id) => [id, NAMES[id]!])),
    getParent: async () => undefined,
  });
  for (const org of Object.keys(NAMES)) await pipeline(org);
}, 120_000);
afterAll(async () => {
  setEcosystemNotifyClientForTests(undefined);
  consoleSvc.setToolchainConsoleDepsForTests(null);
  await raw.close();
});

describe('managed toolchain lifecycle, end to end', () => {
  it('before install: no default, so every synth is refused with TOOLCHAIN_NO_DEFAULT', async () => {
    await expect(resolve(FOLLOWER)).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_NO_DEFAULT' });
  });

  it('1. fresh install: the initial default (D14) is set once and every org resolves it', async () => {
    await installRelease('1.0.0');
    // Uploading never promotes.
    expect(await platformDefault()).toBeNull();
    await releaseSvc.setPlatformDefault({ releaseVersion: '1.0.0', kind: 'initial', actor: 'service:deploy-bootstrap' });
    expect(await platformDefault()).toBe('1.0.0');
    await expect(releaseSvc.setPlatformDefault({ releaseVersion: '1.0.0', kind: 'initial', actor: 'service:deploy-bootstrap' }))
      .rejects.toMatchObject({ statusCode: 409 });
    for (const org of [CANARY, CANARY_2, FOLLOWER, OWN_DEFAULT]) await expectResolves(org, '1.0.0', 'default');
    // An org chooses its own default (it stays put through everything below).
    await raw.query("INSERT INTO org_toolchain_default (org_id, release_version, set_by) VALUES ($1, '1.0.0', 'u')", [OWN_DEFAULT]);
    await expectResolves(OWN_DEFAULT, '1.0.0', 'org-default');
  });

  it('2. a second release (upgrade-toolchain.sh) is available and reaches no pipeline', async () => {
    await installRelease('1.1.0');
    expect(await statusOf('1.1.0')).toBe('available');
    expect(await platformDefault()).toBe('1.0.0');
    await expectResolves(CANARY, '1.0.0', 'default');
    await expectResolves(FOLLOWER, '1.0.0', 'default');
  });

  it('3a. canary: only the canary orgs move', async () => {
    await consoleSvc.replaceRollout('1.1.0', [CANARY, CANARY_2, OWN_DEFAULT], 'u-op');
    expect(await statusOf('1.1.0')).toBe('canary');
    await expectResolves(CANARY, '1.1.0', 'canary');
    await expectResolves(CANARY_2, '1.1.0', 'canary');
    await expectResolves(FOLLOWER, '1.0.0', 'default');
    // A canary has no effect on an org with its own default.
    await expectResolves(OWN_DEFAULT, '1.0.0', 'org-default');
  });

  it('3b. promote: refused until the canary gate opens on real runs, then every follower moves', async () => {
    const gate = { n: 4, m: 2, t: 5 };
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', canaryGate: gate }, 'u-op'))
      .rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_GUARD_CANARY_GATE' });
    // One org can't open it alone (per-org cap ceil(N/M) = 2).
    for (let i = 0; i < 4; i++) await synthRun(CANARY, '1.1.0', 'SUCCEEDED');
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', canaryGate: gate }, 'u-op'))
      .rejects.toMatchObject({ code: 'TOOLCHAIN_GUARD_CANARY_GATE' });
    for (let i = 0; i < 2; i++) await synthRun(CANARY_2, '1.1.0', 'SUCCEEDED');
    expect((await consoleSvc.getCanary('1.1.0', gate)).gate).toMatchObject({ passes: true, orgs: 2, runs: 4 });

    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0', canaryGate: gate }, 'u-op'))
      .resolves.toEqual({ platformDefault: '1.1.0', changed: true });
    expect(await statusOf('1.1.0')).toBe('default');
    // Promotion clears the release's canary rows: the canary orgs now follow the default.
    await expectResolves(CANARY, '1.1.0', 'default');
    await expectResolves(FOLLOWER, '1.1.0', 'default');
    await expectResolves(OWN_DEFAULT, '1.0.0', 'org-default');
  });

  it('3c. rollback: "Set previous as default" (gate waived — it has been default) moves followers back', async () => {
    await expect(consoleSvc.promoteRelease('1.0.0', { expectedCurrentDefault: '1.1.0' }, 'u-op'))
      .resolves.toEqual({ platformDefault: '1.0.0', changed: true });
    await expectResolves(FOLLOWER, '1.0.0', 'default');
    await expectResolves(CANARY, '1.0.0', 'default');
    // Re-promoting the former default is waived too.
    await expect(consoleSvc.promoteRelease('1.1.0', { expectedCurrentDefault: '1.0.0' }, 'u-op'))
      .resolves.toEqual({ platformDefault: '1.1.0', changed: true });
    await expectResolves(FOLLOWER, '1.1.0', 'default');
  });

  it('3d. yank-restore: yanking the default restores the previous one in the same step', async () => {
    await expect(consoleSvc.yankConsoleRelease('1.1.0', 'synth regression', 'u-op')).resolves.toEqual({ restoredDefault: '1.0.0' });
    expect(await platformDefault()).toBe('1.0.0');
    expect(await statusOf('1.1.0')).toBe('yanked');
    await expectResolves(FOLLOWER, '1.0.0', 'default');
    await expectResolves(CANARY, '1.0.0', 'default');
    // The last live default can't be yanked away.
    await expect(consoleSvc.yankConsoleRelease('1.0.0', 'no', 'u-op')).rejects.toMatchObject({ statusCode: 409, code: 'TOOLCHAIN_DEFAULT_REQUIRED' });
  });

  it('the history and the audit trail record every step', async () => {
    const { history } = await consoleSvc.getDefaultHistory();
    expect(history.map((h) => [h.releaseVersion, h.previousReleaseVersion, h.kind])).toEqual([
      ['1.0.0', '1.1.0', 'restore'],
      ['1.1.0', '1.0.0', 'set'],
      ['1.0.0', '1.1.0', 'set'],
      ['1.1.0', '1.0.0', 'set'],
      ['1.0.0', null, 'initial'],
    ]);
    const actions = auditActions;
    for (const a of ['toolchain.default.initial', 'toolchain.rollout.update', 'toolchain.default.set', 'toolchain.release.yank', 'toolchain.default.restore']) {
      expect(actions).toContain(a);
    }
  });
});
