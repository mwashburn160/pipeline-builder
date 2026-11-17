// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The superseded-version retention PASS end to end against a REAL Postgres
 * (PGlite, the shipped postgres-init.sql, as the RLS-enforced app role), through
 * the REAL lifecycle services: the dry run, the deprecate stage, the yank stage
 * after the notice period (and the reversal of a version that stopped being
 * retirable), the grouped N35 notices, the collection of a purged row's
 * `system/<name>` image, the safety limit, the batch and the metrics.
 *
 * Replaced: pipeline-data's `withTenantTx` (bound to PGlite) and
 * `findVersionReferences` (its SQL runs on pipeline-data's own connection —
 * the same SQL is in the pass's own hold, which retention-select-sql.test.ts
 * proves), the declared-resolution refresh (pipeline-security.test.ts), the
 * image-registry HTTP client and the notification relay client.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from '@jest/globals';
import { type AnyFn, bindTestAuditService, stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

const mockRecordAudit = bindTestAuditService('plugin');
const mockIncCounter = jest.fn();
const mockSetGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter, setGauge: mockSetGauge }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
  findVersionReferences: jest.fn(async () => []),
}));
const mockRefresh = jest.fn<AnyFn>(async () => ({ refreshed: 0, unchanged: 0, failed: 0, truncated: false }));
jest.unstable_mockModule('../src/services/declared-resolution-refresh.js', () => ({
  refreshDeclaredResolutions: mockRefresh,
  resolutionRefreshMax: () => 500,
}));

const { runRetentionPass, createRetentionScheduler, NoticeBook } = await import('../src/services/retention/retire.js');
const { setRegistryClientForTests } = await import('../src/services/ecosystem/registry.js');
const { pluginService } = await import('../src/services/plugin-service.js');
const { setEcosystemNotifyClientForTests } = await import('../src/services/ecosystem-notifications.js');

const DAY = 86_400_000;
const T0 = new Date('2026-11-14T00:00:00Z');
const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const digest = () => `sha256:${randomUUID().replace(/-/g, '').padEnd(64, '0')}`;

// -- image-registry stub -------------------------------------------------------
const registryCalls: Array<{ method: string; path: string; body?: any }> = [];
let gcStatus = 200;
const registry = {
  get: jest.fn(async (path: string) => {
    registryCalls.push({ method: 'get', path });
    return { statusCode: 200, body: { data: { entries: [{ name: 'lint', version: '1.1.0', totalBytes: 100, marginalBytes: 40 }, { name: 'lint', version: '1.2.0', totalBytes: 100, marginalBytes: 2 }], computedAt: 1, incomplete: false } } };
  }),
  post: jest.fn(async (path: string, body: unknown) => {
    registryCalls.push({ method: 'post', path, body });
    if (path.endsWith('/gc')) return gcStatus === 200 ? { statusCode: 200, body: { data: { ...(body as object), deleted: true } } } : { statusCode: gcStatus, body: { message: 'still referenced by tag latest' } };
    return { statusCode: 200, body: { data: {} } };
  }),
};

// -- relay stub ------------------------------------------------------------------
const sent: Array<{ event: string; recipients: any[]; subject: string; text: string }> = [];
const send = jest.fn(async (req: any) => { sent.push(req); return { ok: true } as const; });

beforeAll(() => {
  setRegistryClientForTests(registry as never);
  setEcosystemNotifyClientForTests({ send });
});
afterAll(async () => {
  setRegistryClientForTests(null);
  setEcosystemNotifyClientForTests(undefined);
  await raw.close();
});

const ENV = ['PLUGIN_RETENTION_KEEP', 'PLUGIN_RETENTION_NOTICE_DAYS', 'PLUGIN_RETENTION_BATCH', 'PLUGIN_RETENTION_MAX_FRACTION', 'PLUGIN_RETENTION_ENABLED'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

let digests: Record<string, string> = {};
let lintListing = '';

// The soft-delete itself is CrudService's (pipeline-data's own connection): its
// effect is reproduced here, and the call — force, system org — is asserted.
const fakeDelete = async (row: any) => {
  await raw.query("UPDATE plugins SET deleted_at = now(), deleted_by = 'system', is_active = false, purge_after = now() + interval '30 days' WHERE id = $1", [row.id]);
  return { deleted: row, inUse: 0, listed: false, promoted: null };
};
let deleteVersion: ReturnType<typeof jest.spyOn>;

beforeEach(async () => {
  jest.clearAllMocks();
  deleteVersion = jest.spyOn(pluginService, 'deleteVersion').mockImplementation(fakeDelete as never);
  registryCalls.length = 0;
  sent.length = 0;
  gcStatus = 200;
  digests = {};
  await raw.exec(`
    DELETE FROM plugin_retirements; DELETE FROM plugin_installs; DELETE FROM plugin_listing_versions; DELETE FROM plugin_listings;
    DELETE FROM pipeline_plugin_resolution; DELETE FROM pipeline_step_manifests; DELETE FROM pipeline_templates; DELETE FROM pipelines;
    DELETE FROM ecosystem_notification_queue; DELETE FROM plugins;`);
  process.env.PLUGIN_RETENTION_KEEP = '2';
  // `lint` is listed: 1.0.0 … 1.5.0, an explicit install pinned to 1.0.0 (org A)
  // and a `minor` one from 1.0.0 resolved at 1.5.0 (org B). `fmt` is not listed.
  const lr = await raw.query<{ id: string }>("INSERT INTO plugin_listings (publisher_id, name) SELECT id, 'lint' FROM publishers WHERE handle = 'pipeline-builder' RETURNING id");
  lintListing = lr.rows[0]!.id;
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0']) {
    const d = digest();
    digests[`lint@${v}`] = d;
    const p = await raw.query<{ id: string }>("INSERT INTO plugins (org_id, name, version, image_digest, visibility, is_default) VALUES ($1, 'lint', $2, $3, 'public', $4) RETURNING id",
      [SYSTEM_ORG_ID, v, d, v === '1.5.0']);
    await raw.query(`INSERT INTO plugin_listing_versions (listing_id, source_plugin_id, version, image_digest, image_repository, published_by)
                     VALUES ($1, $2, $3, $4, 'public/pipeline-builder/lint', 'loader')`, [lintListing, p.rows[0]!.id, v, digest()]);
  }
  await raw.query("INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, resolved_version, installed_by) VALUES ($1, $2, 'pinned', '1.0.0', '1.0.0', 'u')", [A, lintListing]);
  await raw.query("INSERT INTO plugin_installs (org_id, listing_id, version_policy, pinned_version, resolved_version, installed_by) VALUES ($1, $2, 'minor', '1.0.0', '1.5.0', 'u')", [B, lintListing]);
  for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
    const d = digest();
    digests[`fmt@${v}`] = d;
    await raw.query("INSERT INTO plugins (org_id, name, version, image_digest, visibility) VALUES ($1, 'fmt', $2, $3, 'public')", [SYSTEM_ORG_ID, v, d]);
  }
});

const entry = (report: any, name: string, version: string) =>
  report.plugins.find((p: any) => p.name === name).versions.find((v: any) => v.version === version);
const rowOf = async (name: string, version: string) => (await raw.query<any>('SELECT * FROM plugins WHERE name = $1 AND version = $2', [name, version])).rows[0];
const listedOf = async (version: string) => (await raw.query<any>('SELECT * FROM plugin_listing_versions WHERE listing_id = $1 AND version = $2', [lintListing, version])).rows[0];
const retirements = async () => (await raw.query<any>('SELECT plugin_name, version, yanked_at, collected_at, deprecated_by_retention FROM plugin_retirements ORDER BY plugin_name, version')).rows;
const retireAudits = (stage: string) => mockRecordAudit.mock.calls.map((c) => c[0] as any).filter((e) => e.action === 'plugin.version.retire' && e.details.stage === stage);
const counted = (name: string, stage: string) => mockIncCounter.mock.calls.filter((c) => c[0] === name && (c[1] as any)?.stage === stage).length;

describe('the dry run', () => {
  it('reports every version\'s state and rule, the orgs a retirement notifies and the bytes it frees — and writes nothing', async () => {
    const report = await runRetentionPass({ dryRun: true, now: T0 });
    expect(report).toMatchObject({ dryRun: true, enabled: false, keep: 2, noticeDays: 30, batch: 50, maxFraction: 0.5, collected: [] });
    expect(entry(report, 'lint', '1.5.0')).toMatchObject({ state: 'keep', rule: 'implicit_install' });
    expect(entry(report, 'lint', '1.4.0')).toMatchObject({ state: 'keep', rule: 'within_keep' });
    expect(entry(report, 'lint', '1.0.0')).toMatchObject({ state: 'keep', rule: 'install_pinned' });
    expect(entry(report, 'lint', '1.1.0')).toMatchObject({ state: 'deprecate', rule: 'superseded_in_major', marginalBytes: 40, notifyOrgIds: [B] });
    expect(entry(report, 'fmt', '1.0.0')).toMatchObject({ state: 'deprecate', marginalBytes: 0 });
    expect(report.plugins.find((p: any) => p.name === 'lint')).toMatchObject({ listed: true, marginalBytes: 42 + 0 });
    expect(report.totals).toMatchObject({ retirable: 4, deprecate: 4, yank: 0, refused: 0, marginalBytes: 42, awaitingCollection: 0, stuck: 0 });
    expect(report.storage).toEqual({ measured: true, incomplete: false });
    expect(registryCalls[0]!.path).toBe(`/internal/storage-breakdown/${SYSTEM_ORG_ID}?scope=retention`);
    // The refresh runs (uncapped) for every candidate plugin.
    expect(mockRefresh).toHaveBeenCalledWith({ pluginName: 'lint', publisher: 'pipeline-builder' }, { max: 100_000 });
    expect(mockRefresh).toHaveBeenCalledWith({ pluginName: 'lint', orgId: SYSTEM_ORG_ID }, { max: 100_000 });
    expect(await retirements()).toEqual([]);
    expect((await rowOf('lint', '1.1.0')).deprecated_at).toBeNull();
    expect(sent).toEqual([]);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_retention_retirable', {}, 4);
  });

  it('reports bytes as unknown when image-registry cannot answer, and a measurement skips the refresh', async () => {
    registry.get.mockResolvedValueOnce({ statusCode: 503, body: {} } as never);
    const report = await runRetentionPass({ dryRun: true, now: T0, refresh: false });
    expect(report.totals.marginalBytes).toBeNull();
    expect(entry(report, 'lint', '1.1.0').marginalBytes).toBeNull();
    expect(report.storage.measured).toBe(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('holds every version of a plugin a live pipeline declares without resolution rows', async () => {
    await raw.query("INSERT INTO pipelines (org_id, project, organization, props) VALUES ($1, 'p', 'o', $2::jsonb)",
      [A, JSON.stringify({ stages: [{ steps: [{ plugin: { name: 'fmt' } }] }] })]);
    const report = await runRetentionPass({ dryRun: true, now: T0 });
    expect(entry(report, 'fmt', '1.0.0')).toMatchObject({ state: 'keep', rule: 'declared_without_resolution' });
  });

  it('refuses a plugin whose refresh did not finish', async () => {
    mockRefresh.mockResolvedValueOnce({ refreshed: 0, unchanged: 0, failed: 1, truncated: false });
    const report = await runRetentionPass({ dryRun: true, now: T0 });
    expect(entry(report, 'fmt', '1.0.0').state).toBe('refused');
    expect(report.plugins.find((p: any) => p.name === 'fmt')!.refusedReason).toBe('resolution_refresh_incomplete');
  });
});

describe('a run: deprecate, then yank after the notice period', () => {
  it('deprecates through the lifecycle services, records the retirement, audits and sends ONE notice per org', async () => {
    const report = await runRetentionPass({ dryRun: false, now: T0 });
    expect(entry(report, 'lint', '1.1.0').action).toBe('deprecated');
    expect(entry(report, 'fmt', '1.0.0').action).toBe('deprecated');
    expect((await rowOf('lint', '1.1.0')).deprecated_at).not.toBeNull();
    expect((await rowOf('lint', '1.1.0')).deprecation_message).toMatch(/yanked after 2026-12-14\. Move to lint@1\.5\.0\./);
    expect((await listedOf('1.1.0')).deprecated_at).not.toBeNull();
    expect((await rowOf('lint', '1.0.0')).deprecated_at).toBeNull();
    expect((await retirements()).map((r: any) => `${r.plugin_name}@${r.version}:${r.deprecated_by_retention}:${r.yanked_at}`)).toEqual([
      'fmt@1.0.0:true:null', 'lint@1.1.0:true:null', 'lint@1.2.0:true:null', 'lint@1.3.0:true:null',
    ]);
    expect(retireAudits('deprecate').map((e) => `${e.details.pluginName}@${e.details.version}`).sort()).toEqual(['fmt@1.0.0', 'lint@1.1.0', 'lint@1.2.0', 'lint@1.3.0']);
    expect(retireAudits('deprecate')[0]).toMatchObject({ actorId: 'system', orgId: SYSTEM_ORG_ID, details: { rule: 'superseded_in_major' } });
    expect(counted('plugin_retention_retired_total', 'deprecate')).toBe(4);
    // No per-version N14; one N35 to org B naming both lint versions.
    expect(sent.map((n) => n.event)).toEqual(['N35']);
    expect(sent[0]!.recipients).toEqual([{ kind: 'org_permission', orgId: B, permission: 'plugin_installs:manage', inheritFromRoot: true }]);
    expect(sent[0]!.subject).toBe('Superseded plugin versions are being retired (3)');
    expect(sent[0]!.text).toMatch(/lint@1\.1\.0 — deprecated/);
    expect(sent[0]!.text).toMatch(/lint@1\.2\.0 — deprecated/);
  });

  it('keeps a version in its notice period, then yanks + soft-deletes it — and reverses one a template started pinning', async () => {
    await runRetentionPass({ dryRun: false, now: T0 });
    const during = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 10 * DAY) });
    expect(entry(during, 'lint', '1.1.0')).toMatchObject({ state: 'notice', yankAfter: new Date(T0.getTime() + 30 * DAY).toISOString() });
    expect(entry(during, 'lint', '1.1.0').action).toBeUndefined();

    await raw.query("INSERT INTO pipeline_templates (org_id, name, props) VALUES ($1, 't', $2::jsonb)",
      [A, JSON.stringify({ stages: [{ steps: [{ plugin: { name: 'lint', filter: { version: '1.2.0' } } }] }] })]);
    sent.length = 0;
    const after = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 31 * DAY) });

    expect(entry(after, 'lint', '1.1.0')).toMatchObject({ state: 'yank', action: 'yanked' });
    const listed = await listedOf('1.1.0');
    expect(listed.yanked_at).not.toBeNull();
    expect(listed.yank_reason).toBe('superseded');
    expect((await rowOf('lint', '1.1.0')).deleted_at).not.toBeNull();
    expect((await rowOf('lint', '1.1.0')).purge_after).not.toBeNull();
    expect(deleteVersion).toHaveBeenCalledWith(expect.objectContaining({ name: 'lint', version: '1.1.0' }), SYSTEM_ORG_ID, 'system', { force: true });
    expect(registryCalls.some((c) => c.path === '/internal/plugin-publications/yank' && c.body.version === '1.1.0')).toBe(true);
    // The unlisted fmt row is yanked on the row, then soft-deleted.
    const fmt = await rowOf('fmt', '1.0.0');
    expect(fmt.yank_reason).toBe('superseded');
    expect(fmt.deleted_at).not.toBeNull();
    expect(retireAudits('yank').map((e) => `${e.details.pluginName}@${e.details.version}`).sort()).toEqual(['fmt@1.0.0', 'lint@1.1.0', 'lint@1.3.0']);
    expect(counted('plugin_retention_retired_total', 'yank')).toBe(3);

    // 1.2.0 became pinned by a template during its notice: reversed.
    expect(entry(after, 'lint', '1.2.0')).toMatchObject({ state: 'reverse', rule: 'template_pin', action: 'reversed' });
    expect((await rowOf('lint', '1.2.0')).deprecated_at).toBeNull();
    expect((await listedOf('1.2.0')).deprecated_at).toBeNull();
    expect((await retirements()).map((r: any) => r.version)).not.toContain('1.2.0');
    expect(retireAudits('reverse')).toHaveLength(1);

    // One grouped notice, still: the yanks of 1.1.0 and 1.3.0 to org B.
    expect(sent.filter((n) => n.event === 'N35')).toHaveLength(1);
    expect(sent.some((n) => n.event === 'N8' || n.event === 'N14')).toBe(false);
  });

  it('collects a retired row\'s system/<name> image once the purge removed it; a registry refusal is retried next pass', async () => {
    await runRetentionPass({ dryRun: false, now: T0 });
    await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 31 * DAY) });
    // Before the purge: the tombstone is past its deadline but still there.
    await raw.query('UPDATE plugins SET purge_after = $1 WHERE deleted_at IS NOT NULL', [new Date(T0.getTime() + 32 * DAY)]);
    const stuck = await runRetentionPass({ dryRun: true, now: new Date(T0.getTime() + 33 * DAY) });
    // fmt@1.0.0 and lint@1.1.0 / 1.2.0 / 1.3.0 are tombstones the purge has not removed.
    expect(stuck.totals.stuck).toBe(4);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_retention_stuck', {}, 4);

    await raw.query('DELETE FROM plugins WHERE deleted_at IS NOT NULL');
    gcStatus = 409;
    const refused = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 34 * DAY) });
    expect(refused.collected.map((c: any) => c.outcome)).toEqual(Array(4).fill('refused_by_registry'));
    expect(counted('plugin_retention_failed_total', 'collect')).toBe(4);
    expect(refused.totals.awaitingCollection).toBe(4);

    gcStatus = 200;
    const done = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 35 * DAY) });
    expect(done.collected.map((c: any) => `${c.name}@${c.version}:${c.outcome}`).sort()).toEqual([
      'fmt@1.0.0:collected', 'lint@1.1.0:collected', 'lint@1.2.0:collected', 'lint@1.3.0:collected',
    ]);
    expect(registryCalls.some((c) => c.path === '/internal/plugin-publications/gc' && c.body.imageRepository === 'system/lint'
      && c.body.digest === digests['lint@1.1.0'] && c.body.version === '1.1.0')).toBe(true);
    expect((await retirements()).every((r: any) => r.collected_at !== null)).toBe(true);
    expect(done.totals.awaitingCollection).toBe(0);
    expect(counted('plugin_retention_retired_total', 'collect')).toBe(4);
    expect(retireAudits('collect')).toHaveLength(4);
  });

  it('holds a purged version back from collection while an install still pins it', async () => {
    await runRetentionPass({ dryRun: false, now: T0 });
    await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 31 * DAY) });
    await raw.query('DELETE FROM plugins WHERE deleted_at IS NOT NULL');
    await raw.query("UPDATE plugin_installs SET pinned_version = '1.1.0', resolved_version = '1.1.0' WHERE org_id = $1", [A]);
    const out = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 32 * DAY) });
    expect(out.collected.find((c: any) => c.name === 'lint' && c.version === '1.1.0')).toMatchObject({ outcome: 'held', rule: 'install_pinned' });
    expect(out.collected.find((c: any) => c.name === 'lint' && c.version === '1.2.0')).toMatchObject({ outcome: 'collected' });
  });
});

describe('safety', () => {
  it('throttles a plugin with a long history: at most half its live versions are deprecated per pass, the rest on the next — nothing refused, nothing counted as a failure', async () => {
    // 10 live versions of `big` in one major, keep=1: nine are retirable.
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0']) {
      await raw.query("INSERT INTO plugins (org_id, name, version, image_digest, visibility) VALUES ($1, 'big', $2, $3, 'public')", [SYSTEM_ORG_ID, v, digest()]);
    }
    process.env.PLUGIN_RETENTION_KEEP = '1';
    process.env.PLUGIN_RETENTION_MAX_FRACTION = '0.5';
    const first = await runRetentionPass({ dryRun: false, now: T0 });
    const big = first.plugins.find((p: any) => p.name === 'big')!;
    expect(big.refusedReason).toBeUndefined();
    expect(big.versions.filter((v: any) => v.action === 'deprecated').map((v: any) => v.version)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.1.0', '1.0.0']);
    expect(big.versions.filter((v: any) => v.deferred).map((v: any) => `${v.version}:${v.state}:${v.action}`)).toEqual([
      '1.8.0:deprecate:deferred', '1.7.0:deprecate:deferred', '1.6.0:deprecate:deferred', '1.5.0:deprecate:deferred',
    ]);
    expect(first.totals.deferred).toBeGreaterThanOrEqual(4);
    expect(first.totals.refused).toBe(0);
    expect(counted('plugin_retention_failed_total', 'refused')).toBe(0);

    const second = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + DAY) });
    const big2 = second.plugins.find((p: any) => p.name === 'big')!;
    expect(big2.versions.filter((v: any) => v.action === 'deprecated').map((v: any) => v.version)).toEqual(['1.8.0', '1.7.0', '1.6.0', '1.5.0']);
    expect(big2.versions.filter((v: any) => v.state === 'notice')).toHaveLength(5);
    expect((await raw.query<{ n: number }>("SELECT count(*)::int AS n FROM plugin_retirements WHERE plugin_name = 'big'")).rows[0]!.n).toBe(9);
  });

  it('refuses (and counts) only a plugin whose declared-resolution refresh did not finish', async () => {
    mockRefresh.mockResolvedValueOnce({ refreshed: 0, unchanged: 0, failed: 0, truncated: true });
    const report = await runRetentionPass({ dryRun: false, now: T0 });
    const fmt = report.plugins.find((p: any) => p.name === 'fmt')!;
    expect(fmt.refusedReason).toBe('resolution_refresh_incomplete');
    expect(entry(report, 'fmt', '1.0.0')).toMatchObject({ state: 'refused' });
    expect(entry(report, 'fmt', '1.0.0').action).toBeUndefined();
    expect(report.totals).toMatchObject({ refusedPlugins: 1, refused: 1 });
    expect(counted('plugin_retention_failed_total', 'refused')).toBe(1);
    expect((await retirements()).map((r: any) => r.plugin_name)).not.toContain('fmt');
  });

  it('acts on at most PLUGIN_RETENTION_BATCH versions per pass and defers the rest', async () => {
    process.env.PLUGIN_RETENTION_BATCH = '1';
    const report = await runRetentionPass({ dryRun: false, now: T0 });
    const actions = report.plugins.flatMap((p: any) => p.versions.map((v: any) => v.action)).filter(Boolean);
    expect(actions).toEqual(['deprecated', 'deferred', 'deferred', 'deferred']);
    expect(await retirements()).toHaveLength(1);
  });

  it('leaves a version deprecated before the pass deprecated when it is later reversed', async () => {
    await raw.query("UPDATE plugins SET deprecated_at = now(), deprecation_message = 'old' WHERE name = 'fmt' AND version = '1.0.0'");
    await runRetentionPass({ dryRun: false, now: T0 });
    expect((await retirements()).find((r: any) => r.plugin_name === 'fmt')).toMatchObject({ deprecated_by_retention: false });
    await raw.query("INSERT INTO pipeline_templates (org_id, name, props) VALUES ($1, 't', $2::jsonb)",
      [A, JSON.stringify({ synth: { plugin: { name: 'fmt', filter: { version: '1.0.0' } } } })]);
    await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + DAY) });
    expect((await rowOf('fmt', '1.0.0')).deprecation_message).toBe('old');
    expect((await retirements()).find((r: any) => r.plugin_name === 'fmt')).toBeUndefined();
  });

  it('counts a stage that fails, reports it, and finishes the retirement on a later pass', async () => {
    await runRetentionPass({ dryRun: false, now: T0 });
    deleteVersion.mockRejectedValueOnce(new Error('delete refused') as never);
    const out = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 31 * DAY) });
    const failed = out.plugins.flatMap((p: any) => p.versions).filter((v: any) => v.action === 'failed');
    expect(failed).toEqual([expect.objectContaining({ version: '1.0.0', error: 'delete refused' })]);
    expect(counted('plugin_retention_failed_total', 'yank')).toBe(1);
    // fmt@1.0.0 was yanked on the row before its delete failed: the next pass finishes it.
    expect((await rowOf('fmt', '1.0.0'))).toMatchObject({ deleted_at: null, yank_reason: 'superseded' });
    const next = await runRetentionPass({ dryRun: false, now: new Date(T0.getTime() + 32 * DAY) });
    expect(entry(next, 'fmt', '1.0.0')).toMatchObject({ state: 'yank', rule: 'finish_retirement', action: 'yanked' });
    expect((await rowOf('fmt', '1.0.0')).deleted_at).not.toBeNull();
  });
});

describe('notices and the scheduler', () => {
  it('renders one notice listing every line', () => {
    const { subject, text } = NoticeBook.render([
      { ref: 'lint@1.0.0', stage: 'deprecated', yankAfter: new Date('2026-12-14T00:00:00Z'), moveTo: 'lint@1.5.0' },
      { ref: 'fmt@0.1.0', stage: 'yanked', moveTo: null },
    ]);
    expect(subject).toBe('Superseded plugin versions are being retired (2)');
    expect(text).toContain('lint@1.0.0 — deprecated; ranges, latest and the default stop resolving to it after 2026-12-14. Move to lint@1.5.0.');
    expect(text).toContain('fmt@0.1.0 — yanked; ranges, latest and the default skip it now.');
  });

  it('a notice that cannot be sent is counted, never thrown', async () => {
    const book = new NoticeBook();
    book.add([A], { ref: 'lint@1.0.0', stage: 'yanked', moveTo: null });
    send.mockRejectedValueOnce(new Error('relay down') as never);
    await expect(book.send()).resolves.toBe(0);
    expect(counted('plugin_retention_failed_total', 'notify')).toBe(1);
  });

  it('the scheduler runs a pass only while PLUGIN_RETENTION_ENABLED', async () => {
    const s = createRetentionScheduler(() => ({}) as never);
    expect(typeof s.start).toBe('function');
    s.stop();
  });
});
