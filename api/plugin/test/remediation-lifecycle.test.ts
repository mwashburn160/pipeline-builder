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

import { describe, it, expect, beforeAll, beforeEach, afterAll, jest } from '@jest/globals';
import { bindTestAuditService, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

const realApiCore = await import('@pipeline-builder/api-core');
const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;
const audits = bindTestAuditService('plugin');

const pipelinesOnVersion = jest.fn<AnyFn>(async () => []);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  // findVersionReferences opens its own pool: no pipeline references anything here (a purge's guard).
  ...realPipelineData, withTenantTx: testDb.withTenantTx, pipelinesOnVersion, findVersionReferences: async () => [],
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
  // The purge's teardown (services/version-purge.ts).
  deletePluginSourcePrefix: jest.fn<AnyFn>(async () => undefined),
  recordSourceOrphan: jest.fn<AnyFn>(async () => undefined),
  retryPluginSourceOrphans: jest.fn<AnyFn>(async () => ({ tried: 0, cleared: 0, failed: 0 })),
};
jest.unstable_mockModule('../src/services/plugin-sources.js', () => sources);
const rollout = { startTenantRollout: jest.fn<AnyFn>(async () => ({ ok: true })), cancelRollout: jest.fn<AnyFn>(async () => true), setRolloutClientForTests: jest.fn() };
jest.unstable_mockModule('../src/services/remediation/rollout.js', () => rollout);
const persisted: any[] = [];
/** Runs inside persistVersion before the row is stored (a concurrent delete, in a test). */
let duringPersist: (() => Promise<unknown>) | null = null;
jest.unstable_mockModule('../src/services/version-persist.js', () => ({
  persistVersion: jest.fn(async (input: any) => {
    persisted.push(input);
    if (duringPersist) { const f = duringPersist; duringPersist = null; await f(); }
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
const { processRemediationJob, runRemediation } = await import('../src/queue/plugin-remediation.js');
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
const rowsOf = async (pluginId: string | null) => (await raw.query<any>('SELECT * FROM plugin_remediations WHERE plugin_id = $1 ORDER BY created_at', [pluginId])).rows;
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
    expect(c.remediation).toMatchObject({ enabled: false, severities: ['critical'], concurrency: 2, baseConcurrency: 4, maxPerOrgPerDay: 20, sourcesBucket: 'plugin-sources' });
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.PLUGIN_REMEDIATION_ENABLED = 'no';
    process.env.PLUGIN_REMEDIATION_SEVERITIES = ' Critical ';
    expect(loadPluginServiceConfig(warn).remediation).toMatchObject({ enabled: true, severities: ['critical'] });
    // High is an explicit opt-in.
    process.env.PLUGIN_REMEDIATION_SEVERITIES = 'high,critical';
    expect(loadPluginServiceConfig(warn).remediation.severities).toEqual(['critical', 'high']);
    delete process.env.PLUGIN_REMEDIATION_ENABLED; delete process.env.PLUGIN_REMEDIATION_SEVERITIES;
    // Unset: Critical only (KEV-listed findings are targeted regardless).
    expect(loadPluginServiceConfig(warn).remediation.severities).toEqual(['critical']);
    expect(warn).toHaveBeenCalledTimes(1);
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

  it('a failed enqueue whose ENQUEUE_FAILED write also fails is logged, and the pass enqueues the next row', async () => {
    const a = await plugin(ORG, 'a', '1.0.0');
    const b = await plugin(ORG, 'b', '1.0.0');
    // The status write of a failed enqueue throws (the database refuses it).
    await raw.exec(`
      CREATE OR REPLACE FUNCTION test_refuse_enqueue_failed() RETURNS trigger AS $$
      BEGIN IF NEW.error = 'ENQUEUE_FAILED' THEN RAISE EXCEPTION 'status write refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_refuse_enqueue_failed BEFORE UPDATE ON plugin_remediations FOR EACH ROW EXECUTE FUNCTION test_refuse_enqueue_failed();`);
    try {
      const failing = jest.fn<AnyFn>(async () => undefined).mockRejectedValueOnce(new Error('redis down'));
      const result = await queuePassRemediations([cand(a, 'a', '1.0.0', [finding()]), cand(b, 'b', '1.0.0', [finding()])], { enqueue: failing });
      expect(failing).toHaveBeenCalledTimes(2);
      expect(result.queued).toBe(1);
    } finally {
      await raw.exec('DROP TRIGGER test_refuse_enqueue_failed ON plugin_remediations; DROP FUNCTION test_refuse_enqueue_failed();');
    }
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

  // The modtime trigger stamps every UPDATE: switch it off to age a row.
  const age = async (id: string, hours: number) => {
    await raw.exec('ALTER TABLE plugin_remediations DISABLE TRIGGER update_plugin_remediations_modtime');
    try {
      await raw.query(`UPDATE plugin_remediations SET updated_at = now() - interval '${hours} hours' WHERE id = $1`, [id]);
    } finally {
      await raw.exec('ALTER TABLE plugin_remediations ENABLE TRIGGER update_plugin_remediations_modtime');
    }
  };

  it('a stranded remediation (queued, no live job, hours old) is re-enqueued a bounded number of times, then failed STRANDED', async () => {
    const id = await plugin(ORG, 'lint', '1.0.0');
    await queuePassRemediations([cand(id, 'lint', '1.0.0', [finding()])], { enqueue });
    const [row] = await rowsOf(id);
    enqueue.mockClear();
    // Fresh: left alone.
    await queuePassRemediations([], { enqueue });
    expect(enqueue).not.toHaveBeenCalled();
    for (let n = 1; n <= 3; n++) {
      await age(row.id, 5);
      const r = await queuePassRemediations([], { enqueue });
      expect(r).toMatchObject({ requeued: 1 });
      expect(enqueue).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ remediationId: row.id }), expect.objectContaining({ jobId: `remediation-${row.id}` }));
      expect((await getRemediation(row.id))!).toMatchObject({ stage: 'queued', error: `STRANDED_REQUEUE:${n}` });
    }
    await age(row.id, 5);
    const r = await queuePassRemediations([], { enqueue });
    expect(r).toMatchObject({ requeued: 0, stranded: 1 });
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'failed', outcome: 'error', error: 'STRANDED' });
    expect(counters).toContainEqual(['plugin_remediations_total', { stage: 'failed', outcome: 'error' }]);
  });

  it('a stranded approved run is re-enqueued as the approved job; a row with a live job, or an undecided proposal, is left alone', async () => {
    const a = await plugin(ORG, 'a', '1.0.0');
    const b = await plugin(ORG, 'b', '1.0.0');
    const c = await plugin(ORG, 'c', '1.0.0');
    await queuePassRemediations([cand(a, 'a', '1.0.0', [finding()]), cand(b, 'b', '1.0.0', [finding()]), cand(c, 'c', '1.0.0', [finding()])], { enqueue });
    const [ra] = await rowsOf(a);
    const [rb] = await rowsOf(b);
    const [rc] = await rowsOf(c);
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval', decided_at = now(), decided_by = 'u-1' WHERE id = $1", [ra.id]);
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval' WHERE id = $1", [rc.id]);
    await raw.query("UPDATE plugin_remediations SET stage = 'rebuild' WHERE id = $1", [rb.id]);
    for (const r of [ra, rb, rc]) await age(r.id, 5);
    enqueue.mockClear();
    const hasLiveJob = jest.fn<AnyFn>(async (row: any) => row.id === rb.id);
    const r = await queuePassRemediations([], { enqueue, hasLiveJob });
    expect(r).toMatchObject({ requeued: 1, stranded: 0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(ORG, expect.objectContaining({ remediationId: ra.id }), expect.objectContaining({ jobId: `remediation-${ra.id}-approved` }));
    expect((await getRemediation(rb.id))!.stage).toBe('rebuild');
    expect((await getRemediation(rc.id))!).toMatchObject({ stage: 'awaiting_approval', error: null });
  });

  it('the nightly pass holds the cap under the same per-org lock as retry', async () => {
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 1 });
    const a = await plugin(ORG, 'a', '1.0.0');
    const b = await plugin(ORG, 'b', '1.0.0');
    const [x, y] = await Promise.all([
      queuePassRemediations([cand(a, 'a', '1.0.0', [finding()])], { enqueue }),
      queuePassRemediations([cand(b, 'b', '1.0.0', [finding()])], { enqueue }),
    ]);
    expect(x.queued + y.queued).toBe(1);
    expect(x.capped + y.capped).toBe(1);
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
  // A freshly queued row always names its (stored) version.
  return (await getRemediation((await rowsOf(id))[0].id))! as PluginRemediation & { pluginId: string };
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

  it('apply: a publish whose rollout start is refused (4xx) stays published, gives up at once and says so (N36 then N37)', async () => {
    await settings(ORG, 'apply');
    const row = await queued(ORG, 'lint', '1.0.0');
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '400', permanent: true });
    expect(await runRemediation(row, { ports: ports() })).toBe('published');
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'published', error: 'rollout_start_failed', rollout: { startAttempts: 1, lastStartStatus: '400' } });
    expect(notices.map((n) => n.code)).toEqual(['N36', 'N37']);
    expect(counters).toContainEqual(['plugin_remediation_rollout_start_failures_total', { reason: 'permanent' }]);
  });

  it('apply: a publish whose rollout start fails transiently counts the attempt and leaves it to the sweep', async () => {
    await settings(ORG, 'apply');
    const row = await queued(ORG, 'lint', '1.0.0');
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '503', permanent: false });
    expect(await runRemediation(row, { ports: ports() })).toBe('published');
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'published', error: null, rollout: { startAttempts: 1, lastStartStatus: '503' } });
    expect(notices.map((n) => n.code)).toEqual(['N36']);
  });

  it('publish keeps the diff under the FIX version\'s prefix: purging the from-version\'s prefix leaves it downloadable', async () => {
    await settings(ORG, 'apply');
    const objects = new Map<string, string>();
    sources.putRemediationArtifact.mockImplementation(async (k: string, b: Buffer | string) => { objects.set(k, String(b)); });
    setRemediationArtifactReaderForTests(async (k) => objects.get(k) ?? null);
    try {
      const row = await queued(ORG, 'lint', '1.0.0');
      expect(await runRemediation(row, { ports: ports() })).toBe('rolling_out');
      const after = (await getRemediation(row.id))!;
      const fromPrefix = realApiCore.pluginSourceVersionPrefix(ORG, row.pluginId, '1.0.0');
      const fixPrefix = realApiCore.pluginSourceVersionPrefix(ORG, after.toPluginId!, after.toVersion!);
      expect(after.patchKey).toBe(realApiCore.remediationDiffKey(ORG, after.toPluginId!, after.toVersion!, row.id));
      // The from-version's own copy was written first (the reviewer's diff while it ran).
      expect(objects.get(realApiCore.remediationDiffKey(ORG, row.pluginId, '1.0.0', row.id))).toBe(objects.get(after.patchKey!));
      // The from-version's purge deletes its whole prefix.
      for (const k of [...objects.keys()]) if (k.startsWith(fromPrefix)) objects.delete(k);
      expect([...objects.keys()].every((k) => k.startsWith(fixPrefix))).toBe(true);
      const patch = await call('get', '/remediations/:id/patch', { params: { id: row.id } });
      expect(patch.statusCode).toBe(200);
      expect(patch.body).toBe(objects.get(after.patchKey!));
    } finally {
      setRemediationArtifactReaderForTests();
      sources.putRemediationArtifact.mockImplementation(async () => undefined);
    }
  });

  it('a failed copy under the fix version keeps the from-version key; the publish still lands', async () => {
    await settings(ORG, 'apply');
    sources.putRemediationArtifact.mockImplementation(async (k: string) => { if (!k.includes('/1.0.0/')) throw new Error('rustfs down'); });
    try {
      const row = await queued(ORG, 'lint', '1.0.0');
      expect(await runRemediation(row, { ports: ports() })).toBe('rolling_out');
      expect((await getRemediation(row.id))!.patchKey).toBe(realApiCore.remediationDiffKey(ORG, row.pluginId, '1.0.0', row.id));
    } finally {
      sources.putRemediationArtifact.mockImplementation(async () => undefined);
    }
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

  it('a cancel that lands while the fix version is stored is not overwritten as published, and nothing rolls out', async () => {
    await settings(ORG, 'apply');
    const row = await queued(ORG, 'lint', '1.0.0');
    duringPersist = () => raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'cancelled', error = 'VERSION_DELETED' WHERE id = $1", [row.id]);
    await runRemediation(row, { ports: ports() });
    expect((await rowsOf(row.pluginId))[0]).toMatchObject({ stage: 'failed', outcome: 'cancelled', error: 'VERSION_DELETED' });
    expect(rollout.startTenantRollout).not.toHaveBeenCalled();
  });

  it('with the operator knob off, a queued job ends its row (cancelled, retryable) instead of stranding it queued', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    setPluginServiceConfigForTests({ enabled: false });
    const job: any = { data: { remediationId: row.id }, attemptsMade: 0, opts: { attempts: 2 } };
    expect(await processRemediationJob(job, undefined, { ports: ports() })).toBe('failed');
    expect((await rowsOf(row.pluginId))[0]).toMatchObject({ stage: 'failed', outcome: 'cancelled', error: 'REMEDIATION_DISABLED' });
    // An undecided proposal is left alone: it waits for a person, not for the job.
    const other = await plugin(ORG, 'fmt', '1.0.0');
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 20, concurrency: 2 });
    await queuePassRemediations([cand(other, 'fmt', '1.0.0', [finding()])], { enqueue });
    const [waiting] = await rowsOf(other);
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval' WHERE id = $1", [waiting.id]);
    setPluginServiceConfigForTests({ enabled: false });
    expect(await processRemediationJob({ ...job, data: { remediationId: waiting.id } }, undefined, { ports: ports() })).toBe('skipped');
    expect((await rowsOf(other))[0].stage).toBe('awaiting_approval');
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

describe('org checks on remediation rows', () => {
  const base = (orgId: string, pluginId: string | null, extra: Record<string, unknown> = {}): any => ({
    orgId, pluginId, pluginName: 'lint', fromVersion: '1.0.0', findingsHash: 'e'.repeat(64), targeted: [finding()], createdBy: 'u-1', ...extra,
  });

  it('refuses an insert whose plugin_id or to_plugin_id is another org\'s (or missing); writes nothing', async () => {
    const { insertRemediation, insertRemediationUnderCap } = await import('../src/services/remediation/store.js');
    const mine = await plugin(ORG, 'lint', '1.0.0');
    const theirs = await plugin(OTHER, 'lint', '1.0.0');
    const official = await plugin(SYSTEM, 'lint', '1.0.0');
    expect(await insertRemediationUnderCap(base(ORG, theirs), 20)).toEqual({ status: 'refused' });
    expect(await insertRemediationUnderCap(base(ORG, official), 20)).toEqual({ status: 'refused' });
    expect(await insertRemediationUnderCap(base(ORG, mine, { toPluginId: theirs }), 20)).toEqual({ status: 'refused' });
    expect(await insertRemediationUnderCap(base(ORG, '00000000-0000-4000-8000-00000000dead'), 20)).toEqual({ status: 'refused' });
    // plugin_id is nullable only so a fix record outlives its version's purge: an insert always names one.
    expect(await insertRemediationUnderCap(base(ORG, null), 20)).toEqual({ status: 'refused' });
    expect(await insertRemediation(base(ORG, null))).toBeNull();
    expect(await insertRemediation(base(ORG, theirs))).toBeNull();
    expect((await raw.query('SELECT id FROM plugin_remediations')).rows).toEqual([]);
    // The row's own org: inserted (case-insensitively), the system org's Official rows included.
    expect((await insertRemediationUnderCap(base(ORG.toUpperCase(), mine), 20)).status).toBe('inserted');
    expect((await insertRemediationUnderCap(base(SYSTEM, official), 20)).status).toBe('inserted');
    expect(await insertRemediation(base(OTHER, theirs))).not.toBeNull();
  });

  it('a fix version of another org is never written as to_plugin_id', async () => {
    const { updateRemediation } = await import('../src/services/remediation/store.js');
    const row = await queued(ORG, 'lint', '1.0.0');
    const theirs = await plugin(OTHER, 'lint', '1.0.1');
    expect(await updateRemediation(row.id, { toPluginId: theirs, toVersion: '1.0.1' })).toBeNull();
    expect((await getRemediation(row.id))!.toPluginId).toBeNull();
    const mine = await plugin(ORG, 'lint', '1.0.1');
    expect((await updateRemediation(row.id, { toPluginId: mine, toVersion: '1.0.1' }))!.toPluginId).toBe(mine);
  });

  it('a retry whose row names another org\'s version is a 404 and inserts nothing', async () => {
    const theirs = await plugin(OTHER, 'lint', '1.0.0');
    const row = await queued(ORG, 'fmt', '1.0.0');
    // A corrupted row (written before the check): its plugin_id is another org's.
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', plugin_id = $2 WHERE id = $1", [row.id, theirs]);
    await settings(ORG, 'propose');
    const res = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
    expect(res.statusCode).toBe(404);
    expect((await raw.query('SELECT id FROM plugin_remediations')).rows).toHaveLength(1);
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

const START_FAILURES = 'plugin_remediation_rollout_start_failures_total';
/** A nightly pass `n` days from now (every row is long past the 15-minute guard). */
const night = (n: number) => () => new Date(Date.now() + (n + 1) * 86_400_000);

describe('a rollout start that failed at publish', () => {
  /** A published fix of `orgId` whose rollout was never started, last touched `minutes` ago. */
  async function publishedFix(orgId: string, name: string, minutes: number, start?: Record<string, unknown>, error: string | null = null) {
    const row = await queued(orgId, name, '1.0.0');
    const fix = await plugin(orgId, name, '1.0.1');
    await raw.exec('ALTER TABLE plugin_remediations DISABLE TRIGGER update_plugin_remediations_modtime');
    try {
      await raw.query(`UPDATE plugin_remediations SET stage = 'published', to_version = '1.0.1', to_plugin_id = $2, rollout = $3, error = $4, updated_at = now() - interval '${minutes} minutes' WHERE id = $1`,
        [row.id, fix, start ? JSON.stringify(start) : null, error]);
    } finally {
      await raw.exec('ALTER TABLE plugin_remediations ENABLE TRIGGER update_plugin_remediations_modtime');
    }
    return row.id;
  }

  it('is started again by the nightly sweep until the pipeline service takes it, then never again', async () => {
    const id = await publishedFix(ORG, 'lint', 60);
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '503', permanent: false });
    expect(await queuePassRemediations([], { enqueue })).toMatchObject({ rolloutsStarted: 0 });
    expect(rollout.startTenantRollout).toHaveBeenCalledTimes(1);
    expect(rollout.startTenantRollout).toHaveBeenCalledWith(expect.objectContaining({ id, stage: 'published', toVersion: '1.0.1' }));
    expect((await getRemediation(id))!).toMatchObject({ stage: 'published', error: null, rollout: { startAttempts: 2, lastStartStatus: '503' } });

    // The next night.
    expect(await queuePassRemediations([], { enqueue, now: night(1) })).toMatchObject({ rolloutsStarted: 1 });
    expect(rollout.startTenantRollout).toHaveBeenCalledTimes(2);
    expect((await getRemediation(id))!.stage).toBe('rolling_out');

    // Started: the sweep never starts it again.
    await queuePassRemediations([], { enqueue, now: night(2) });
    expect(rollout.startTenantRollout).toHaveBeenCalledTimes(2);
    expect(counters.filter(([n]) => n === START_FAILURES)).toEqual([]);
  });

  it('a permanent refusal (a 4xx other than 408 / 429) is given up at once: error rollout_start_failed, N37, counted, never retried', async () => {
    const id = await publishedFix(ORG, 'lint', 60);
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '422', permanent: true });
    await queuePassRemediations([], { enqueue });
    const row = (await getRemediation(id))!;
    expect(row).toMatchObject({ stage: 'published', error: 'rollout_start_failed', rollout: { startAttempts: 2, lastStartStatus: '422' } });
    expect(counters.filter(([n]) => n === START_FAILURES)).toEqual([[START_FAILURES, { reason: 'permanent' }]]);
    const n37 = notices.filter((n) => n.code === 'N37');
    expect(n37).toHaveLength(1);
    expect(n37[0]).toMatchObject({ orgId: ORG, remediationId: id, toVersion: '1.0.1', summary: { status: 'paused', toVersion: '1.0.1' }, startFailure: { reason: 'permanent', lastStatus: '422', attempts: 2 } });

    // Given up: the sweep leaves it alone from now on.
    await queuePassRemediations([], { enqueue, now: night(1) });
    expect(rollout.startTenantRollout).toHaveBeenCalledTimes(1);
    expect(notices.filter((n) => n.code === 'N37')).toHaveLength(1);
  });

  it('408 and 429 are transient like a 5xx or an unreachable service', async () => {
    for (const status of ['408', '429', 'unreachable']) {
      await raw.exec('DELETE FROM plugin_remediations; DELETE FROM plugins;');
      const id = await publishedFix(ORG, 'lint', 60);
      rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status, permanent: false });
      await queuePassRemediations([], { enqueue });
      expect((await getRemediation(id))!).toMatchObject({ stage: 'published', error: null, rollout: { lastStartStatus: status } });
    }
    expect(counters.filter(([n]) => n === START_FAILURES)).toEqual([]);
  });

  it('transient failures are retried nightly up to 5 attempts in all (the publish attempt counted), then given up as exhausted', async () => {
    const id = await publishedFix(ORG, 'lint', 60, { startAttempts: 1, lastStartStatus: '503' });
    rollout.startTenantRollout.mockResolvedValue({ ok: false, status: '503', permanent: false });
    for (let night_ = 0; night_ < 6; night_++) await queuePassRemediations([], { enqueue, now: night(night_) });
    // Attempts 2..5 by the sweep; the 6th night does nothing.
    expect(rollout.startTenantRollout).toHaveBeenCalledTimes(4);
    expect((await getRemediation(id))!).toMatchObject({ stage: 'published', error: 'rollout_start_failed', rollout: { startAttempts: 5, lastStartStatus: '503' } });
    expect(counters.filter(([n]) => n === START_FAILURES)).toEqual([[START_FAILURES, { reason: 'exhausted' }]]);
    expect(notices.filter((n) => n.code === 'N37')).toMatchObject([{ startFailure: { reason: 'exhausted', attempts: 5, lastStatus: '503' } }]);
    rollout.startTenantRollout.mockReset();
    rollout.startTenantRollout.mockResolvedValue({ ok: true });
  });

  it('a published fix whose fix version was purged (to_plugin_id NULL) ends done / cancelled instead of staying live', async () => {
    // Official first: the pass inside the second helper call never starts a system-org rollout.
    const official = await publishedFix(SYSTEM, 'official', 60);
    const id = await publishedFix(ORG, 'lint', 60);
    await raw.query("DELETE FROM plugins WHERE version = '1.0.1'");
    expect((await getRemediation(id))!.toPluginId).toBeNull();
    expect(await queuePassRemediations([], { enqueue })).toMatchObject({ fixPurged: 2 });
    for (const r of [id, official]) {
      expect((await getRemediation(r))!).toMatchObject({ stage: 'done', outcome: 'cancelled', error: 'FIX_VERSION_PURGED' });
      expect((await getRemediation(r))!.finishedAt).not.toBeNull();
    }
    expect(rollout.startTenantRollout).not.toHaveBeenCalled();
    expect(counters).toContainEqual(['plugin_remediations_total', { stage: 'done', outcome: 'cancelled' }]);
  });

  it('leaves a just-published fix (its publish may still be starting it) and an Official fix alone', async () => {
    await publishedFix(ORG, 'fresh', 1);
    await publishedFix(SYSTEM, 'official', 60);
    expect(await queuePassRemediations([], { enqueue })).toMatchObject({ rolloutsStarted: 0 });
    expect(rollout.startTenantRollout).not.toHaveBeenCalled();
  });
});

describe('restarting a given-up rollout start (POST …/retry on a published fix)', () => {
  async function givenUp(orgId = ORG) {
    const row = await queued(orgId, 'lint', '1.0.0');
    const fix = await plugin(orgId, 'lint', '1.0.1');
    await raw.query("UPDATE plugin_remediations SET stage = 'published', to_version = '1.0.1', to_plugin_id = $2, error = 'rollout_start_failed', rollout = $3 WHERE id = $1",
      [row.id, fix, JSON.stringify({ startAttempts: 5, lastStartStatus: '503' })]);
    return row.id;
  }

  it('shows the start bookkeeping on the card (rolloutStart), never as a rollout summary', async () => {
    const id = await givenUp();
    const res = await call('get', '/remediations/:id', { params: { id } });
    expect(res.body.data).toMatchObject({ stage: 'published', error: 'rollout_start_failed', rollout: null, rolloutStart: { attempts: 5, lastStatus: '503' } });
  });

  it('starts the rollout again in place: rolling_out, error cleared, attempts reset, no new attempt row', async () => {
    const id = await givenUp();
    const res = await call('post', '/remediations/:id/retry', { params: { id } });
    expect(res.statusCode).toBe(202);
    expect(rollout.startTenantRollout).toHaveBeenCalledWith(expect.objectContaining({ id, stage: 'published', toVersion: '1.0.1' }));
    expect(res.body.data).toMatchObject({ id, stage: 'rolling_out', error: null, rolloutStart: null });
    expect((await getRemediation(id))!).toMatchObject({ stage: 'rolling_out', error: null, rollout: null });
    expect((await raw.query('SELECT id FROM plugin_remediations')).rows).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    expect(audits.mock.calls.map((c) => c[0] as any)).toContainEqual(expect.objectContaining({ action: 'plugin.remediation.retried', targetId: id, details: expect.objectContaining({ rolloutRestart: true }) }));
  });

  it('a restart that fails transiently clears the error and counts from 1 again (the sweep retries it)', async () => {
    const id = await givenUp();
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '502', permanent: false });
    const res = await call('post', '/remediations/:id/retry', { params: { id } });
    expect(res.statusCode).toBe(202);
    expect((await getRemediation(id))!).toMatchObject({ stage: 'published', error: null, rollout: { startAttempts: 1, lastStartStatus: '502' } });
  });

  it('a restart refused again keeps the error (no second N37)', async () => {
    const id = await givenUp();
    rollout.startTenantRollout.mockResolvedValueOnce({ ok: false, status: '403', permanent: true });
    const res = await call('post', '/remediations/:id/retry', { params: { id } });
    expect(res.statusCode).toBe(202);
    expect(res.body.data).toMatchObject({ stage: 'published', error: 'rollout_start_failed', rolloutStart: { attempts: 1, lastStatus: '403' } });
    expect(notices.filter((n) => n.code === 'N37')).toHaveLength(0);
  });

  it('a published fix still being retried by the sweep (no error), or another org\'s, is refused as today', async () => {
    const id = await givenUp();
    expect((await call('post', '/remediations/:id/retry', { params: { id } }, OTHER)).statusCode).toBe(404);
    await raw.query('UPDATE plugin_remediations SET error = NULL WHERE id = $1', [id]);
    const res = await call('post', '/remediations/:id/retry', { params: { id } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'REMEDIATION_STAGE_CONFLICT', details: { stage: 'published' } });
    expect(rollout.startTenantRollout).not.toHaveBeenCalled();
  });

  it('is refused while the org\'s mode is off, like every retry', async () => {
    const id = await givenUp();
    await settings(ORG, 'off');
    const res = await call('post', '/remediations/:id/retry', { params: { id } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLUGIN_REMEDIATION_MODE_OFF' });
    expect(rollout.startTenantRollout).not.toHaveBeenCalled();
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

  it('a report for a given-up start (it had landed after all) moves it on and clears the start error', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'published', to_version = '1.0.1', error = 'rollout_start_failed', rollout = $1", [JSON.stringify({ startAttempts: 5, lastStartStatus: '503' })]);
    const moved = await applyRolloutReport(row.id, { summary: S('batches'), events: [] });
    expect(moved).toMatchObject({ stage: 'rolling_out', error: null });
    expect(moved!.rollout).not.toHaveProperty('startAttempts');
  });

  it('two concurrent deliveries of the same report notify the rollback once', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'rolling_out', to_version = '1.0.1'");
    await Promise.all([
      applyRolloutReport(row.id, { summary: S('batches'), events: [ev] }),
      applyRolloutReport(row.id, { summary: S('batches'), events: [ev] }),
    ]);
    expect(notices.filter((n) => n.code === 'N38')).toHaveLength(1);
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

  it('approve: two concurrent approvals decide (and queue) it once', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval'");
    const results = await Promise.all([
      call('post', '/remediations/:id/approve', { params: { id: row.id }, body: { reason: 'a' } }),
      call('post', '/remediations/:id/approve', { params: { id: row.id }, body: { reason: 'b' } }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(enqueued).toHaveLength(1);
  });

  it('approve: refused while the operator knob is off (503), the row stays undecided', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval'");
    setPluginServiceConfigForTests({ enabled: false });
    expect((await call('post', '/remediations/:id/approve', { params: { id: row.id } })).statusCode).toBe(503);
    expect((await getRemediation(row.id))!.decidedAt).toBeNull();
    expect(enqueued).toHaveLength(0);
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
    // The reason the person typed is on the audit row (and the row's decision_reason).
    expect(audits.mock.calls.map((c) => c[0] as any).find((a) => a.action === 'plugin.remediation.rejected').details).toMatchObject({ reason: 'not this one' });
    expect((await getRemediation(row.id))!.decisionReason).toBe('not this one');
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

  it('retry of a paused rollout refused by an attempt already building for the version leaves the paused row as it was', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'needs_review'");
    // Another findings set of the same version is already building (the active-version index refuses a second one).
    await raw.query(
      `INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, created_by)
       VALUES ($1, $2, 'lint', '1.0.0', $3, 'queued', 'u-1')`, [ORG, row.pluginId, 'e'.repeat(64)]);
    const res = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect((await getRemediation(row.id))!).toMatchObject({ stage: 'needs_review', outcome: null });
  });

  const handlersOf = (method: string, path: string) => {
    const router = createRemediationRoutes() as unknown as { stack: Layer[] };
    return router.stack.find((l) => l.route?.path === path && l.route.methods[method])!.route!.stack.map((x) => x.handle);
  };

  it('retry steps up like approve and reject', () => {
    for (const path of ['/remediations/:id/approve', '/remediations/:id/reject', '/remediations/:id/retry']) {
      expect(handlersOf('post', path)).toContain(realApiCore.requireStepUp);
    }
  });

  it('approve and retry are refused (409 PLUGIN_REMEDIATION_MODE_OFF) while the org\'s mode is off, and allowed again once it is on', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await settings(ORG, 'off');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval'");
    const approve = await call('post', '/remediations/:id/approve', { params: { id: row.id } });
    expect(approve.statusCode).toBe(409);
    expect(approve.body).toMatchObject({ code: 'PLUGIN_REMEDIATION_MODE_OFF', details: { mode: 'off' } });
    expect((await getRemediation(row.id))!.decidedAt).toBeNull();
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'error'");
    const retry = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
    expect(retry.statusCode).toBe(409);
    expect(retry.body).toMatchObject({ code: 'PLUGIN_REMEDIATION_MODE_OFF' });
    expect(await rowsOf(row.pluginId)).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    // Back on: the retry goes through.
    await settings(ORG, 'propose');
    expect((await call('post', '/remediations/:id/retry', { params: { id: row.id } })).statusCode).toBe(202);
  });

  it('concurrent retries never exceed the daily cap (count and insert under one per-org lock)', async () => {
    const rows = [];
    for (const name of ['a', 'b', 'c', 'd']) rows.push(await queued(ORG, name, '1.0.0'));
    // Yesterday's rows: they don't count toward today's cap.
    await raw.query("UPDATE plugin_remediations SET stage = 'failed', outcome = 'error', created_at = now() - interval '2 days'");
    setPluginServiceConfigForTests({ enabled: true, severities: ['critical', 'high'], maxPerOrgPerDay: 2 });
    const results = await Promise.all(rows.map((r) => call('post', '/remediations/:id/retry', { params: { id: r.id } })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 202, 429, 429]);
    const today = await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM plugin_remediations WHERE created_at > now() - interval '1 day'");
    expect(today.rows[0]!.n).toBe(2);
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

describe('purging the from-version', () => {
  // The purge itself is pipeline-data's CrudService on its OWN `db`: install this
  // PGlite as that db too (the session goes back to the superuser seeding role).
  beforeAll(async () => {
    const { bootTenantDb } = await import('@pipeline-builder/pipeline-data/testing');
    await bootTenantDb(raw as never);
    await raw.exec('RESET ROLE');
  });

  it('keeps the fix record (plugin_id NULL, diff still served), deletes the attempts that never produced a fix; the survivor cannot be retried', async () => {
    const { pluginService } = await import('../src/services/plugin-service.js');
    await settings(ORG, 'apply');
    const objects = new Map<string, string>();
    sources.putRemediationArtifact.mockImplementation(async (k: string, b: Buffer | string) => { objects.set(k, String(b)); });
    sources.deletePluginSourcePrefix.mockImplementation(async (i: { prefix: string }) => { for (const k of [...objects.keys()]) if (k.startsWith(i.prefix)) objects.delete(k); });
    setRemediationArtifactReaderForTests(async (k) => objects.get(k) ?? null);
    try {
      const row = await queued(ORG, 'lint', '1.0.0');
      const fromId = row.pluginId!;
      expect(await runRemediation(row, { ports: ports() })).toBe('rolling_out');
      // A paused rollout (retryable), and an earlier attempt of another findings set that never produced a fix.
      await raw.query("UPDATE plugin_remediations SET stage = 'needs_review' WHERE id = $1", [row.id]);
      const { rows: [unpublished] } = await raw.query<{ id: string }>(
        `INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, outcome, created_by)
         VALUES ($1, $2, 'lint', '1.0.0', $3, 'failed', 'rejected', 'u-1') RETURNING id`, [ORG, fromId, 'f'.repeat(64)]);
      // Soft-deleted (a tombstone), then purged through the plugin service's own purge.
      await raw.query("UPDATE plugins SET is_active = false, deleted_at = now(), image_digest = NULL, visibility = 'org' WHERE id = $1", [fromId]);
      const purged = await realPipelineData.runWithTenantContext({ orgId: ORG, isSuperAdmin: false }, () => pluginService.purgeById(fromId, ORG));
      expect(purged).toBe(fromId);
      expect((await raw.query('SELECT id FROM plugins WHERE id = $1', [fromId])).rows).toEqual([]);
      expect(sources.deletePluginSourcePrefix).toHaveBeenCalledWith(expect.objectContaining({ prefix: realApiCore.pluginSourceVersionPrefix(ORG, fromId, '1.0.0') }));

      const { rows: left } = await raw.query<any>('SELECT id, plugin_id, plugin_name, from_version, to_plugin_id FROM plugin_remediations ORDER BY created_at');
      expect(left).toEqual([expect.objectContaining({ id: row.id, plugin_id: null, plugin_name: 'lint', from_version: '1.0.0' })]);
      expect(left[0].to_plugin_id).not.toBeNull();
      expect(left.map((r: { id: string }) => r.id)).not.toContain(unpublished!.id);

      const list = await call('get', '/remediations');
      expect(list.body.data.remediations).toEqual([expect.objectContaining({ id: row.id, pluginId: null, pluginName: 'lint', fromVersion: '1.0.0', hasPatch: true })]);
      const one = await call('get', '/remediations/:id', { params: { id: row.id } });
      expect(one.statusCode).toBe(200);
      const patch = await call('get', '/remediations/:id/patch', { params: { id: row.id } });
      expect(patch.statusCode).toBe(200);
      expect(patch.body).toBe(objects.get((await getRemediation(row.id))!.patchKey!));

      const retry = await call('post', '/remediations/:id/retry', { params: { id: row.id } });
      expect(retry.statusCode).toBe(409);
      expect(retry.body).toMatchObject({ code: 'REMEDIATION_STAGE_CONFLICT', details: { reason: 'source_version_purged' } });
      expect((await raw.query('SELECT id FROM plugin_remediations')).rows).toHaveLength(1);
    } finally {
      setRemediationArtifactReaderForTests();
      sources.putRemediationArtifact.mockImplementation(async () => undefined);
      sources.deletePluginSourcePrefix.mockImplementation(async () => undefined);
    }
  });

  it('the fleet posture keys versions only: a purged version\'s record is counted, never listed under a null id', async () => {
    const { fleetRemediationPosture } = await import('../src/services/remediation/posture.js');
    const kept = await queued(ORG, 'lint', '1.0.0');
    const gone = await queued(ORG, 'fmt', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'done', outcome = 'cleared', plugin_id = NULL WHERE id = $1", [gone.id]);
    const p = await fleetRemediationPosture();
    expect(p.byVersion).toEqual({ [kept.pluginId!]: 'queued' });
    expect(p.stages).toMatchObject({ queued: 1, done: 1 });
  });

  it('a rollout report on a row whose from-version was purged deactivates nothing', async () => {
    expect(await deactivateIfUnreferenced({ pluginId: null, orgId: ORG, pluginName: 'lint', fromVersion: '1.0.0' })).toBe(false);
  });

  it('approve of a row whose from-version was purged is refused 409, never a 500', async () => {
    const row = await queued(ORG, 'lint', '1.0.0');
    await raw.query("UPDATE plugin_remediations SET stage = 'awaiting_approval', plugin_id = NULL WHERE id = $1", [row.id]);
    const res = await call('post', '/remediations/:id/approve', { params: { id: row.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'REMEDIATION_STAGE_CONFLICT', details: { reason: 'source_version_purged' } });
    expect((await getRemediation(row.id))!.decidedAt).toBeNull();
  });
});
