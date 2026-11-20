// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation lifecycle against a REAL Postgres (PGlite, the shipped
 * postgres-init.sql, as the RLS-enforced app role): queueing after a pass
 * (idempotency per findings hash, the daily cap, priority, modes, ownership),
 * the job (next free version, propose / apply, smokeTest rule, the owner's own
 * clean version, owner requests, fail-closed errors), cancel on delete, the
 * routes' stage rules and the pipeline service's rollout report.
 */

import { describe, it, expect, beforeEach, afterAll, jest } from '@jest/globals';
import { bindTestAuditService, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;
const audits = bindTestAuditService('plugin');

const pipelinesOnVersion = jest.fn<AnyFn>(async () => []);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData, withTenantTx: testDb.withTenantTx, pipelinesOnVersion,
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
const fixes = {
  sendPublisherFixRequest: jest.fn<AnyFn>(async () => undefined),
  openOfficialListingFix: jest.fn<AnyFn>(async () => ({ requestId: 'r' })),
  storeOfficialExport: jest.fn<AnyFn>(async () => 'k'),
  clearedFacts: () => ({ advisoryIds: [], criticalCleared: 0, highCleared: 0, kev: false }),
  remediationOwnership: (t: { kind: string; orgId?: string; publisherHandle?: string }) => (t.kind === 'plugin'
    ? (realApiCore.isSystemOrgId(t.orgId!) ? 'official' : 'org')
    : t.publisherHandle === 'pipeline-builder' ? 'official' : 'publisher_fix_request'),
};
jest.unstable_mockModule('../src/services/ecosystem/remediation-fixes.js', () => fixes);
const sources = {
  putRemediationArtifact: jest.fn<AnyFn>(async () => undefined),
  recordVersionSource: jest.fn<AnyFn>(async () => null),
  fetchPluginSource: jest.fn<AnyFn>(async () => 'missing'),
  pluginSourcesBucket: () => 'plugin-sources',
};
jest.unstable_mockModule('../src/services/plugin-sources.js', () => sources);
const rollout = { startTenantRollout: jest.fn<AnyFn>(async () => true), cancelRollout: jest.fn<AnyFn>(async () => true), setRolloutClientForTests: jest.fn() };
jest.unstable_mockModule('../src/services/remediation/rollout.js', () => rollout);
const persisted: any[] = [];
jest.unstable_mockModule('../src/services/version-persist.js', () => ({
  persistVersion: jest.fn(async (input: any) => {
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

const { setPluginServiceConfigForTests } = await import('../src/config.js');
const { deactivateIfUnreferenced, queuePassRemediations, queuePriority } = await import('../src/services/remediation/queueing.js');
const { runRemediation } = await import('../src/queue/plugin-remediation.js');
const { cancelRemediationsFor } = await import('../src/services/remediation/cancel.js');
const { applyRolloutReport } = await import('../src/routes/internal-remediation.js');
const { createRemediationRoutes, setRemediationArtifactReaderForTests } = await import('../src/routes/remediations.js');
const { getRemediation } = await import('../src/services/remediation/store.js');
const { canaryPluginName } = await import('../src/services/remediation/canary.js');
const { buildSpendsCredits } = await import('../src/queue/build-credits.js');
const { pluginQuotaExempt } = await import('../src/queue/build-quota.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb1';
const SYSTEM = realApiCore.SYSTEM_ORG_ID;
const DIGEST = `sha256:${'c'.repeat(64)}`;

function finding(over: Record<string, unknown> = {}): any {
  return { id: 'CVE-2026-1', severity: 'high', packageName: 'curl', packageVersion: '7.0-1', fixedIn: ['7.0-2'], packageType: 'deb', purl: 'pkg:deb/debian/curl@7.0-1', locations: [{ path: '/var/lib/dpkg/status', layerID: 'sha256:l' }], ...over };
}
function summary(findings: any[], waived: string[] = []): any {
  return { criticalFixable: 0, highFixable: findings.length, critical: 0, high: findings.length, medium: 0, low: 0, kev: 0, findings, truncated: false, waived, scannedAt: '2026-11-20T00:00:00Z', trigger: 'rescan', imageDigest: DIGEST, dbBuiltAt: null };
}

async function plugin(orgId: string, name: string, version: string, o: { deleted?: boolean; flagged?: boolean; smoke?: string | null; createdBy?: string } = {}): Promise<string> {
  const { rows } = await raw.query<{ id: string }>(
    `INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active, deleted_at, scan_flagged_at, smoke_test, scan_summary)
     VALUES ($1, $2, $3, $4, $4, 'CodeBuildStep', $5, true, $6, $7, $8, $9) RETURNING id`,
    [orgId, name, version, o.createdBy ?? 'uploader', DIGEST, o.deleted ? new Date() : null, o.flagged ? new Date() : null,
      o.smoke === undefined ? JSON.stringify('echo ok') : o.smoke === null ? null : JSON.stringify(o.smoke), JSON.stringify(summary([finding()]))]);
  return rows[0]!.id;
}
const cand = (id: string, name: string, version: string, findings: any[], orgId = ORG, extra: Record<string, unknown> = {}): any =>
  ({ kind: 'plugin', id, orgId, name, version, imageDigest: DIGEST, deleted: false, yanked: false, createdBy: 'uploader', summary: summary(findings), ...extra });
const rowsOf = async (pluginId: string) => (await raw.query<any>('SELECT * FROM plugin_remediations WHERE plugin_id = $1 ORDER BY created_at', [pluginId])).rows;
const enqueue = jest.fn<AnyFn>(async () => undefined);
const settings = (orgId: string, mode: string) => raw.query('INSERT INTO plugin_remediation_settings (org_id, mode) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET mode = EXCLUDED.mode', [orgId, mode]);

beforeEach(async () => {
  jest.clearAllMocks();
  notices.length = 0; persisted.length = 0; counters.length = 0; enqueued.length = 0;
  await raw.exec('DELETE FROM plugin_remediations; DELETE FROM plugin_remediation_settings; DELETE FROM plugins;');
  setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20, concurrency: 2 });
});
afterAll(async () => { setPluginServiceConfigForTests(); await raw.close(); });

describe('config', () => {
  it('reads PLUGIN_REMEDIATION_ENABLED / _SEVERITIES through the api-core parsers', async () => {
    const { loadPluginServiceConfig } = await import('../src/config.js');
    const warn = jest.fn();
    process.env.PLUGIN_REMEDIATION_ENABLED = 'FALSE ';
    process.env.PLUGIN_REMEDIATION_SEVERITIES = 'bogus';
    const c = loadPluginServiceConfig(warn);
    expect(c.remediation).toMatchObject({ enabled: false, severities: ['critical', 'high'], concurrency: 2, baseConcurrency: 4, maxPerOrgPerDay: 20, sourcesBucket: 'plugin-sources' });
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.PLUGIN_REMEDIATION_ENABLED = 'no';
    process.env.PLUGIN_REMEDIATION_SEVERITIES = ' Critical ';
    expect(loadPluginServiceConfig(warn).remediation).toMatchObject({ enabled: true, severities: ['critical'] });
    delete process.env.PLUGIN_REMEDIATION_ENABLED; delete process.env.PLUGIN_REMEDIATION_SEVERITIES;
  });
});

describe('queueing after a completed pass', () => {
  it('queues one remediation per version and findings set, and never again for the same set', async () => {
    const id = await plugin(ORG, 'lint', '1.0.0');
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding()])], { enqueue });
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding()])], { enqueue });
    expect(await rowsOf(id)).toHaveLength(1);
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'error'");
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding()])], { enqueue });
    expect(await rowsOf(id)).toHaveLength(1); // a failed set isn't retried …
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding({ fixedIn: ['7.0-2', '7.0-3'] })])], { enqueue });
    expect(await rowsOf(id)).toHaveLength(2); // … until the DB adds a fixed version
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]![2]).toMatchObject({ jobId: `remediation-${(await rowsOf(id))[0].id}` });
    expect(audits.mock.calls.map((c) => (c[0] as any).action)).toContain('plugin.remediation.started');
  });

  it('targets the configured severities, KEV always, and never a waived finding', async () => {
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical'], maxPerOrgPerDay: 20 });
    const a = await plugin(ORG, 'a', '1.0.0');
    const b = await plugin(ORG, 'b', '1.0.0');
    const c = await plugin(ORG, 'c', '1.0.0');
    const waived = finding({ severity: 'critical' });
    await queuePassRemediations([
      cand(a, 'a', '1.0.0', [finding()]),
      cand(b, 'b', '1.0.0', [finding({ kev: true, fixedIn: [] })]),
      { ...cand(c, 'c', '1.0.0', []), summary: summary([waived], [realApiCore.scanFindingKey(waived)]) },
    ], { enqueue });
    expect(await rowsOf(a)).toHaveLength(0);
    expect(await rowsOf(b)).toHaveLength(1);
    expect(await rowsOf(c)).toHaveLength(0);
  });

  it('holds the daily per-org cap', async () => {
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 1 });
    const a = await plugin(ORG, 'a', '1.0.0');
    const b = await plugin(ORG, 'b', '1.0.0');
    const r = await queuePassRemediations([cand(a, 'a', '1.0.0', [finding()]), cand(b, 'b', '1.0.0', [finding()])], { enqueue });
    expect(r).toMatchObject({ queued: 1, capped: 1 });
  });

  it('skips orgs whose mode is off, and everything when the operator knob is off', async () => {
    const a = await plugin(ORG, 'a', '1.0.0');
    await settings(ORG, 'off');
    await queuePassRemediations([cand(a, 'a', '1.0.0', [finding()])], { enqueue });
    expect(await rowsOf(a)).toHaveLength(0);
    await settings(ORG, 'propose');
    setPluginServiceConfigForTests({ enabled: false });
    await queuePassRemediations([cand(a, 'a', '1.0.0', [finding()])], { enqueue });
    expect(await rowsOf(a)).toHaveLength(0);
  });

  it('sends versions the platform may not change straight to an owner request (toolchain fixes off)', async () => {
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20, concurrency: 2, toolchains: 'off' });
    const id = await plugin(SYSTEM, 'pipeline-bootstrap', '4.4.20');
    await queuePassRemediations([cand(id, 'pipeline-bootstrap', '4.4.20', [finding()], SYSTEM)], { enqueue });
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({ stage: 'needs_owner', outcome: 'owner_request' });
    expect(notices.map((n) => n.code)).toEqual(['N39']);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never rebuilds a third-party listed version: its publisher gets a fix request', async () => {
    await queuePassRemediations([
      { kind: 'listing_version', listingId: 'l-1', version: '2.0.0', publisherHandle: 'acme', summary: summary([finding()]) },
      { kind: 'listing_version', listingId: 'l-2', version: '2.0.0', publisherHandle: 'pipeline-builder', summary: summary([finding()]) },
    ], { enqueue });
    expect(fixes.sendPublisherFixRequest).toHaveBeenCalledTimes(1);
    expect(fixes.sendPublisherFixRequest).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'l-1', remaining: [expect.objectContaining({ reason: 'third_party_listing' })] }));
  });

  it('orders the queue KEV, then EPSS, then pipelines — the system org first', async () => {
    const low = await plugin(ORG, 'low', '1.0.0');
    const kev = await plugin(ORG, 'kev', '1.0.0');
    const epss = await plugin(ORG, 'epss', '1.0.0');
    const sys = await plugin(SYSTEM, 'sys', '1.0.0');
    await queuePassRemediations([
      cand(low, 'low', '1.0.0', [finding()]),
      cand(epss, 'epss', '1.0.0', [finding({ epss: 0.9 })]),
      cand(kev, 'kev', '1.0.0', [finding({ kev: true })]),
      cand(sys, 'sys', '1.0.0', [finding()], SYSTEM),
    ], { enqueue });
    expect(enqueue.mock.calls.map((c) => (c[1] as any).pluginName)).toEqual(['sys', 'kev', 'epss', 'low']);
    const prio = enqueue.mock.calls.map((c) => (c[2] as any).priority);
    expect(prio[0]).toBeLessThan(prio[1]);
    expect(prio[1]).toBeLessThan(prio[2]);
    expect(prio[2]).toBeLessThan(prio[3]);
    expect(Math.min(...prio)).toBeGreaterThanOrEqual(1);
    expect(queuePriority(ORG, { kev: true, maxEpss: 1, pipelineCount: 999 })).toBeGreaterThan(queuePriority(SYSTEM, { kev: false, maxEpss: 0, pipelineCount: 0 }));
  });

  it('re-targets a canary fixture every night (a dry run, not idempotent per hash)', async () => {
    const name = canaryPluginName('npm');
    const id = await plugin(SYSTEM, name, '1.0.0');
    await queuePassRemediations([cand(id, name, '1.0.0', [finding()], SYSTEM)], { enqueue });
    await raw.query("UPDATE plugin_remediations SET stage = 'done', outcome = 'cleared'");
    await queuePassRemediations([cand(id, name, '1.0.0', [finding()], SYSTEM)], { enqueue });
    expect(await rowsOf(id)).toHaveLength(2);
  });

  it('an owner\'s newer clean upload supersedes a live remediation', async () => {
    const id = await plugin(ORG, 'lint', '1.0.0', { flagged: true });
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding()])], { enqueue });
    await plugin(ORG, 'lint', '1.1.0', { createdBy: 'owner' });
    await queuePassRemediations([], { enqueue });
    expect((await rowsOf(id))[0]).toMatchObject({ stage: 'done', outcome: 'superseded' });
  });
});

/** Engine ports for the job tests: one build that clears the finding (or not). */
function ports(opts: { clears?: boolean } = {}): any {
  const discarded: string[] = [];
  return {
    discarded,
    fetchSource: async () => 'missing',
    openSource: async () => { throw new Error('no source'); },
    contractOf: async () => null,
    build: async () => `sha256:${'d'.repeat(64)}`,
    scan: async () => ({ scan: { findings: opts.clears === false ? [finding()] : [], waivedKeys: new Set(), refusal: null }, facts: { scannedAt: new Date() }, summary: summary([]) }),
    imageConfig: async () => ({ user: '1000', entrypoint: null, cmd: null, workingDir: '/' }),
    layerIds: async () => [],
    smokeTest: async () => undefined,
    resolveDigest: async () => null,
    runTool: async () => undefined,
    discardImage: async (r: { digest: string }) => { discarded.push(r.digest); },
    imageReference: (r: { name: string; digest: string }) => `reg:5000/org/${r.name}@${r.digest}`,
    askAgent: async () => null,
    ensureSharedBase: async () => null,
  };
}

async function queued(orgId: string, name: string, version: string, o: Parameters<typeof plugin>[3] = {}) {
  const id = await plugin(orgId, name, version, o);
  await queuePassRemediations([cand(id, name, version, [finding()], orgId)], { enqueue });
  return (await getRemediation((await rowsOf(id))[0].id))!;
}

describe('the remediation job', () => {
  it('apply: publishes the next FREE patch version (a taken number is skipped), with no quota slot, then rolls out', async () => {
    await settings(ORG, 'apply');
    await plugin(ORG, 'lint', '1.0.1', { deleted: true }); // soft-deleted: its number stays reserved
    const row = await queued(ORG, 'lint', '1.0.0');
    const p = ports();
    expect(await runRemediation(row, { ports: p })).toBe('rolling_out');
    expect(persisted[0]).toMatchObject({ userId: realApiCore.SYSTEM_PLUGIN_REMEDIATION, pluginRecord: { version: '1.0.2', quotaResetAt: null } });
    expect(persisted[0].pluginRecord.changelog).toContain('Security fix of 1.0.0');
    const [after] = await rowsOf(row.pluginId);
    expect(after).toMatchObject({ stage: 'rolling_out', to_version: '1.0.2', outcome: 'cleared', publish_mode: 'apply' });
    expect(rollout.startTenantRollout).toHaveBeenCalled();
    expect(notices.map((n) => n.code)).toEqual(['N36']);
    expect(p.discarded).toEqual([]);
  });

  it('propose (the default): waits for approval, discards the candidate, says so (N36 awaiting)', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    const p = ports();
    expect(await runRemediation(row, { ports: p })).toBe('awaiting_approval');
    expect(persisted).toEqual([]);
    expect(p.discarded).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'N36', awaitingApproval: true, proposeReasons: ['org_mode'] });
  });

  it('a plugin without a smokeTest stops at propose even in apply mode', async () => {
    await settings(ORG, 'apply');
    const row = await queued(ORG, 'lint', '1.0.0', { smoke: null });
    expect(await runRemediation(row, { ports: ports() })).toBe('awaiting_approval');
    expect((await rowsOf(row.pluginId))[0].propose_reasons).toEqual(['no_smoke_test']);
  });

  it('an approved remediation re-runs and publishes', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await runRemediation(row, { ports: ports() });
    await raw.query("UPDATE plugin_remediations SET decided_at = now(), decided_by = 'u-1'");
    const approved = (await getRemediation(row.id))!;
    expect(await runRemediation(approved, { ports: ports() })).toBe('rolling_out');
    expect(persisted).toHaveLength(1);
  });

  it('nothing fixable: needs_owner with an owner request (never an error)', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    expect(await runRemediation(row, { ports: ports({ clears: false }) })).toBe('needs_owner');
    expect(notices.map((n) => n.code)).toEqual(['N39']);
    expect(counters).toContainEqual(['plugin_remediations_total', { stage: 'needs_owner', outcome: 'owner_request' }]);
  });

  it('a checksum mismatch fails it with outcome error and SOURCE_CHECKSUM_MISMATCH', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query(`UPDATE plugins SET source_kind = 'zip', source_key = 'k', source_sha256 = '${'a'.repeat(64)}', source_size_bytes = 1 WHERE id = $1`, [row.pluginId]);
    const p = { ...ports(), fetchSource: async () => { throw Object.assign(new Error('x'), { code: 'SOURCE_CHECKSUM_MISMATCH' }); } };
    expect(await runRemediation(row, { ports: p })).toBe('failed');
    expect((await rowsOf(row.pluginId))[0]).toMatchObject({ outcome: 'error', error: 'SOURCE_CHECKSUM_MISMATCH' });
    expect(counters).toContainEqual(['plugin_remediations_total', { stage: 'failed', outcome: 'error' }]);
  });

  it('the owner\'s newer clean version cancels it before anything is built', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await plugin(ORG, 'lint', '2.0.0', { createdBy: 'owner' });
    const p = { ...ports(), build: jest.fn() };
    expect(await runRemediation(row, { ports: p })).toBe('done');
    expect(p.build).not.toHaveBeenCalled();
    expect((await rowsOf(row.pluginId))[0].outcome).toBe('superseded');
  });

  it('spends no build credits and holds no plugins-quota slot', () => {
    expect(buildSpendsCredits({ orgId: ORG, kind: 'plugin-remediation' })).toBe(false);
    expect(buildSpendsCredits({ orgId: ORG })).toBe(true);
    expect(pluginQuotaExempt({ name: 'plugin-remediation', data: {} })).toBe(true);
    expect(pluginQuotaExempt({ name: 'lint:1.0.0', data: {} })).toBe(false);
  });
});

describe('deactivating a fixed version', () => {
  it('an unreferenced flagged version that is the plugin\'s only version stays active', async () => {
    const id = await plugin(ORG, 'solo', '1.0.0', { flagged: true });
    counters.length = 0;
    expect(await deactivateIfUnreferenced({ pluginId: id, orgId: ORG, pluginName: 'solo', fromVersion: '1.0.0' })).toBe(false);
    expect((await raw.query<any>('SELECT is_active FROM plugins WHERE id = $1', [id])).rows[0].is_active).toBe(true);
    // The shared auto-removal rule decided it, and the skip is counted like every other automatic path's.
    await new Promise((r) => setImmediate(r));
    expect(counters).toContainEqual(['plugin_auto_removal_skipped_total', { reason: 'only_version' }]);
    // A tombstoned sibling is not a remaining version.
    await raw.query("INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, is_active, deleted_at) VALUES ($1, 'solo', '0.9.0', 'u', 'u', 'CodeBuildStep', false, now())", [ORG]);
    expect(await deactivateIfUnreferenced({ pluginId: id, orgId: ORG, pluginName: 'solo', fromVersion: '1.0.0' })).toBe(false);
  });
  it('is deactivated (never deleted) once its fix exists and nothing references it', async () => {
    const id = await plugin(ORG, 'lint', '1.0.0', { flagged: true });
    await plugin(ORG, 'lint', '1.0.1');
    expect(await deactivateIfUnreferenced({ pluginId: id, orgId: ORG, pluginName: 'lint', fromVersion: '1.0.0' })).toBe(true);
    expect((await raw.query<any>('SELECT is_active, deleted_at FROM plugins WHERE id = $1', [id])).rows[0]).toEqual({ is_active: false, deleted_at: null });
    pipelinesOnVersion.mockResolvedValueOnce([{ pipelineId: 'x' }] as never);
    await raw.query('UPDATE plugins SET is_active = true WHERE id = $1', [id]);
    expect(await deactivateIfUnreferenced({ pluginId: id, orgId: ORG, pluginName: 'lint', fromVersion: '1.0.0' })).toBe(false);
  });
});

describe('cancel on delete', () => {
  it('cancels live remediations of the deleted versions and their rollouts', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'rolling_out'");
    expect(await cancelRemediationsFor({ orgId: ORG, pluginIds: [row.pluginId], reason: 'version_deleted' })).toBe(1);
    expect((await rowsOf(row.pluginId))[0]).toMatchObject({ stage: 'failed', outcome: 'cancelled' });
    expect(rollout.cancelRollout).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), 'version_deleted');
    expect(await cancelRemediationsFor({ orgId: OTHER, pluginIds: [row.pluginId], reason: 'version_deleted' })).toBe(0);
  });
});

describe('the rollout report', () => {
  const S = (status: string) => ({ status, toVersion: '1.0.1', waves: [], counts: { eligible: 1, proposed: 0, changeRequested: 0, moved: 1, failed: 0, rolledBack: 1, skippedOptOut: 0, skippedRunner: 0 }, updatedAt: '2026-11-20T00:00:00Z' }) as any;
  const ev = { kind: 'rolled_back' as const, orgId: ORG, pipelineId: '00000000-0000-4000-8000-0000000000aa', fromVersion: '1.0.0', toVersion: '1.0.1', at: '2026-11-20T01:00:00Z' };
  it('stores progress, moves the stage, and notifies each rollback once', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'rolling_out', to_version = '1.0.1'");
    await applyRolloutReport(row.id, { summary: S('batches'), events: [ev] });
    await applyRolloutReport(row.id, { summary: S('batches'), events: [ev] });
    expect(notices.filter((n) => n.code === 'N38')).toHaveLength(1);
    const paused = await applyRolloutReport(row.id, { summary: S('paused'), events: [] });
    expect(paused!.stage).toBe('needs_review');
    expect(notices.filter((n) => n.code === 'N37')).toHaveLength(1);
    expect((paused!.rollout as any).rolledBackPipelineIds).toEqual([ev.pipelineId]);
    expect(await applyRolloutReport('00000000-0000-4000-8000-000000000999', { summary: S('done'), events: [] })).toBeNull();
  });
});

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any }> } };
async function call(method: string, path: string, req: Record<string, unknown> = {}, orgId = ORG) {
  const router = createRemediationRoutes() as unknown as { stack: Layer[] };
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method])!;
  const handlers = layer.route!.stack.map((s) => s.handle);
  const res: any = { statusCode: 0, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  await handlers[handlers.length - 1]!({ params: {}, query: {}, body: {}, headers: {}, user: { sub: 'u-1', organizationId: orgId, principalType: 'user', permissions: ['plugins:read', 'plugins:write'], features: [] }, ...req }, res, () => undefined);
  return res;
}

describe('routes', () => {
  it('lists the org\'s own remediations with the knob and today\'s cap use; another org sees none', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    const res = await call('get', '/remediations');
    expect(res.body.data).toMatchObject({ enabled: true, usedToday: 1, maxPerDay: 20, nextCursor: null });
    expect(res.body.data.remediations[0]).toMatchObject({ id: row.id, stage: 'queued', targetedCount: 1, hasPatch: false });
    expect(res.body.data.remediations[0]).not.toHaveProperty('findingsHash');
    expect((await call('get', '/remediations/:id', { params: { id: row.id } }, OTHER)).statusCode).toBe(404);
  });

  it('approve / reject only from awaiting_approval (409 REMEDIATION_STAGE_CONFLICT otherwise)', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    const early = await call('post', '/remediations/:id/approve', { params: { id: row.id } });
    expect(early.statusCode).toBe(409);
    expect(early.body).toMatchObject({ code: 'REMEDIATION_STAGE_CONFLICT', details: { stage: 'queued' } });
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval'");
    const ok = await call('post', '/remediations/:id/approve', { params: { id: row.id }, body: { reason: 'looks right' } });
    expect(ok.statusCode).toBe(202);
    expect(enqueued[0]![2]).toMatchObject({ jobId: `remediation-${row.id}-approved` });
    expect((await call('post', '/remediations/:id/reject', { params: { id: row.id } })).statusCode).toBe(409);
  });

  it('retry makes a new attempt and holds the daily cap', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'error'");
    const res = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
    expect(res.statusCode).toBe(202);
    expect(res.body.data).toMatchObject({ attempt: 2, retryOf: row.id });
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 2 });
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'error'");
    expect((await call('post', '/remediations/:id/retry', { params: { id: row.id } })).statusCode).toBe(429);
  });

  it('list: filters by stage and plugin; an invalid query is a 400', async () => {
    const a = await queued(ORG, 'lint', '1.0.0');
    await queued(ORG, 'fmt', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'needs_owner' WHERE id = $1", [a.id]);
    const byStage = await call('get', '/remediations', { query: { stage: 'needs_owner, failed' } });
    expect(byStage.body.data.remediations.map((r: any) => r.id)).toEqual([a.id]);
    const byName = await call('get', '/remediations', { query: { pluginName: 'fmt' } });
    expect(byName.body.data.remediations.map((r: any) => r.pluginName)).toEqual(['fmt']);
    expect((await call('get', '/remediations', { query: { limit: 'lots' } })).statusCode).toBe(400);
    expect((await call('get', '/remediations', { query: { stage: 'bogus' } })).statusCode).toBe(400);
    expect((await call('get', '/remediations/:id', { params: { id: a.id } })).body.data).toMatchObject({ id: a.id, stage: 'needs_owner' });
  });

  it('patch and export: served as a text/x-diff attachment when stored, 404 otherwise; never another org\'s', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    const stored = new Map([['k/patch', '--- a/x\n+++ b/x\n'], ['k/export', '--- a/deploy/plugins/lint/x\n']]);
    setRemediationArtifactReaderForTests(async (k) => stored.get(k) ?? null);
    try {
      expect((await call('get', '/remediations/:id/patch', { params: { id: row.id } })).statusCode).toBe(404);
      expect((await call('get', '/remediations/:id/export', { params: { id: row.id } })).statusCode).toBe(404);
      await raw.query("UPDATE plugin_remediations SET patch_key = 'k/patch', export_key = 'k/export' WHERE id = $1", [row.id]);
      const patch = await call('get', '/remediations/:id/patch', { params: { id: row.id } });
      expect(patch.statusCode).toBe(200);
      expect(patch.headers['Content-Type']).toBe('text/x-diff; charset=utf-8');
      expect(patch.headers['Content-Disposition']).toContain('lint-1.0.0-remediation.diff');
      expect(patch.body).toContain('+++ b/x');
      const exp = await call('get', '/remediations/:id/export', { params: { id: row.id } });
      expect(exp.body).toContain('deploy/plugins/lint');
      expect(exp.headers['Content-Disposition']).toContain('lint-1.0.0-export.diff');
      expect((await call('get', '/remediations/:id/patch', { params: { id: row.id } }, OTHER)).statusCode).toBe(404);
      // A stored key whose object is gone is a 404 too, not an empty download.
      await raw.query("UPDATE plugin_remediations SET patch_key = 'k/gone' WHERE id = $1", [row.id]);
      expect((await call('get', '/remediations/:id/patch', { params: { id: row.id } })).statusCode).toBe(404);
    } finally {
      setRemediationArtifactReaderForTests();
    }
  });

  it('reject: awaiting_approval → failed / rejected with the decider and reason; an approved one is not rejectable', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval'");
    const res = await call('post', '/remediations/:id/reject', { params: { id: row.id }, body: { reason: 'not this one' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ stage: 'failed', outcome: 'rejected', decidedBy: 'u-1' });
    expect(counters).toContainEqual(['plugin_remediations_total', { stage: 'failed', outcome: 'rejected' }]);
    expect(audits.mock.calls.map((c) => (c[0] as any).action)).toContain('plugin.remediation.rejected');
    const other = await queued(ORG, 'fmt', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval', decided_at = now() WHERE id = $1", [other.id]);
    expect((await call('post', '/remediations/:id/reject', { params: { id: other.id } })).statusCode).toBe(409);
    expect((await call('post', '/remediations/:id/approve', { params: { id: other.id } })).body).toMatchObject({ code: 'REMEDIATION_STAGE_CONFLICT', details: { stage: 'approved and publishing' } });
  });

  it('retry: only from failed / needs_owner / needs_review; refused while the operator knob is off; a paused rollout\'s row closes', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    expect((await call('post', '/remediations/:id/retry', { params: { id: row.id } })).statusCode).toBe(409);
    await raw.query("UPDATE plugin_remediations SET stage = 'needs_review'");
    setPluginServiceConfigForTests({ enabled: false });
    expect((await call('post', '/remediations/:id/retry', { params: { id: row.id } })).statusCode).toBe(503);
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20 });
    const res = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
    expect(res.statusCode).toBe(202);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'done', outcome: 'superseded' });
  });

  it('settings: a team inherits the root\'s rollout and cannot set allowPipelineApply; per-type levels clear with null', async () => {
    const TEAM = 'ccccccccccccccccccccccc1';
    const asTeam = { user: { sub: 'u-1', organizationId: TEAM, parentOrganizationId: ORG, principalType: 'user', permissions: ['plugins:read', 'org_settings:write'], features: [] } };
    await call('put', '/remediation-settings', { body: { rollout: 'apply', allowPipelineApply: false } });
    const got = await call('get', '/remediation-settings', asTeam, TEAM);
    expect(got.body.data).toMatchObject({ isTeam: true, root: { rollout: 'apply', allowPipelineApply: false }, settings: { rollout: 'inherit' }, canEdit: true });
    expect((await call('put', '/remediation-settings', { ...asTeam, body: { allowPipelineApply: true } }, TEAM)).statusCode).toBe(400);
    await call('put', '/remediation-settings', { body: { libraryUpgradeLevelByType: { npm: 'patch', deb: 'major' } } });
    const cleared = await call('put', '/remediation-settings', { body: { libraryUpgradeLevelByType: { npm: null } } });
    expect(cleared.body.data.settings.libraryUpgradeLevelByType).toEqual({ deb: 'major' });
    expect((await call('put', '/by-name/:name/remediation-level', { params: { name: 'Not A Name!' }, body: { level: 'patch' } })).statusCode).toBe(400);
  });

  it('settings: a root cannot inherit; a per-plugin level is set and cleared', async () => {
    expect((await call('put', '/remediation-settings', { body: { rollout: 'inherit' } })).statusCode).toBe(400);
    expect((await call('put', '/remediation-settings', { body: { mode: 'apply', libraryUpgradeLevelByType: { npm: 'patch' } } })).body.data.settings).toMatchObject({ mode: 'apply', libraryUpgradeLevelByType: { npm: 'patch' } });
    await call('put', '/by-name/:name/remediation-level', { params: { name: 'lint' }, body: { level: 'patch' } });
    expect((await call('get', '/remediation-settings')).body.data.settings.libraryUpgradeLevelByPlugin).toEqual({ lint: 'patch' });
    await call('put', '/by-name/:name/remediation-level', { params: { name: 'lint' }, body: { level: null } });
    expect((await call('get', '/remediation-settings')).body.data.settings.libraryUpgradeLevelByPlugin).toEqual({});
  });
});
