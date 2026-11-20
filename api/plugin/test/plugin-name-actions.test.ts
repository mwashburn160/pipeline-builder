// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Delete plugin / Restore plugin / Purge plugin (services/plugin-name-actions.ts)
 * end to end against a REAL Postgres (PGlite + the shipped init script, as the
 * app role under RLS) through the REAL plugin service, with an in-memory RustFS.
 *
 * Replaced: the name lock (an in-memory one, so a held lock can be simulated),
 * the queue scan (in-flight builds), the remediation engine's cancel, the N14
 * sender, the image-registry discard, the quota reservation and the audit sink.
 */

import { createHash } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { createFakeS3Store, fakeS3Module } from './helpers/fake-s3.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const s3 = createFakeS3Store();
jest.unstable_mockModule('@aws-sdk/client-s3', () => fakeS3Module(s3));

const mockRecordAudit = jest.fn<AnyFn>();
const mockDecrementQuota = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: mockRecordAudit, decrementQuota: mockDecrementQuota }));

let quotaDenied = false;
const RESET_AT = '2026-12-01T00:00:00.000Z';
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: mockIncCounter,
  withQuotaReservation: async (_opts: unknown, body: (slot: unknown) => Promise<unknown>) => {
    if (quotaDenied) return { status: 'denied' };
    return { status: 'done', value: await body({ refund: jest.fn(), markConsumed: jest.fn(), reservation: { quota: { resetAt: RESET_AT } } }) };
  },
}));

const locked = new Set<string>();
const lockEvents: string[] = [];
jest.unstable_mockModule('../src/helpers/plugin-name-lock.js', () => ({
  withPluginNameLock: async (orgId: string, name: string, fn: () => Promise<unknown>) => {
    const key = `${orgId}:${name}`;
    if (locked.has(key)) throw Object.assign(new Error('locked'), { code: 'PLUGIN_NAME_LOCKED', statusCode: 409 });
    locked.add(key);
    lockEvents.push(`lock:${name}`);
    try { return await fn(); } finally { locked.delete(key); lockEvents.push(`unlock:${name}`); }
  },
  isPluginNameLocked: async (orgId: string, name: string) => locked.has(`${orgId}:${name}`),
  assertPluginNameUnlocked: async () => undefined,
}));

const mockCancelQueued = jest.fn<AnyFn>(async () => { lockEvents.push('cancelQueued'); return { builds: 1, remediations: 0 }; });
const mockWaitForRunning = jest.fn<AnyFn>(async () => { lockEvents.push('waitForRunning'); return 0; });
const mockCountInFlight = jest.fn<AnyFn>(async () => ({ builds: 2, remediations: 1 }));
jest.unstable_mockModule('../src/queue/name-inflight.js', () => ({
  cancelQueued: mockCancelQueued, waitForRunning: mockWaitForRunning, countInFlight: mockCountInFlight,
}));
const mockCancelRemediationsFor = jest.fn<AnyFn>(async () => { lockEvents.push('cancelRemediations'); return 1; });
jest.unstable_mockModule('../src/services/remediation/cancel.js', () => ({ cancelRemediationsFor: mockCancelRemediationsFor }));
const mockNotifyWithdrawal = jest.fn<AnyFn>(async () => 1);
jest.unstable_mockModule('../src/services/version-withdrawal.js', () => ({ notifyWithdrawal: mockNotifyWithdrawal, onVersionWithdrawn: jest.fn() }));
const mockDiscard = jest.fn<AnyFn>(async () => ({ deleted: 3 }));
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({ discardPluginImage: mockDiscard }));
const realPipelineCore = await import('@pipeline-builder/pipeline-core');
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  ...realPipelineCore,
  Config: new Proxy(realPipelineCore.Config, {
    get: (target, prop) => (prop === 'get'
      ? (k: string) => (k === 'registry' ? { host: 'registry', port: 5000, network: '', http: true } : (target.get as AnyFn)(k))
      : (target as any)[prop]),
  }),
}));

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);
const { runWithTenantContext } = await import('@pipeline-builder/pipeline-data');
const actions = await import('../src/services/plugin-name-actions.js');
const { pluginService } = await import('../src/services/plugin-service.js');
const { pluginSourceKey, pluginSourceVersionPrefix } = await import('@pipeline-builder/api-core');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ROOT = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const SOURCES = 'plugin-sources';
const quotaService = {} as never;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const digestOf = (s: string) => `sha256:${sha(s)}`;

const caller = (over: Partial<Parameters<typeof actions.deleteByName>[1]> = {}) => ({
  orgId: ORG, userId: 'u-1', parentOrgId: null, checkWrite: () => 'ok' as const, logWarn: jest.fn(), ...over,
});
const asOrg = <T>(orgId: string, fn: () => Promise<T>) => runWithTenantContext({ orgId, isSuperAdmin: false }, fn);

/** A version with a kept source object and an image digest. */
async function seed(version: string, opts: { orgId?: string; isDefault?: boolean; frozen?: boolean; digest?: string; quota?: boolean } = {}): Promise<string> {
  const orgId = opts.orgId ?? ORG;
  const r = await owner((q) => q.query<{ id: string }>(
    `INSERT INTO plugins (org_id, name, version, created_by, updated_by, visibility, is_default, image_digest, frozen_at, quota_reset_at)
     VALUES ($1, 'lint', $2, 'u-1', 'u-1', 'org', $3, $4, $5, $6) RETURNING id`,
    [orgId, version, opts.isDefault ?? false, opts.digest ?? digestOf(version), opts.frozen ? new Date() : null, opts.quota ? new Date('2026-11-01T00:00:00Z') : null]));
  const id = r.rows[0]!.id;
  const key = pluginSourceKey(orgId, id, version, sha(version));
  s3.put(SOURCES, key, version);
  s3.put(SOURCES, `${pluginSourceVersionPrefix(orgId, id, version)}remediations/r/remediation.diff`, 'diff');
  await owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = $2, source_sha256 = $3, source_size_bytes = $4, source_kept_at = now() WHERE id = $1",
    [id, key, sha(version), version.length]));
  return id;
}
const rowsOf = (orgId = ORG) => owner((q) => q.query<{ id: string; version: string; deleted_at: Date | null; delete_batch_id: string | null; is_default: boolean }>(
  "SELECT id, version, deleted_at, delete_batch_id, is_default FROM plugins WHERE org_id = $1 AND name = 'lint' ORDER BY version", [orgId])).then((r) => r.rows);
const audits = (action: string) => mockRecordAudit.mock.calls.map((c) => c[0] as { action: string; details: Record<string, unknown>; targetId?: string }).filter((a) => a.action === action);

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  s3.reset();
  s3.buckets.set(SOURCES, new Map());
  locked.clear();
  lockEvents.length = 0;
  quotaDenied = false;
  await owner((q) => q.exec('DELETE FROM plugin_source_orphans; DELETE FROM plugin_remediations; DELETE FROM plugin_listing_versions; DELETE FROM plugin_listings; DELETE FROM plugins;'));
});

describe('Delete plugin — preview and delete', () => {
  it('soft-deletes every eligible version with ONE batch id, and skips frozen, in-use and listed ones with reasons', async () => {
    const a = await seed('1.0.0');
    const b = await seed('1.1.0', { isDefault: true, quota: true });
    const frozen = await seed('1.2.0', { frozen: true });
    const inUse = await seed('1.3.0');
    const listed = await seed('1.4.0');
    await owner((q) => q.query("INSERT INTO plugin_listings (id, publisher_id, name) SELECT '00000000-0000-4000-8000-0000000000aa', id, 'lint' FROM publishers WHERE handle = 'pipeline-builder'"));
    await owner((q) => q.query("INSERT INTO plugin_listing_versions (listing_id, version, source_plugin_id, published_by) VALUES ('00000000-0000-4000-8000-0000000000aa', '1.4.0', $1, 'u-1')", [listed]));
    const realBlockers = pluginService.deleteBlockers.bind(pluginService);
    jest.spyOn(pluginService, 'deleteBlockers').mockImplementation(async (row, orgId) => (row.id === inUse ? { frozen: false, listed: false, inUse: 1 } : realBlockers(row, orgId)));
    jest.spyOn(pluginService, 'versionReferences').mockImplementation(async (row) => (row.version === '1.3.0'
      ? [{ pipelineId: 'pl-1', pipelineName: 'nightly', orgId: ORG, steps: ['lint'], sources: ['declared'], pipelineDeleted: false }] as never
      : [] as never));
    jest.spyOn(pluginService, 'findOrgsUsingVersion').mockImplementation(async (row) => (row.version === '1.0.0' ? [ORG, 'cccccccccccccccccccccccc'] : [ORG]));

    const preview = await asOrg(ORG, () => actions.previewDeleteByName('lint', caller(), { force: false }));
    expect(preview).toMatchObject({
      name: 'lint',
      inheritedFromRoot: false,
      listing: { id: '00000000-0000-4000-8000-0000000000aa', publisher: 'pipeline-builder' },
      inFlight: { builds: 2, remediations: 1 },
    });
    expect(preview.deletable.map((d) => d.version).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(preview.deletable.find((d) => d.version === '1.0.0')!.sourceBytes).toBe(5);
    expect(preview.skipped).toEqual(expect.arrayContaining([
      { id: frozen, version: '1.2.0', reason: 'frozen' },
      { id: inUse, version: '1.3.0', reason: 'in_use', pipelines: [{ id: 'pl-1', name: 'nightly' }] },
      { id: listed, version: '1.4.0', reason: 'listed' },
    ]));

    const result = await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }));
    // The same answer the preview gave.
    expect(result.deleted.map((d) => d.id).sort()).toEqual([a, b].sort());
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(['frozen', 'in_use', 'listed']);
    const rows = await rowsOf();
    for (const r of rows.filter((x) => [a, b].includes(x.id))) {
      expect(r.deleted_at).not.toBeNull();
      expect(r.delete_batch_id).toBe(result.batchId);
    }
    for (const r of rows.filter((x) => ![a, b].includes(x.id))) expect(r.deleted_at).toBeNull();
    // Sources stay for the restore window.
    expect(s3.keys(SOURCES).filter((k) => k.includes(a))).toHaveLength(2);

    // Linked audit: one delete-all naming every version, each plugin.delete carrying the batch.
    const all = audits('plugin.delete-all');
    expect(all).toHaveLength(1);
    expect(all[0]!.details).toMatchObject({ batchId: result.batchId, pluginName: 'lint' });
    expect((all[0]!.details.done as unknown[])).toHaveLength(2);
    expect((all[0]!.details.skipped as unknown[])).toHaveLength(3);
    expect(audits('plugin.delete').map((x) => x.details.batchId)).toEqual([result.batchId, result.batchId]);
    // Quota: the charged version's slot is refunded.
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    // ONE N14 per org that used any of them.
    expect(mockNotifyWithdrawal).toHaveBeenCalledTimes(1);
    expect(mockNotifyWithdrawal.mock.calls[0]![0]).toMatchObject({ kind: 'deleted', orgIds: expect.arrayContaining([ORG, 'cccccccccccccccccccccccc']) });
    expect((mockNotifyWithdrawal.mock.calls[0]![0] as { orgIds: string[] }).orgIds).toHaveLength(2);
  });

  it('cancels queued builds and remediations and waits for running ones, all under the name lock, before deleting', async () => {
    const a = await seed('1.0.0');
    const del = jest.spyOn(pluginService, 'deleteVersion');
    del.mockImplementation(async (...args) => { lockEvents.push('deleteVersion'); return (pluginService.constructor.prototype.deleteVersion as AnyFn).apply(pluginService, args); });
    await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }));
    expect(lockEvents).toEqual(['lock:lint', 'cancelQueued', 'cancelRemediations', 'waitForRunning', 'deleteVersion', 'unlock:lint']);
    expect(mockCancelRemediationsFor).toHaveBeenCalledWith({ orgId: ORG, pluginIds: [a], reason: 'name_deleted' });
    expect(audits('plugin.delete-all')[0]!.details).toMatchObject({ cancelledBuilds: 1, cancelledRemediations: 1 });
  });

  it('a name already locked by another by-name action is refused before anything is touched', async () => {
    await seed('1.0.0');
    locked.add(`${ORG}:lint`);
    await expect(asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }))).rejects.toMatchObject({ code: 'PLUGIN_NAME_LOCKED' });
    expect(mockCancelQueued).not.toHaveBeenCalled();
    expect((await rowsOf())[0]!.deleted_at).toBeNull();
  });

  it('force also deletes a listed source version', async () => {
    const listed = await seed('1.4.0');
    await owner((q) => q.query("INSERT INTO plugin_listings (id, publisher_id, name) SELECT '00000000-0000-4000-8000-0000000000ab', id, 'lint' FROM publishers WHERE handle = 'pipeline-builder'"));
    await owner((q) => q.query("INSERT INTO plugin_listing_versions (listing_id, version, source_plugin_id, published_by) VALUES ('00000000-0000-4000-8000-0000000000ab', '1.4.0', $1, 'u-1')", [listed]));
    const result = await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: true, quotaService }));
    expect(result.deleted).toEqual([{ id: listed, version: '1.4.0' }]);
  });

  it('a managed toolchain name is refused before anything is touched', async () => {
    await expect(actions.deleteByName('pipeline-bootstrap', caller(), { force: false, quotaService })).rejects.toMatchObject({ code: 'PLUGIN_MANAGED_NAME_RESERVED', statusCode: 403 });
    expect(lockEvents).toEqual([]);
    expect(mockCancelQueued).not.toHaveBeenCalled();
  });

  it('a version the caller may not delete refuses the whole delete (403), touching nothing', async () => {
    const a = await seed('1.0.0');
    await seed('1.1.0');
    const checkWrite = (row: { id: string }) => (row.id === a ? 'not-author' as const : 'ok' as const);
    await expect(asOrg(ORG, () => actions.deleteByName('lint', caller({ checkWrite }), { force: false, quotaService }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await rowsOf()).every((r) => r.deleted_at === null)).toBe(true);
    expect(mockCancelQueued).not.toHaveBeenCalled();
  });

  it('a team sees a root-org name but has nothing to delete', async () => {
    await seed('1.0.0', { orgId: ROOT });
    const team = caller({ parentOrgId: ROOT });
    const preview = await asOrg(ORG, () => actions.previewDeleteByName('lint', team, { force: false }));
    expect(preview).toMatchObject({ inheritedFromRoot: true, deletable: [], skipped: [] });
    await expect(asOrg(ORG, () => actions.deleteByName('lint', team, { force: false, quotaService }))).rejects.toMatchObject({ statusCode: 404, details: { inheritedFromRoot: true } });
    expect((await rowsOf(ROOT))[0]!.deleted_at).toBeNull();
  });
});

describe('Restore plugin / Purge plugin — the batch only', () => {
  async function deleteAll(): Promise<string> {
    return (await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }))).batchId;
  }

  it('restore brings back exactly the batch, with sources intact, never a version deleted on its own', async () => {
    const own = await seed('0.9.0');
    await asOrg(ORG, async () => pluginService.deleteVersion((await pluginService.findById(own, ORG))!, ORG, 'u-1', { force: false }));
    const a = await seed('1.0.0');
    const b = await seed('1.1.0');
    const batchId = await deleteAll();

    const result = await asOrg(ORG, () => actions.restoreByName('lint', batchId, caller(), { quotaService }));
    expect(result.done.map((d) => d.id).sort()).toEqual([a, b].sort());
    const rows = await rowsOf();
    expect(rows.find((r) => r.id === own)!.deleted_at).not.toBeNull();
    for (const id of [a, b]) {
      const r = rows.find((x) => x.id === id)!;
      expect(r.deleted_at).toBeNull();
      expect(r.delete_batch_id).toBeNull();
    }
    expect(s3.get(SOURCES, pluginSourceKey(ORG, a, '1.0.0', sha('1.0.0')))?.body.toString()).toBe('1.0.0');
    expect(audits('plugin.restore-all')[0]!.details).toMatchObject({ batchId });
    expect(audits('plugin.restore').every((x) => x.details.batchId === batchId)).toBe(true);
  });

  it('restore over the plugins cap skips the version, and an unknown batch is a 404', async () => {
    await seed('1.0.0');
    const batchId = await deleteAll();
    quotaDenied = true;
    const result = await asOrg(ORG, () => actions.restoreByName('lint', batchId, caller(), { quotaService }));
    expect(result).toMatchObject({ done: [], skipped: [{ reason: 'quota_exceeded' }] });
    await expect(asOrg(ORG, () => actions.restoreByName('lint', '00000000-0000-4000-8000-000000000000', caller(), { quotaService }))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('purge removes each version\'s row, remediation rows, RustFS prefix and image; a shared digest keeps the image', async () => {
    const shared = digestOf('same-image');
    const a = await seed('1.0.0', { digest: shared });
    const b = await seed('1.1.0', { digest: shared });
    const keep = await seed('2.0.0');
    await owner((q) => q.query('UPDATE plugins SET frozen_at = now() WHERE id = $1', [keep]));
    await owner((q) => q.query(`INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, created_by)
      VALUES ($1, $2, 'lint', '1.0.0', $3, 'failed', 'system:plugin-remediation')`, [ORG, a, sha('f')]));
    const batchId = await deleteAll();

    const result = await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }));
    expect(result.done.map((d) => d.id).sort()).toEqual([a, b].sort());
    expect((await rowsOf()).map((r) => r.id)).toEqual([keep]);
    expect((await owner((q) => q.query('SELECT 1 FROM plugin_remediations'))).rows).toHaveLength(0);
    // Prefix deletes leave nothing of the purged versions (the unversioned bucket keeps no object versions).
    expect(s3.keys(SOURCES).every((k) => k.includes(keep))).toBe(true);
    // The two purged versions shared one digest: removed once, after the LAST of them went.
    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(mockDiscard.mock.calls[0]![0]).toMatchObject({ repository: `registry:5000/org-${ORG}/lint`, digest: shared, orgId: ORG });
    expect(audits('plugin.purge-all')[0]!.details).toMatchObject({ batchId });
    expect(audits('plugin.purge').map((x) => x.details.batchId)).toEqual([batchId, batchId]);
  });

  it('a version that still shares its digest with a stored version keeps the image', async () => {
    const shared = digestOf('same');
    await seed('1.0.0', { digest: shared });
    const live = await seed('1.1.0', { digest: shared, frozen: true });
    const batchId = await deleteAll();
    await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }));
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_purge_image_discards_total', { outcome: 'kept_shared' });
    expect((await rowsOf()).map((r) => r.id)).toEqual([live]);
  });

  it('failed RustFS and image deletes never block the purge: both land in plugin_source_orphans', async () => {
    const a = await seed('1.0.0');
    const batchId = await deleteAll();
    s3.undeletable.add(pluginSourceKey(ORG, a, '1.0.0', sha('1.0.0')));
    mockDiscard.mockRejectedValueOnce(Object.assign(new Error('registry down'), { name: 'RegistryUnavailable' }));
    const result = await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }));
    expect(result.done).toHaveLength(1);
    const orphans = (await owner((q) => q.query<{ kind: string; target: string; bucket: string }>('SELECT kind, bucket, target FROM plugin_source_orphans ORDER BY kind'))).rows;
    expect(orphans).toEqual([
      { kind: 'image', bucket: `org-${ORG}/lint`, target: digestOf('1.0.0') },
      { kind: 'prefix', bucket: SOURCES, target: pluginSourceVersionPrefix(ORG, a, '1.0.0') },
    ]);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_delete_failures_total', { kind: 'prefix' });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_delete_failures_total', { kind: 'image' });

    // The purge sweep's retry clears both.
    s3.undeletable.clear();
    const { retryPurgeOrphans } = await import('../src/services/version-purge.js');
    expect(await retryPurgeOrphans()).toEqual({ tried: 2, cleared: 2, failed: 0 });
    // The retry discards what the first attempt did, with the same audit
    // context: which version went, and whose purge it was.
    const [first, retry] = mockDiscard.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(first).toMatchObject({ context: { pluginVersion: '1.0.0', reason: 'purged', userId: 'u-1' } });
    expect(retry).toEqual(first);
    expect(s3.keys(SOURCES)).toEqual([]);
  });

  it('purge acts on its batch only', async () => {
    const own = await seed('0.9.0');
    await asOrg(ORG, async () => pluginService.deleteVersion((await pluginService.findById(own, ORG))!, ORG, 'u-1', { force: false }));
    await seed('1.0.0');
    const batchId = await deleteAll();
    await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }));
    expect((await rowsOf()).map((r) => r.id)).toEqual([own]);
  });
});

describe('the soft-delete purge sweep (automatic) vs an owner\'s purge (explicit)', () => {
  const expire = (id: string) => owner((q) => q.query("UPDATE plugins SET deleted_at = now() - interval '40 days', purge_after = now() - interval '10 days', is_active = false WHERE id = $1", [id]));
  const sweep = () => runWithTenantContext({ isSuperAdmin: true }, () => pluginService.purgeExpired(new Date(), 500));

  it('purges an expired tombstone that has a live sibling, with its kept source and image', async () => {
    const old = await seed('1.0.0');
    await seed('1.1.0');
    await expire(old);
    expect(await sweep()).toBe(1);
    expect((await rowsOf()).map((r) => r.version)).toEqual(['1.1.0']);
    expect(s3.keys(SOURCES).some((k) => k.includes(old))).toBe(false);
    expect(mockDiscard).toHaveBeenCalledWith(expect.objectContaining({ digest: digestOf('1.0.0') }));
  });

  it('purges a plugin whose EVERY version was soft-deleted (Delete plugin) once its window passed: rows, kept sources and images', async () => {
    const a = await seed('1.0.0');
    const b = await seed('1.1.0', { isDefault: true });
    const res = await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }));
    expect(res.deleted.map((d) => d.version).sort()).toEqual(['1.0.0', '1.1.0']);
    // Inside the window nothing is purged.
    expect(await sweep()).toBe(0);
    expect(await rowsOf()).toHaveLength(2);
    await expire(a);
    await expire(b);
    expect(await sweep()).toBe(2);
    expect(await rowsOf()).toEqual([]);
    expect(s3.keys(SOURCES)).toEqual([]);
    expect(mockDiscard).toHaveBeenCalledTimes(2);
    expect(mockIncCounter).not.toHaveBeenCalledWith('plugin_auto_removal_skipped_total', expect.anything(), expect.anything());
  });

  it('a soft-deleted single-version plugin is purged after its window too, with its kept source', async () => {
    const only = await seed('1.0.0');
    await expire(only);
    expect(await sweep()).toBe(1);
    expect(await rowsOf()).toEqual([]);
    expect(s3.keys(SOURCES).filter((k) => k.includes(only))).toHaveLength(0);
    expect(mockDiscard).toHaveBeenCalledTimes(1);
  });

  it('an owner\'s explicit purge of the only version still works, and removes its source and image', async () => {
    const only = await seed('1.0.0');
    await expire(only);
    expect(await asOrg(ORG, () => pluginService.purgeById(only, ORG))).toBe(only);
    expect(await rowsOf()).toEqual([]);
    expect(s3.keys(SOURCES)).toEqual([]);
    expect(mockDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('races and refusals inside a batch', () => {
  it('a version that became frozen, listed or in use between the plan and its delete is skipped with that reason', async () => {
    const [a, b, c] = [await seed('1.0.0'), await seed('1.1.0'), await seed('1.2.0')];
    const { AppError, ErrorCode } = await import('@pipeline-builder/api-core');
    jest.spyOn(pluginService, 'deleteVersion').mockImplementation(async (row) => {
      if (row.id === a) throw new AppError(409, ErrorCode.PLUGIN_VERSION_FROZEN, 'frozen');
      if (row.id === b) throw new AppError(409, ErrorCode.PLUGIN_VERSION_IN_USE, 'listed', { reason: 'listed' });
      throw new AppError(409, ErrorCode.PLUGIN_VERSION_IN_USE, 'in use', { reason: 'in_use' });
    });
    const result = await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }));
    expect(Object.fromEntries(result.skipped.map((s) => [s.id, s.reason]))).toEqual({ [a]: 'frozen', [b]: 'listed', [c]: 'in_use' });
    expect(mockNotifyWithdrawal).not.toHaveBeenCalled();
  });

  it('any other delete error propagates; a remediation cancel that fails and an unreadable using-org list do not stop the delete', async () => {
    await seed('1.0.0');
    mockCancelRemediationsFor.mockRejectedValueOnce(new Error('pipeline down'));
    jest.spyOn(pluginService, 'findOrgsUsingVersion').mockRejectedValueOnce(new Error('db'));
    const c = caller();
    const result = await asOrg(ORG, () => actions.deleteByName('lint', c, { force: false, quotaService }));
    expect(result.deleted).toHaveLength(1);
    expect(c.logWarn).toHaveBeenCalledTimes(2);

    await seed('2.0.0');
    jest.spyOn(pluginService, 'deleteVersion').mockRejectedValueOnce(new Error('boom'));
    await expect(asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }))).rejects.toThrow('boom');
  });

  it('restore and purge skip a version the caller may not touch, and purge skips one a pipeline references', async () => {
    const a = await seed('1.0.0');
    const b = await seed('1.1.0');
    const batchId = (await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }))).batchId;
    const notA = caller({ checkWrite: (row: { id: string }) => (row.id === a ? 'needs-publish' as const : 'ok' as const) });
    const restored = await asOrg(ORG, () => actions.restoreByName('lint', batchId, notA, { quotaService }));
    expect(restored.skipped).toEqual([{ id: a, version: '1.0.0', reason: 'needs-publish' }]);
    // b is live again; delete it back into a fresh batch with a.
    await asOrg(ORG, async () => pluginService.deleteVersion((await pluginService.findById(b, ORG))!, ORG, 'u-1', { force: false }));

    const { AppError, ErrorCode } = await import('@pipeline-builder/api-core');
    jest.spyOn(pluginService, 'purgeById').mockRejectedValueOnce(new AppError(409, ErrorCode.PLUGIN_VERSION_IN_USE, 'in use'));
    const purged = await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }));
    expect(purged.skipped).toEqual([{ id: a, version: '1.0.0', reason: 'in_use' }]);
    jest.spyOn(pluginService, 'purgeById').mockResolvedValueOnce(null);
    expect((await asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }))).skipped[0]!.reason).toBe('not_purgeable');
    expect((await asOrg(ORG, () => actions.purgeByName('lint', batchId, notA, { quotaService }))).skipped[0]!.reason).toBe('needs-publish');
    jest.spyOn(pluginService, 'purgeById').mockRejectedValueOnce(new Error('db'));
    await expect(asOrg(ORG, () => actions.purgeByName('lint', batchId, caller(), { quotaService }))).rejects.toThrow('db');
    await expect(asOrg(ORG, () => actions.purgeByName('lint', '00000000-0000-4000-8000-000000000000', caller(), { quotaService }))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a restore whose tombstone vanished meanwhile is skipped as not_restorable', async () => {
    await seed('1.0.0');
    const batchId = (await asOrg(ORG, () => actions.deleteByName('lint', caller(), { force: false, quotaService }))).batchId;
    jest.spyOn(pluginService, 'restore').mockResolvedValueOnce(null);
    expect((await asOrg(ORG, () => actions.restoreByName('lint', batchId, caller(), { quotaService }))).skipped[0]!.reason).toBe('not_restorable');
  });

  it('the preview counts live remediation records as in flight, and a name nobody has is a 404 to delete', async () => {
    const a = await seed('1.0.0');
    await owner((q) => q.query(`INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, created_by)
      VALUES ($1, $2, 'lint', '1.0.0', $3, 'rebuild', 'x'), ($1, $2, 'lint', '1.0.0', $4, 'done', 'x')`, [ORG, a, sha('1'), sha('2')]));
    mockCountInFlight.mockResolvedValueOnce({ builds: 0, remediations: 0 });
    const preview = await asOrg(ORG, () => actions.previewDeleteByName('lint', caller(), { force: false }));
    expect(preview.inFlight.remediations).toBe(1);
    expect(preview.listing).toBeNull();
    await expect(asOrg(ORG, () => actions.deleteByName('nothing', caller(), { force: false, quotaService }))).rejects.toMatchObject({ statusCode: 404, details: { inheritedFromRoot: false } });
  });
});

describe('version-purge edges', () => {
  it('an image-less version discards nothing; an image orphan whose digest is stored again is cleared without a discard', async () => {
    const { discardPurgedImage, retryPurgeOrphans } = await import('../src/services/version-purge.js');
    expect(await discardPurgedImage({ id: 'x', orgId: ORG, name: 'lint', version: '1', imageDigest: null })).toBe('none');
    await seed('1.0.0', { digest: digestOf('again') });
    await owner((q) => q.query("INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, 'image', $2, $3, 'E')", [ORG, `org-${ORG}/lint`, digestOf('again')]));
    expect(await retryPurgeOrphans()).toEqual({ tried: 1, cleared: 1, failed: 0 });
    expect(mockDiscard).not.toHaveBeenCalled();
  });
});
