// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly toolchain fixes, propose-only, against a REAL Postgres (PGlite, the
 * shipped postgres-init.sql): queueing a flagged managed toolchain release as
 * ONE toolchain remediation (or the owner request, by PLUGIN_REMEDIATION_TOOLCHAINS),
 * the run (the engine on the bootstrap, cdk-synth FROM its candidate, the
 * strict verification, the recorded release candidate — never published), and
 * the system-org decision routes (approve publishes both halves and sends N34,
 * reject discards, export serves the spec patch).
 *
 * The build inputs are the CHECKED-IN deploy/toolchain/** files, so the spec
 * patch is the one the release workflow would really apply.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { bindTestAuditService, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;
const audits = bindTestAuditService('plugin');

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData, withTenantTx: testDb.withTenantTx, pipelinesOnVersion: jest.fn<AnyFn>(async () => []),
}));
const counters: Array<[string, Record<string, string>]> = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (name: string, labels: Record<string, string>) => { counters.push([name, labels]); },
  setGauge: jest.fn(),
  withRoute: (fn: (a: unknown) => Promise<void>) => async (rq: any, rs: any) => {
    try { await fn({ req: rq, res: rs, ctx: { log: jest.fn() } }); } catch (err: any) {
      rs.status(typeof err.statusCode === 'number' ? err.statusCode : 500).json({ success: false, code: err.code, message: err.message, details: err.details });
    }
  },
}));
const notices: any[] = [];
jest.unstable_mockModule('../src/services/remediation-notices.js', () => ({
  sendRemediationNotice: jest.fn(async (n: unknown) => { notices.push(n); }),
  remediationNoticesEnabled: () => true,
}));
jest.unstable_mockModule('../src/services/ecosystem/remediation-fixes.js', () => ({
  sendPublisherFixRequest: jest.fn<AnyFn>(async () => undefined),
  openOfficialListingFix: jest.fn<AnyFn>(async () => ({ requestId: 'r' })),
  storeOfficialExport: jest.fn<AnyFn>(async () => 'k'),
  clearedFacts: () => ({ advisoryIds: [], criticalCleared: 0, highCleared: 0, kev: false }),
  remediationOwnership: () => 'official',
}));
const artifacts = new Map<string, string>();
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({
  putRemediationArtifact: jest.fn(async (key: string, body: string | Buffer) => { artifacts.set(key, String(body)); }),
  recordVersionSource: jest.fn<AnyFn>(async () => null),
  fetchPluginSource: jest.fn<AnyFn>(async () => 'missing'),
  pluginSourcesBucket: () => 'plugin-sources',
}));
jest.unstable_mockModule('../src/services/remediation/rollout.js', () => ({ startTenantRollout: jest.fn<AnyFn>(async () => ({ ok: true })), cancelRollout: jest.fn<AnyFn>(async () => true), setRolloutClientForTests: jest.fn() }));
const hygieneEvents: any[] = [];
/** Fault injection: the next persist of this half throws; the next N notices throw. */
const faults: { persistName: string | null; notice: number } = { persistName: null, notice: 0 };
jest.unstable_mockModule('../src/services/toolchain-hygiene.js', () => ({
  notifyToolchainHygiene: jest.fn(async (e: unknown) => {
    if (faults.notice > 0) { faults.notice--; throw new Error('crash before the notice'); }
    hygieneEvents.push(e); return { orgDefaultOrgs: 1, pinnedOrgs: 0 };
  }),
}));
const persisted: any[] = [];
jest.unstable_mockModule('../src/services/version-persist.js', () => ({
  persistVersion: jest.fn(async (input: any) => {
    if (faults.persistName === input.pluginRecord.name) { faults.persistName = null; throw new Error('crash while storing'); }
    persisted.push(input);
    const { rows } = await raw.query<{ id: string; version: string; name: string }>(
      `INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active)
       VALUES ($1, $2, $3, $4, $4, 'CodeBuildStep', $5, true) RETURNING id, version, name`,
      [input.orgId, input.pluginRecord.name, input.pluginRecord.version, input.userId, input.image.imageDigest]);
    return rows[0];
  }),
}));
const enqueued: any[] = [];
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  getAllTierQueues: () => [],
  getHealthRedisConnection: () => ({}),
  getOrgTier: async () => 'unlimited',
  getTierQueue: () => ({ add: async (...a: unknown[]) => { enqueued.push(a); } }),
}));

const { setPluginServiceConfigForTests, loadPluginServiceConfig } = await import('../src/config.js');
const { queuePassRemediations } = await import('../src/services/remediation/queueing.js');
const { runRemediation } = await import('../src/queue/plugin-remediation.js');
const { toolchainRemediationSettings } = await import('../src/services/remediation/toolchain.js');
const { TOOLCHAIN_SYNTH_SMOKE_COMMAND, TOOLCHAIN_SMOKE_APP } = await import('../src/services/remediation/toolchain-smoke.js');
const { createToolchainFixRoutes } = await import('../src/routes/toolchain-fixes.js');
const { createRemediationRoutes } = await import('../src/routes/remediations.js');
const { getRemediation } = await import('../src/services/remediation/store.js');

const SYSTEM = realApiCore.SYSTEM_ORG_ID;
const REPO = join(import.meta.dirname, '..', '..', '..');
const repoFile = (dir: string, f: string) => readFileSync(join(REPO, 'deploy', 'toolchain', dir, f), 'utf8');
const INPUTS = {
  'pipeline-bootstrap': { 'Dockerfile': repoFile('pipeline-bootstrap', 'Dockerfile'), 'plugin-spec.yaml': repoFile('pipeline-bootstrap', 'plugin-spec.yaml') },
  'cdk-synth': { 'Dockerfile': repoFile('cdk-synth', 'Dockerfile'), 'plugin-spec.yaml': repoFile('cdk-synth', 'plugin-spec.yaml') },
};
const SPEC = INPUTS['pipeline-bootstrap']['plugin-spec.yaml'];
const RELEASE = /^version:\s*(\S+)/m.exec(SPEC)![1]!;
const [MAJ, MIN, PAT] = RELEASE.split('.').map(Number);
const NEXT = `${MAJ}.${MIN}.${PAT! + 1}`;
const TOOLCHAIN = {
  pipelineManager: /pipelineManager: "([^"]+)"/.exec(SPEC)![1]!,
  awsCdk: /awsCdk: "([^"]+)"/.exec(SPEC)![1]!,
  cdkAssets: /cdkAssets: "([^"]+)"/.exec(SPEC)![1]!,
  node: /node: "([^"]+)"/.exec(SPEC)![1]!,
};
const LABELS = Object.fromEntries(Object.entries(realApiCore.TOOLCHAIN_IMAGE_LABELS).map(([k, label]) => [label, TOOLCHAIN[k as keyof typeof TOOLCHAIN]]));
const D = (c: string) => `sha256:${c.repeat(64)}`;
const FROM_DIGEST = { 'pipeline-bootstrap': D('1'), 'cdk-synth': D('2') } as const;
const CAND_DIGEST = { 'pipeline-bootstrap': D('b'), 'cdk-synth': D('5') } as const;

function finding(over: Record<string, unknown> = {}): any {
  return { id: 'CVE-2026-1', severity: 'critical', packageName: 'perl-base', packageVersion: '5.36-1', fixedIn: ['5.36-2'], packageType: 'deb', purl: 'pkg:deb/debian/perl-base@5.36-1', locations: [{ path: '/var/lib/dpkg/status', layerID: 'sha256:l' }], ...over };
}
function summary(findings: any[]): any {
  return { criticalFixable: findings.length, highFixable: 0, critical: findings.length, high: 0, medium: 0, low: 0, kev: 0, findings, truncated: false, waived: [], scannedAt: '2026-11-20T00:00:00Z', trigger: 'rescan', imageDigest: D('1'), dbBuiltAt: null };
}

async function half(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, findings: any[]): Promise<string> {
  const metadata = name === 'pipeline-bootstrap' ? realApiCore.toolchainMetadata(TOOLCHAIN) : {};
  const { rows } = await raw.query<{ id: string }>(
    `INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active, metadata, scan_summary, build_type)
     VALUES ($1, $2, $3, 'loader', 'loader', $4, $5, true, $6, $7, 'prebuilt') RETURNING id`,
    [SYSTEM, name, version, name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep', FROM_DIGEST[name], JSON.stringify(metadata), JSON.stringify(summary(findings))]);
  return rows[0]!.id;
}
async function release(version = RELEASE, findings = [finding()]) {
  const bs = await half('pipeline-bootstrap', version, findings);
  const synth = await half('cdk-synth', version, findings);
  await raw.query('INSERT INTO toolchain_release (release_version, created_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [version, 'loader']);
  return { bs, synth };
}
const cand = (id: string, name: string, findings: any[], version = RELEASE): any =>
  ({ kind: 'plugin', id, orgId: SYSTEM, name, version, imageDigest: D('1'), deleted: false, yanked: false, createdBy: 'loader', summary: summary(findings) });
const rowsOf = async (pluginId: string) => (await raw.query<any>('SELECT * FROM plugin_remediations WHERE plugin_id = $1 ORDER BY created_at', [pluginId])).rows;
const enqueue = jest.fn<AnyFn>(async () => undefined);

function inputsStore(seed: Record<string, Record<string, string>> | null = INPUTS) {
  const m = new Map<string, Record<string, string>>();
  if (seed) for (const [h, files] of Object.entries(seed)) m.set(`${RELEASE}/${h}`, files);
  return {
    m,
    read: async (v: string, h: string) => m.get(`${v}/${h}`) ?? null,
    write: async (v: string, h: string, files: Record<string, string>) => { m.set(`${v}/${h}`, files); },
  };
}

/** Engine + toolchain ports: every build clears the finding unless told otherwise. */
function ports(o: { labels?: Record<string, string>; smokeFails?: boolean; gateRefusal?: string | null; clears?: boolean } = {}): any {
  const discarded: string[] = [];
  const builds: any[] = [];
  const smokes: Array<{ name: string; command: string }> = [];
  return {
    discarded,
    builds,
    smokes,
    fetchSource: async () => 'missing',
    openSource: async () => { throw new Error('no source'); },
    contractOf: async () => null,
    build: async (b: any) => { builds.push(b); return CAND_DIGEST[b.name as keyof typeof CAND_DIGEST]; },
    scan: async () => ({ scan: { findings: o.clears === false ? [finding()] : [], waivedKeys: new Set(), refusal: o.gateRefusal ?? null }, facts: { scannedAt: new Date() }, summary: summary([]) }),
    imageConfig: async (r: { name: string }) => ({ user: r.name === 'cdk-synth' ? '1000:1000' : '', entrypoint: null, cmd: ['bash'], workingDir: '/app' }),
    imageLabels: async () => o.labels ?? LABELS,
    layerIds: async () => [],
    smokeTest: async (r: { name: string }, command: string) => { smokes.push({ name: r.name, command }); if (o.smokeFails) throw new Error('synth failed'); },
    resolveDigest: async (ref: string) => (ref.startsWith('node:') ? D('e') : null),
    runTool: async () => undefined,
    discardImage: async (r: { digest: string }) => { discarded.push(r.digest); },
    imageReference: (r: { name: string; digest: string }) => `reg:5000/library/${r.name}@${r.digest}`,
    askAgent: async () => null,
    ensureSharedBase: async () => null,
  };
}

async function queuedToolchain(findings = [finding()]) {
  const { bs, synth } = await release(RELEASE, findings);
  await queuePassRemediations([cand(bs, 'pipeline-bootstrap', findings), cand(synth, 'cdk-synth', findings)], { enqueue });
  const [row] = await rowsOf(bs);
  return { bs, synth, row: (await getRemediation(row.id))! };
}

beforeEach(async () => {
  jest.clearAllMocks();
  faults.persistName = null; faults.notice = 0;
  notices.length = 0; persisted.length = 0; counters.length = 0; enqueued.length = 0; hygieneEvents.length = 0; artifacts.clear();
  await raw.exec('DELETE FROM plugin_remediations; DELETE FROM plugin_remediation_settings; DELETE FROM plugins; DELETE FROM toolchain_release;');
  setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20, concurrency: 2, toolchains: 'propose' });
});
afterAll(async () => { setPluginServiceConfigForTests(); await raw.close(); });

describe('PLUGIN_REMEDIATION_TOOLCHAINS', () => {
  it('is read through the api-core parser (default propose; invalid → propose with a warning)', () => {
    const warn = jest.fn();
    delete process.env.PLUGIN_REMEDIATION_TOOLCHAINS;
    expect(loadPluginServiceConfig(warn).remediation.toolchains).toBe('propose');
    process.env.PLUGIN_REMEDIATION_TOOLCHAINS = ' OFF ';
    expect(loadPluginServiceConfig(warn).remediation.toolchains).toBe('off');
    process.env.PLUGIN_REMEDIATION_TOOLCHAINS = 'apply';
    expect(loadPluginServiceConfig(warn).remediation.toolchains).toBe('propose');
    expect(warn).toHaveBeenCalledTimes(1);
    delete process.env.PLUGIN_REMEDIATION_TOOLCHAINS;
  });
});

describe('queueing a flagged toolchain release', () => {
  it('propose: ONE toolchain remediation for the release, on its bootstrap row, queued (not an owner request)', async () => {
    const { bs, synth, row } = await queuedToolchain([finding(), finding({ id: 'CVE-2026-2', packageName: 'tar', purl: 'pkg:deb/debian/tar@1.34' })]);
    expect(row).toMatchObject({ kind: 'toolchain', stage: 'queued', pluginId: bs, pluginName: 'pipeline-bootstrap', fromVersion: RELEASE });
    expect(row.targeted.map((f: any) => f.id).sort()).toEqual(['CVE-2026-1', 'CVE-2026-2']);
    expect(await rowsOf(synth)).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it('propose: only cdk-synth flagged still lands on the bootstrap row (one row per release); a second pass adds nothing', async () => {
    const { bs, synth } = await release();
    await queuePassRemediations([cand(synth, 'cdk-synth', [finding({ packageType: 'python', packageName: 'pip', purl: 'pkg:pypi/pip@23.0' })])], { enqueue });
    await queuePassRemediations([cand(synth, 'cdk-synth', [finding({ packageType: 'python', packageName: 'pip', purl: 'pkg:pypi/pip@23.0' })])], { enqueue });
    expect(await rowsOf(bs)).toEqual([expect.objectContaining({ kind: 'toolchain', stage: 'queued' })]);
  });

  it('off: the owner request, as before (MANAGED_TOOLCHAIN)', async () => {
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20, toolchains: 'off' });
    const { bs } = await release();
    await queuePassRemediations([cand(bs, 'pipeline-bootstrap', [finding()])], { enqueue });
    const [row] = await rowsOf(bs);
    expect(row).toMatchObject({ kind: 'plugin', stage: 'needs_owner', outcome: 'owner_request' });
    expect(row.remaining[0]).toMatchObject({ reason: 'no_patcher', detail: 'MANAGED_TOOLCHAIN' });
    expect(notices.map((n) => n.code)).toEqual(['N39']);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('nothing when the operator knob is off or nothing is targeted', async () => {
    const { bs } = await release();
    await queuePassRemediations([cand(bs, 'pipeline-bootstrap', [finding({ severity: 'medium' })])], { enqueue });
    setPluginServiceConfigForTests({ enabled: false, toolchains: 'propose' });
    await queuePassRemediations([cand(bs, 'pipeline-bootstrap', [finding()])], { enqueue });
    expect(await rowsOf(bs)).toHaveLength(0);
  });
});

describe('the candidate build', () => {
  it('library upgrades are capped at patch for a toolchain, whatever the org settings', () => {
    const s = toolchainRemediationSettings({ ...realApiCore.DEFAULT_PLUGIN_REMEDIATION_SETTINGS, libraryUpgradeLevel: 'major', libraryUpgradeLevelByType: { npm: 'major' }, libraryUpgradeLevelByPlugin: { 'pipeline-bootstrap': 'major' } });
    for (const t of ['npm', 'deb', 'go-module'] as const) {
      expect(realApiCore.effectiveLibraryUpgradeLevel(s, t, 'pipeline-bootstrap')).toBe('patch');
      expect(realApiCore.effectiveLibraryUpgradeLevel(s, t, 'cdk-synth')).toBe('patch');
    }
  });

  it('records a verified release candidate — never published, even with the system org in apply mode', async () => {
    await raw.query("INSERT INTO plugin_remediation_settings (org_id, mode) VALUES ($1, 'apply')", [SYSTEM]);
    const { row } = await queuedToolchain();
    const p = ports();
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('awaiting_approval');
    expect(persisted).toEqual([]);
    expect(p.discarded).toEqual([]);
    // Bootstrap first (Stage 1, its node base refreshed in tag), then cdk-synth FROM the candidate bootstrap by digest.
    expect(p.builds.map((b: any) => b.name)).toEqual(['pipeline-bootstrap', 'cdk-synth']);
    expect(p.builds[0].buildArgs).toEqual({});
    expect(p.builds[1].buildArgs).toEqual({ BOOTSTRAP_IMAGE: `reg:5000/library/pipeline-bootstrap@${CAND_DIGEST['pipeline-bootstrap']}` });
    // The synth smoke ran in both images, and is a real cdk synth.
    expect(p.smokes.map((s: any) => s.name)).toEqual(['pipeline-bootstrap', 'cdk-synth']);
    expect(p.smokes[0].command).toBe(TOOLCHAIN_SYNTH_SMOKE_COMMAND);
    const after = (await getRemediation(row.id))!;
    expect(after).toMatchObject({ stage: 'awaiting_approval', publishMode: 'propose', decidedAt: null, versionBump: 'patch', fixMethods: ['rebuild'] });
    const c = after.toolchainCandidate!;
    expect(c).toMatchObject({
      fromRelease: RELEASE,
      toRelease: NEXT,
      toolchain: TOOLCHAIN,
      synthSmoke: 'passed',
      bootstrap: { name: 'pipeline-bootstrap', digest: CAND_DIGEST['pipeline-bootstrap'], fromDigest: FROM_DIGEST['pipeline-bootstrap'], rebuilt: true },
      cdkSynth: { name: 'cdk-synth', digest: CAND_DIGEST['cdk-synth'], rebuilt: true },
    });
    expect(c.baseImage!.to).toMatch(new RegExp(`^node:${TOOLCHAIN.node.replace(/\./g, '\\.')}-slim@${D('e')}$`));
    expect(c.sourceDigest.from).toBe(/sourceDigest: "([^"]+)"/.exec(SPEC)![1]);
    expect(c.sourceDigest.to).not.toBe(c.sourceDigest.from);
    // The spec patch the release workflow applies.
    const diff = artifacts.get(after.exportKey!)!;
    expect(diff).toContain(`+version: ${NEXT}`);
    expect(diff).toContain(`+sourceDigest: "${c.sourceDigest.to}"`);
    expect(diff).toContain(`+ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:${NEXT}"`);
    expect(diff).toContain(`+ARG NODE_IMAGE=${c.baseImage!.to}`);
    expect(audits.mock.calls.map((x) => (x[0] as any).action)).toContain('toolchain.fix.proposed');
    expect(counters).toContainEqual(['toolchain_fix_candidates_total', { outcome: 'proposed' }]);
    expect(notices).toEqual([expect.objectContaining({ code: 'N36', orgId: SYSTEM, awaitingApproval: true, toVersion: NEXT })]);
  });

  it('refuses a candidate that changes a tool version: needs_owner, images discarded, nothing published', async () => {
    const { row } = await queuedToolchain();
    const p = ports({ labels: { ...LABELS, [realApiCore.TOOLCHAIN_IMAGE_LABELS.awsCdk]: '2.9999.0' } });
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('needs_owner');
    const after = (await getRemediation(row.id))!;
    expect(after).toMatchObject({ stage: 'needs_owner', outcome: 'owner_request', error: 'TOOL_VERSION_CHANGED', toolchainCandidate: null });
    expect(after.remaining[0]).toMatchObject({ reason: 'patch_broke_plugin', detail: 'TOOL_VERSION_CHANGED' });
    expect(p.discarded.sort()).toEqual([CAND_DIGEST['pipeline-bootstrap'], CAND_DIGEST['cdk-synth']].sort());
    expect(persisted).toEqual([]);
    expect(notices.map((n) => n.code)).toEqual(['N39']);
    expect(counters).toContainEqual(['toolchain_fix_candidates_total', { outcome: 'refused' }]);
  });

  it('refuses a candidate whose synth smoke fails', async () => {
    const { row } = await queuedToolchain();
    const p = ports({ smokeFails: true });
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('needs_owner');
    expect((await getRemediation(row.id))!).toMatchObject({ error: 'SYNTH_SMOKE_FAILED', toolchainCandidate: null });
    expect(p.discarded).toHaveLength(2);
    expect(persisted).toEqual([]);
  });

  it('refuses a candidate that still carries a targeted finding', async () => {
    const { row } = await queuedToolchain();
    const p = ports({ clears: false });
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('needs_owner');
    expect(persisted).toEqual([]);
  });

  it('a release whose build inputs were never kept goes to the owner without building anything', async () => {
    const { row } = await queuedToolchain();
    const p = ports();
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore(null) })).toBe('needs_owner');
    expect((await getRemediation(row.id))!).toMatchObject({ error: 'TOOLCHAIN_INPUTS_MISSING' });
    expect(p.builds).toEqual([]);
  });

  it('a release whose halves are gone is cancelled; a newer release supersedes the fix before anything is built', async () => {
    const first = await queuedToolchain();
    await raw.query("UPDATE plugins SET deleted_at = now() WHERE name = 'cdk-synth'");
    const p = ports();
    expect(await runRemediation(first.row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('failed');
    expect((await getRemediation(first.row.id))!).toMatchObject({ outcome: 'cancelled', error: 'VERSION_DELETED' });
    await raw.exec('DELETE FROM plugin_remediations; DELETE FROM plugins; DELETE FROM toolchain_release;');
    const second = await queuedToolchain();
    await half('pipeline-bootstrap', `${MAJ}.${MIN! + 1}.0`, []);
    expect(await runRemediation(second.row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('done');
    expect((await getRemediation(second.row.id))!.outcome).toBe('superseded');
    expect(p.builds).toEqual([]);
  });

  it('only cdk-synth flagged: the bootstrap keeps its image and cdk-synth is rebuilt FROM it', async () => {
    const pip = finding({ packageType: 'python', packageName: 'pip', purl: 'pkg:pypi/pip@23.0', id: 'CVE-2026-9' });
    const { bs } = await release(RELEASE, []);
    const synth = (await raw.query<{ id: string }>("SELECT id FROM plugins WHERE name = 'cdk-synth'")).rows[0]!.id;
    await raw.query('UPDATE plugins SET scan_summary = $2 WHERE id = $1', [synth, JSON.stringify(summary([pip]))]);
    await queuePassRemediations([cand(synth, 'cdk-synth', [pip])], { enqueue });
    const row = (await getRemediation((await rowsOf(bs))[0].id))!;
    const p = ports();
    expect(await runRemediation(row, { toolchainPorts: p, toolchainInputs: inputsStore() })).toBe('awaiting_approval');
    expect(p.builds.map((b: any) => b.name)).toEqual(['cdk-synth']);
    expect(p.builds[0].buildArgs).toEqual({ BOOTSTRAP_IMAGE: `reg:5000/library/pipeline-bootstrap@${FROM_DIGEST['pipeline-bootstrap']}` });
    const c = (await getRemediation(row.id))!.toolchainCandidate!;
    expect(c.bootstrap).toMatchObject({ rebuilt: false, digest: FROM_DIGEST['pipeline-bootstrap'] });
    expect(c.baseImage).toBeNull();
    // Rejecting never discards the bootstrap it did not rebuild.
    const { rejectToolchainFix } = await import('../src/services/remediation/toolchain.js');
    await rejectToolchainFix((await getRemediation(row.id))!, 'op-1', null, { ports: p });
    expect(p.discarded).toEqual([CAND_DIGEST['cdk-synth']]);
  });

  it('the fixture app writes a one-stack cloud assembly the CLI can synthesize', async () => {
    const { mkdtempSync, readFileSync: rf } = await import('fs');
    const { tmpdir } = await import('os');
    const { execFileSync } = await import('child_process');
    const dir = mkdtempSync(join(tmpdir(), 'pb-smoke-'));
    execFileSync(process.execPath, ['-e', TOOLCHAIN_SMOKE_APP], { env: { ...process.env, CDK_OUTDIR: dir } });
    const manifest = JSON.parse(rf(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.artifacts.Fixture).toMatchObject({ type: 'aws:cloudformation:stack', properties: { templateFile: 'Fixture.template.json' } });
    expect(JSON.parse(rf(join(dir, 'Fixture.template.json'), 'utf8')).Resources.FixtureTopic.Type).toBe('AWS::SNS::Topic');
    expect(TOOLCHAIN_SYNTH_SMOKE_COMMAND).toMatch(/cdk synth --app "node app\.js"/);
    expect(TOOLCHAIN_SYNTH_SMOKE_COMMAND).toContain('command -v pipeline-manager');
  });
});

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any }> } };
async function call(router: unknown, method: string, path: string, req: Record<string, unknown> = {}) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method])!;
  const handlers = layer.route!.stack.map((s) => s.handle);
  const res: any = { statusCode: 0, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  await handlers[handlers.length - 1]!({ params: {}, query: {}, body: {}, headers: {}, user: { sub: 'op-1', organizationId: SYSTEM, principalType: 'user', permissions: ['plugins:read', 'plugins:write'], features: [] }, ...req }, res, () => undefined);
  return res;
}

describe('the decision routes (system org + plugins:write; approve / reject step up)', () => {
  async function awaiting() {
    const q = await queuedToolchain();
    await runRemediation(q.row, { toolchainPorts: ports(), toolchainInputs: inputsStore() });
    return { ...q, row: (await getRemediation(q.row.id))! };
  }
  const routes = (p = ports(), store = inputsStore()) => ({ p, store, router: createToolchainFixRoutes({ ports: async () => p, inputs: store, readArtifact: async (k: string) => artifacts.get(k) ?? null }) });

  it('lists candidates with the findings cleared, the version diff and the knob', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    const res = await call(router, 'get', '/toolchain-fixes');
    expect(res.body.data).toMatchObject({ enabled: true, mode: 'propose' });
    expect(res.body.data.fixes[0]).toMatchObject({
      id: row.id,
      stage: 'awaiting_approval',
      fromRelease: RELEASE,
      toRelease: NEXT,
      toolchain: TOOLCHAIN,
      hasExport: true,
      digests: { 'pipeline-bootstrap': { from: FROM_DIGEST['pipeline-bootstrap'], to: CAND_DIGEST['pipeline-bootstrap'] }, 'cdk-synth': { to: CAND_DIGEST['cdk-synth'] } },
    });
    expect(res.body.data.fixes[0].cleared.map((c: any) => [c.id, c.half])).toEqual([['CVE-2026-1', 'pipeline-bootstrap'], ['CVE-2026-1', 'cdk-synth']]);
    expect(res.body.data.fixes[0]).not.toHaveProperty('exportKey');
  });

  it('approve publishes the new release (both halves, the candidate digests), keeps its inputs and tells the orgs on the vulnerable one (N34)', async () => {
    const { row } = await awaiting();
    const { router, store } = routes();
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id }, body: { reason: 'reviewed the patch' } });
    expect(res.statusCode).toBe(200);
    expect(persisted.map((x) => [x.orgId, x.pluginRecord.name, x.pluginRecord.version, x.image.imageDigest])).toEqual([
      [SYSTEM, 'pipeline-bootstrap', NEXT, CAND_DIGEST['pipeline-bootstrap']],
      [SYSTEM, 'cdk-synth', NEXT, CAND_DIGEST['cdk-synth']],
    ]);
    expect(persisted[0].pluginRecord.metadata).toMatchObject(realApiCore.toolchainMetadata(TOOLCHAIN));
    expect(persisted[0].pluginRecord.changelog).toContain(`Security fix of toolchain release ${RELEASE}`);
    expect(res.body.data).toMatchObject({ stage: 'done', outcome: 'cleared', toRelease: NEXT, decidedBy: 'op-1' });
    expect(store.m.get(`${NEXT}/pipeline-bootstrap`)!['plugin-spec.yaml']).toContain(`version: ${NEXT}`);
    expect(hygieneEvents).toEqual([{ kind: 'fixed', releaseVersion: RELEASE, fixedRelease: NEXT, cleared: ['CVE-2026-1'] }]);
    expect(audits.mock.calls.map((x) => x[0] as any).find((a) => a.action === 'toolchain.fix.approved')).toMatchObject({ actorId: 'op-1', details: expect.objectContaining({ toRelease: NEXT, reason: 'reviewed the patch' }) });
    // Nobody is moved: no org default was written.
    expect((await raw.query('SELECT count(*)::int AS n FROM org_toolchain_default')).rows).toEqual([{ n: 0 }]);
    // Decided once.
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(409);
  });

  it('approve refuses (409) when the re-scan of a candidate digest is refused by the gate — nothing is stored', async () => {
    const { row } = await awaiting();
    const { router } = routes(ports({ gateRefusal: 'PLUGIN_VULN_GATE' }));
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'GATE_REFUSED', half: 'pipeline-bootstrap' });
    expect(persisted).toEqual([]);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'awaiting_approval', decidedAt: null });
  });

  it('reject discards the candidate images and publishes nothing', async () => {
    const { row } = await awaiting();
    const { router, p } = routes();
    const res = await call(router, 'post', '/toolchain-fixes/:id/reject', { params: { id: row.id }, body: { reason: 'not now' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ stage: 'failed', outcome: 'rejected' });
    expect(p.discarded.sort()).toEqual([CAND_DIGEST['pipeline-bootstrap'], CAND_DIGEST['cdk-synth']].sort());
    expect(persisted).toEqual([]);
    expect(hygieneEvents).toEqual([]);
    expect(audits.mock.calls.map((x) => (x[0] as any).action)).toContain('toolchain.fix.rejected');
  });

  it('export downloads the spec patch for the release workflow', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    const res = await call(router, 'get', '/toolchain-fixes/:id/export', { params: { id: row.id } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/x-diff; charset=utf-8');
    expect(res.headers['Content-Disposition']).toContain(`toolchain-${NEXT}-spec.diff`);
    expect(res.body).toContain('--- a/deploy/toolchain/pipeline-bootstrap/plugin-spec.yaml');
    expect(res.body).toContain(`+version: ${NEXT}`);
    expect((await call(router, 'get', '/toolchain-fixes/:id/export', { params: { id: '00000000-0000-4000-8000-000000000999' } })).statusCode).toBe(404);
  });

  it('a newer release uploaded the normal way supersedes a waiting candidate: its images go, nothing rolls out', async () => {
    const { row } = await awaiting();
    await half('pipeline-bootstrap', `${MAJ}.${MIN! + 1}.0`, []);
    const discard = jest.fn<AnyFn>(async () => undefined);
    await queuePassRemediations([], { enqueue, discardToolchainCandidate: discard });
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'done', outcome: 'superseded' });
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
    const { startTenantRollout } = await import('../src/services/remediation/rollout.js');
    expect(startTenantRollout).not.toHaveBeenCalled();
  });

  const pluginRows = async () => (await raw.query<any>('SELECT name, version, image_digest FROM plugins WHERE version = $1 ORDER BY name', [NEXT])).rows;

  it('a crash after storing the bootstrap: a repeat approve resumes and finishes once — same version, no duplicate rows', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    faults.persistName = 'cdk-synth';
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(500);
    const mid = (await getRemediation(row.id))!;
    expect(mid).toMatchObject({ stage: 'awaiting_approval', decidedBy: 'op-1' });
    expect(mid.toolchainCandidate!.publish).toMatchObject({ approvedBy: 'op-1', steps: { bootstrap: expect.any(String), cdkSynth: null, inputs: false, notice: false } });
    // Reject is no longer possible once publishing started.
    expect((await call(router, 'post', '/toolchain-fixes/:id/reject', { params: { id: row.id } })).statusCode).toBe(409);
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ stage: 'done', toRelease: NEXT });
    expect(await pluginRows()).toEqual([
      { name: 'cdk-synth', version: NEXT, image_digest: CAND_DIGEST['cdk-synth'] },
      { name: 'pipeline-bootstrap', version: NEXT, image_digest: CAND_DIGEST['pipeline-bootstrap'] },
    ]);
    expect(persisted.map((x) => x.pluginRecord.name)).toEqual(['pipeline-bootstrap', 'cdk-synth']);
    expect(hygieneEvents).toHaveLength(1);
    const approvals = audits.mock.calls.map((x) => x[0] as any).filter((a) => a.action === 'toolchain.fix.approved' && a.outcome !== 'failure');
    expect(approvals.at(-1)).toMatchObject({ details: expect.objectContaining({ resumed: true }) });
  });

  it('a crash after both halves were stored but before the notice: resume only sends the notice', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    faults.notice = 1;
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(500);
    expect((await getRemediation(row.id))!.toolchainCandidate!.publish!.steps).toMatchObject({ bootstrap: expect.any(String), cdkSynth: expect.any(String), inputs: true, notice: false });
    persisted.length = 0;
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(200);
    expect(persisted).toEqual([]);
    expect(hygieneEvents).toEqual([{ kind: 'fixed', releaseVersion: RELEASE, fixedRelease: NEXT, cleared: ['CVE-2026-1'] }]);
    expect(await pluginRows()).toHaveLength(2);
  });

  it('two concurrent approves: exactly one publishes, the other is refused', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    const [a, b] = await Promise.all([
      call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } }),
      call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(persisted).toHaveLength(2);
    expect(await pluginRows()).toHaveLength(2);
    expect(hygieneEvents).toHaveLength(1);
  });

  it('the sweep resumes a publish stuck past its lease (a crash that never released it)', async () => {
    const { row } = await awaiting();
    const { router, p, store } = routes();
    faults.persistName = 'cdk-synth';
    await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    // A crash keeps the lease: expire it as time would.
    await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb(\'2026-01-01T00:00:00.000Z\'::text)) WHERE id = $1', [row.id]);
    const { resumeStuckToolchainFixes } = await import('../src/services/remediation/toolchain.js');
    expect(await resumeStuckToolchainFixes({ ports: p, inputs: store })).toBe(1);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'done', outcome: 'cleared' });
    expect(await pluginRows()).toHaveLength(2);
    // A live lease is not touched.
    expect(await resumeStuckToolchainFixes({ ports: p, inputs: store })).toBe(0);
  });

  it('the resume scheduler: one tick resumes an expired lease and leaves a live one alone', async () => {
    const { row } = await awaiting();
    const { router, p, store } = routes();
    faults.persistName = 'cdk-synth';
    await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    // Still inside its lease (a publish on another replica): untouched.
    await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb(\'2999-01-01T00:00:00.000Z\'::text)) WHERE id = $1', [row.id]);
    const { runToolchainResumeTick } = await import('../src/services/remediation/toolchain-resume.js');
    const { resumeStuckToolchainFixes } = await import('../src/services/remediation/toolchain.js');
    const resume = () => resumeStuckToolchainFixes({ ports: p, inputs: store });
    expect(await runToolchainResumeTick({ resume })).toBe('idle');
    expect((await getRemediation(row.id))!.stage).toBe('awaiting_approval');
    await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb(\'2026-01-01T00:00:00.000Z\'::text)) WHERE id = $1', [row.id]);
    expect(await runToolchainResumeTick({ resume })).toBe('resumed');
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'done', outcome: 'cleared' });
    expect(counters).toContainEqual(['toolchain_fix_resume_runs_total', { outcome: 'resumed' }]);
    expect(counters).toContainEqual(['toolchain_fix_resume_runs_total', { outcome: 'idle' }]);
  });

  it('the resume scheduler does no work when remediation or toolchain fixes are off', async () => {
    const { runToolchainResumeTick, createToolchainResumeScheduler } = await import('../src/services/remediation/toolchain-resume.js');
    const resume = jest.fn<AnyFn>(async () => 1);
    setPluginServiceConfigForTests({ enabled: true, toolchains: 'off' });
    expect(await runToolchainResumeTick({ resume })).toBe('skipped');
    expect(createToolchainResumeScheduler({ resume })).toBeNull();
    setPluginServiceConfigForTests({ enabled: false, toolchains: 'propose' });
    expect(await runToolchainResumeTick({ resume })).toBe('skipped');
    expect(createToolchainResumeScheduler({ resume })).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(counters).toContainEqual(['toolchain_fix_resume_runs_total', { outcome: 'skipped' }]);
  });

  it('the resume scheduler: an error is counted, never thrown; start runs a tick, stop ends it', async () => {
    const { runToolchainResumeTick, createToolchainResumeScheduler, toolchainResumeIntervalMs } = await import('../src/services/remediation/toolchain-resume.js');
    expect(await runToolchainResumeTick({ resume: async () => { throw new Error('db down'); } })).toBe('error');
    expect(counters).toContainEqual(['toolchain_fix_resume_runs_total', { outcome: 'error' }]);
    delete process.env.TOOLCHAIN_FIX_RESUME_INTERVAL_MS;
    expect(toolchainResumeIntervalMs()).toBe(120_000);
    process.env.TOOLCHAIN_FIX_RESUME_INTERVAL_MS = '1000';
    expect(toolchainResumeIntervalMs()).toBe(30_000);
    delete process.env.TOOLCHAIN_FIX_RESUME_INTERVAL_MS;
    const resume = jest.fn<AnyFn>(async () => 0);
    const scheduler = createToolchainResumeScheduler({ resume, startupDelayMs: 0 })!;
    scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(resume).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('the nightly pass runs that sweep, and never supersedes a candidate that is publishing', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    faults.persistName = 'cdk-synth';
    await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    await half('pipeline-bootstrap', `${MAJ}.${MIN! + 1}.0`, []);
    const resume = jest.fn<AnyFn>(async () => 0);
    await queuePassRemediations([], { enqueue, resumeToolchainFixes: resume, discardToolchainCandidate: jest.fn<AnyFn>(async () => undefined) });
    expect(resume).toHaveBeenCalled();
    expect((await getRemediation(row.id))!.stage).toBe('awaiting_approval');
  });

  it('approve refuses when the release number was taken meanwhile, or the vulnerable release is gone', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    await raw.query('INSERT INTO toolchain_release (release_version, created_by) VALUES ($1, $2)', [NEXT, 'loader']);
    const taken = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(taken.statusCode).toBe(409);
    expect(taken.body.details).toMatchObject({ reason: 'RELEASE_VERSION_TAKEN', toRelease: NEXT });
    expect((await getRemediation(row.id))!.toolchainCandidate!.publish).toBeUndefined();
    await raw.query('DELETE FROM toolchain_release WHERE release_version = $1', [NEXT]);
    await raw.query("UPDATE plugins SET deleted_at = now() WHERE name = 'cdk-synth' AND version = $1", [RELEASE]);
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).body.details).toMatchObject({ reason: 'FROM_RELEASE_DELETED' });
    expect(persisted).toEqual([]);
  });

  it('a resume refuses (and releases its lease) when another image already holds a half\'s release number', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    faults.persistName = 'cdk-synth';
    await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    await raw.query(`INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active)
      VALUES ($1, 'cdk-synth', $2, 'loader', 'loader', 'CodeBuildStep', $3, true)`, [SYSTEM, NEXT, D('7')]);
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'RELEASE_VERSION_TAKEN', half: 'cdk-synth' });
    const after = (await getRemediation(row.id))!;
    expect(after.stage).toBe('awaiting_approval');
    expect(new Date(after.toolchainCandidate!.publish!.leaseUntil).getTime()).toBe(0);
  });

  it('a resume whose remaining half the gate now refuses keeps the stored progress (still not rejectable)', async () => {
    const { row } = await awaiting();
    const good = routes();
    faults.persistName = 'cdk-synth';
    await call(good.router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    const refusing = routes(ports({ gateRefusal: 'PLUGIN_VULN_GATE' }));
    const res = await call(refusing.router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.body.details).toMatchObject({ reason: 'GATE_REFUSED', half: 'cdk-synth' });
    const after = (await getRemediation(row.id))!;
    expect(after.toolchainCandidate!.publish!.steps.bootstrap).toEqual(expect.any(String));
    expect((await call(good.router, 'post', '/toolchain-fixes/:id/reject', { params: { id: row.id } })).body.details).toMatchObject({ reason: 'PUBLISH_STARTED' });
    // The gate clears again: the resume finishes with the same bootstrap row.
    expect((await call(good.router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(200);
    expect(persisted.map((x) => x.pluginRecord.name)).toEqual(['pipeline-bootstrap', 'cdk-synth']);
  });

  const leaseOf = async (id: string) => (await raw.query<{ l: string | null }>("SELECT toolchain_candidate->'publish'->>'leaseUntil' AS l FROM plugin_remediations WHERE id = $1", [id])).rows[0]!.l;

  it('the lease is renewed after each gate re-scan (a slow re-scan never lets a resume take over mid-publish)', async () => {
    const { row } = await awaiting();
    const p = ports();
    const seen: Array<string | null> = [];
    const scan = p.scan;
    p.scan = async (...a: unknown[]) => { seen.push(await leaseOf(row.id)); await new Promise((r) => setTimeout(r, 15)); return scan(...a); };
    const { router } = routes(p);
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(200);
    // Two re-scans (one per half): the second saw a lease renewed after the first.
    expect(seen).toHaveLength(2);
    expect(new Date(seen[1]!).getTime()).toBeGreaterThan(new Date(seen[0]!).getTime());
  });

  it('an approver whose lease was taken over never releases (or overwrites) the new holder\'s lease, and stores nothing', async () => {
    const { row } = await awaiting();
    const p = ports();
    const scan = p.scan;
    const OTHER = '2999-01-01T00:00:00.000Z';
    // While this approver re-scans, its lease passes and a resume claims the publish.
    p.scan = async (...a: unknown[]) => {
      await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb($2::text)) WHERE id = $1', [row.id, OTHER]);
      return scan(...a);
    };
    const { router } = routes(p);
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.details).toMatchObject({ reason: 'LEASE_LOST' });
    expect(await leaseOf(row.id)).toBe(OTHER);
    expect(persisted).toEqual([]);
  });

  it('a gate refusal releases only a lease it still holds', async () => {
    const { row } = await awaiting();
    const good = routes();
    faults.persistName = 'cdk-synth';
    await call(good.router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb(\'2026-01-01T00:00:00.000Z\'::text)) WHERE id = $1', [row.id]);
    const p = ports({ gateRefusal: 'PLUGIN_VULN_GATE' });
    const OTHER = '2999-01-01T00:00:00.000Z';
    const scan = p.scan;
    p.scan = async (...a: unknown[]) => {
      await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish,leaseUntil}\', to_jsonb($2::text)) WHERE id = $1', [row.id, OTHER]);
      return scan(...a);
    };
    const res = await call(routes(p).router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    // Progress was stored (bootstrap), so this is the keep-progress branch: the lease was
    // lost, not the gate's verdict to report — the new holder carries on.
    expect(res.body.details).toMatchObject({ reason: 'LEASE_LOST' });
    expect(await leaseOf(row.id)).toBe(OTHER);
  });

  it('after 3 gate refusals of its publish the candidate moves to needs_review and a failure is counted (ToolchainFixFailing)', async () => {
    const { row } = await awaiting();
    const { router } = routes(ports({ gateRefusal: 'PLUGIN_VULN_GATE' }));
    for (let i = 1; i <= 2; i++) {
      const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
      expect(res.body.details).toMatchObject({ reason: 'GATE_REFUSED' });
      expect((await getRemediation(row.id))!).toMatchObject({ stage: 'awaiting_approval', decidedAt: null });
    }
    expect(counters).not.toContainEqual(['toolchain_fix_failures_total', { stage: 'gate_refused' }]);
    const third = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(third.statusCode).toBe(409);
    expect(third.body.details).toMatchObject({ reason: 'GATE_REFUSED', refusals: 3, stage: 'needs_review' });
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'needs_review', error: 'GATE_REFUSED' });
    expect(counters).toContainEqual(['toolchain_fix_failures_total', { stage: 'gate_refused' }]);
    expect(persisted).toEqual([]);
    // No longer decidable.
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(409);
  });

  it('approve and resume are refused (503) while the operator knob is off: nothing is claimed or published', async () => {
    const { row } = await awaiting();
    const { router, p, store } = routes();
    setPluginServiceConfigForTests({ enabled: false, toolchains: 'propose' });
    const res = await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(503);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'awaiting_approval', decidedAt: null });
    expect((await getRemediation(row.id))!.toolchainCandidate!.publish).toBeUndefined();
    // A publish stuck past its lease is not resumed either.
    await raw.query('UPDATE plugin_remediations SET toolchain_candidate = jsonb_set(toolchain_candidate, \'{publish}\', $2::jsonb) WHERE id = $1',
      [row.id, JSON.stringify({ approvedBy: 'op-1', approvedAt: '2026-01-01T00:00:00.000Z', leaseUntil: '2026-01-01T00:00:00.000Z', steps: { bootstrap: null, cdkSynth: null, inputs: false, notice: false }, resumes: 0 })]);
    const { resumeStuckToolchainFixes } = await import('../src/services/remediation/toolchain.js');
    expect(await resumeStuckToolchainFixes({ ports: p, inputs: store })).toBe(0);
    expect(persisted).toEqual([]);
  });

  it('decisions need a waiting toolchain candidate: 404 for an unknown or plugin remediation, 409 once decided', async () => {
    const { row } = await awaiting();
    const { router } = routes();
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: 'nope' } })).statusCode).toBe(404);
    await raw.query("UPDATE plugin_remediations SET kind = 'plugin' WHERE id = $1", [row.id]);
    expect((await call(router, 'post', '/toolchain-fixes/:id/reject', { params: { id: row.id } })).statusCode).toBe(404);
    await raw.query("UPDATE plugin_remediations SET kind = 'toolchain', stage = 'needs_owner' WHERE id = $1", [row.id]);
    expect((await call(router, 'post', '/toolchain-fixes/:id/approve', { params: { id: row.id } })).statusCode).toBe(409);
    expect((await call(router, 'post', '/toolchain-fixes/:id/reject', { params: { id: row.id } })).statusCode).toBe(409);
    await raw.query('UPDATE plugin_remediations SET export_key = NULL WHERE id = $1', [row.id]);
    expect((await call(router, 'get', '/toolchain-fixes/:id/export', { params: { id: row.id } })).statusCode).toBe(404);
    // The list shows it with its refusal state and no publishing progress.
    expect((await call(router, 'get', '/toolchain-fixes')).body.data.fixes[0]).toMatchObject({ id: row.id, stage: 'needs_owner', publishing: null, hasExport: false });
  });

  it('the plugin remediation approve route never publishes a toolchain candidate', async () => {
    const { row } = await awaiting();
    const res = await call(createRemediationRoutes(), 'post', '/remediations/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect(enqueued).toEqual([]);
    expect(persisted).toEqual([]);
  });
});
