// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Kept plugin sources (services/plugin-sources.ts) against an in-memory RustFS
 * (test/helpers/fake-s3.ts) and a REAL Postgres (PGlite, the shipped init
 * script, as the app role under RLS): the copy into
 * `plugin-sources/<orgId>/<pluginId>/<version>/<sha256>.zip` with the right
 * SHA-256, the pointer columns, the checksum check that fails closed, the
 * missing-source fallback, prefix deletes that leave nothing behind, and failed
 * deletes landing in plugin_source_orphans for the sweep to retry.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { createFakeS3Store, fakeS3Module } from './helpers/fake-s3.js';

const store = createFakeS3Store();
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@aws-sdk/client-s3', () => fakeS3Module(store));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter }));

const src = await import('../src/services/plugin-sources.js');
const { pluginSourceKey, pluginSourceVersionPrefix } = await import('@pipeline-builder/api-core');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const SOURCES = 'plugin-sources';
const STAGING = 'plugins';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);

async function seedPlugin(orgId = ORG, name = 'lint', version = '1.0.0'): Promise<string> {
  const r = await owner((q) => q.query<{ id: string }>(
    "INSERT INTO plugins (org_id, name, version, created_by, updated_by, visibility) VALUES ($1, $2, $3, 'u-1', 'u-1', 'org') RETURNING id",
    [orgId, name, version]));
  return r.rows[0]!.id;
}
const sourceRow = (id: string) => owner((q) => q.query<Record<string, unknown>>(
  'SELECT source_key, source_sha256, source_size_bytes, source_kind, source_kept_at FROM plugins WHERE id = $1', [id])).then((r) => r.rows[0]!);
const orphans = () => owner((q) => q.query<Record<string, unknown>>('SELECT org_id, kind, bucket, target, plugin_id, plugin_version, last_error, attempts FROM plugin_source_orphans ORDER BY target')).then((r) => r.rows);

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => {
  store.reset();
  store.buckets.set(SOURCES, new Map());
  store.buckets.set(STAGING, new Map());
  mockIncCounter.mockClear();
  await owner((q) => q.exec('DELETE FROM plugin_source_orphans; DELETE FROM plugins;'));
});

describe('keepVersionSource — the build tail copies the ZIP before the staging object goes', () => {
  it('copies the staged ZIP to <org>/<plugin>/<version>/<sha256>.zip and records the pointer', async () => {
    const id = await seedPlugin();
    store.put(STAGING, `${ORG}/req-1.zip`, 'PK-zip-bytes');

    const kept = await src.keepVersionSource({ orgId: ORG, pluginId: id, version: '1.0.0', stagingKey: `${ORG}/req-1.zip` });

    const key = pluginSourceKey(ORG, id, '1.0.0', sha('PK-zip-bytes'));
    expect(key).toBe(`${ORG}/${id}/1.0.0/${sha('PK-zip-bytes')}.zip`);
    expect(kept).toEqual({ key, sha256: sha('PK-zip-bytes'), sizeBytes: 12 });
    expect(store.get(SOURCES, key)?.body.toString()).toBe('PK-zip-bytes');
    // Server-side copy, pinned to the ETag of the bytes that were hashed.
    const copy = store.sent.find((c) => c.type === 'Copy')!;
    expect(copy.input).toMatchObject({ Bucket: SOURCES, Key: key, CopySource: `${STAGING}/${ORG}/req-1.zip`, CopySourceIfMatch: store.get(STAGING, `${ORG}/req-1.zip`)!.etag });
    expect(await sourceRow(id)).toMatchObject({ source_key: key, source_sha256: sha('PK-zip-bytes'), source_kind: 'zip', source_kept_at: expect.any(Date) });
    expect(Number((await sourceRow(id)).source_size_bytes)).toBe(12);
  });

  it('a prebuilt / metadata-only version (no staging key) is source-less', async () => {
    const id = await seedPlugin();
    expect(await src.keepVersionSource({ orgId: ORG, pluginId: id, version: '1.0.0', stagingKey: null })).toBeNull();
    expect(await sourceRow(id)).toEqual({ source_key: null, source_sha256: null, source_size_bytes: null, source_kind: 'none', source_kept_at: null });
    expect(store.keys(SOURCES)).toEqual([]);
  });

  it('a copy that fails stores the version source-less and alerts (the build stands)', async () => {
    const id = await seedPlugin();
    store.put(STAGING, `${ORG}/req-2.zip`, 'zip');
    store.failNext.set('Copy', Object.assign(new Error('boom'), { name: 'InternalError' }));
    expect(await src.keepVersionSource({ orgId: ORG, pluginId: id, version: '1.0.0', stagingKey: `${ORG}/req-2.zip` })).toBeNull();
    expect((await sourceRow(id)).source_kind).toBe('none');
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_missing_total', { reason: 'keep_failed' });
  });

  it('a re-upload of the version under new content points at the new ZIP and never deletes the old one (only a purge does)', async () => {
    const id = await seedPlugin();
    store.put(STAGING, 'a.zip', 'first');
    store.put(STAGING, 'b.zip', 'second');
    const first = await src.keepVersionSource({ orgId: ORG, pluginId: id, version: '1.0.0', stagingKey: 'a.zip' });
    const second = await src.keepVersionSource({ orgId: ORG, pluginId: id, version: '1.0.0', stagingKey: 'b.zip' });
    expect((await sourceRow(id)).source_key).toBe(second!.key);
    expect(store.keys(SOURCES)).toEqual([first!.key, second!.key].sort());
    expect(store.sent.some((c) => c.type === 'Delete' || c.type === 'DeleteObjects')).toBe(false);
  });
});

describe('fetchPluginSource — the checksum check before any rebuild', () => {
  const key = (id: string, body: string) => pluginSourceKey(ORG, id, '1.0.0', sha(body));

  it('downloads a source whose SHA-256 matches', async () => {
    const id = await seedPlugin();
    store.put(SOURCES, key(id, 'good'), 'good');
    const dest = join(mkdtempSync(join(tmpdir(), 'src-')), 'ctx.zip');
    await expect(src.fetchPluginSource({ id, sourceKey: key(id, 'good'), sourceSha256: sha('good'), sourceKind: 'zip' }, dest)).resolves.toBe('ok');
    expect(readFileSync(dest, 'utf8')).toBe('good');
  });

  it('a mismatch FAILS CLOSED: throws, removes the file, alerts', async () => {
    const id = await seedPlugin();
    store.put(SOURCES, key(id, 'good'), 'tampered');
    const dest = join(mkdtempSync(join(tmpdir(), 'src-')), 'ctx.zip');
    const err = await src.fetchPluginSource({ id, sourceKey: key(id, 'good'), sourceSha256: sha('good'), sourceKind: 'zip' }, dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(src.PluginSourceChecksumError);
    expect((err as InstanceType<typeof src.PluginSourceChecksumError>).code).toBe('SOURCE_CHECKSUM_MISMATCH');
    expect(existsSync(dest)).toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_checksum_mismatch_total', {});
  });

  it('a source missing after a restore makes the version source-less (overlay-only) and alerts', async () => {
    const id = await seedPlugin();
    await owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = $2, source_sha256 = $3, source_size_bytes = 4, source_kept_at = now() WHERE id = $1", [id, key(id, 'gone'), sha('gone')]));
    const dest = join(mkdtempSync(join(tmpdir(), 'src-')), 'ctx.zip');
    await expect(src.fetchPluginSource({ id, sourceKey: key(id, 'gone'), sourceSha256: sha('gone'), sourceKind: 'zip' }, dest)).resolves.toBe('missing');
    expect(await sourceRow(id)).toMatchObject({ source_kind: 'none', source_key: null, source_sha256: null, source_size_bytes: null });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_missing_total', { reason: 'missing' });
  });

  it('a source-less version is simply missing (nothing alerts)', async () => {
    await expect(src.fetchPluginSource({ sourceKey: null, sourceSha256: null, sourceKind: 'none' }, '/nonexistent')).resolves.toBe('missing');
    expect(mockIncCounter).not.toHaveBeenCalled();
  });

  it('any other storage error propagates (retryable, never "missing")', async () => {
    store.failNext.set('Get', Object.assign(new Error('slow down'), { name: 'SlowDown' }));
    await expect(src.fetchPluginSource({ sourceKey: 'k', sourceSha256: sha('x'), sourceKind: 'zip' }, '/nonexistent')).rejects.toThrow('slow down');
  });
});

describe('deleting kept sources', () => {
  it('a version purge deletes its whole prefix (ZIPs, diffs, exports) and nothing else', async () => {
    const prefix = pluginSourceVersionPrefix(ORG, 'p-1', '1.0.0');
    for (const k of ['abc.zip', 'remediations/r1/patched-def.zip', 'remediations/r1/remediation.diff', 'remediations/r1/export.diff']) store.put(SOURCES, `${prefix}${k}`, 'x');
    store.put(SOURCES, pluginSourceVersionPrefix(ORG, 'p-1', '1.0.1') + 'keep.zip', 'x');
    await src.deletePluginSourcePrefix({ orgId: ORG, pluginId: 'p-1', version: '1.0.0', prefix });
    expect(store.keys(SOURCES)).toEqual([`${ORG}/p-1/1.0.1/keep.zip`]);
    expect(await orphans()).toEqual([]);
  });

  it('pages through a large prefix', async () => {
    const prefix = pluginSourceVersionPrefix(ORG, 'p-1', '1.0.0');
    for (let i = 0; i < 2500; i++) store.put(SOURCES, `${prefix}${i}.diff`, 'x');
    await src.deletePluginSourcePrefix({ orgId: ORG, prefix });
    expect(store.keys(SOURCES)).toEqual([]);
  });

  it('a failed delete never throws: it lands in plugin_source_orphans and counts', async () => {
    const id = await seedPlugin();
    const prefix = pluginSourceVersionPrefix(ORG, id, '1.0.0');
    store.put(SOURCES, `${prefix}a.zip`, 'x');
    store.undeletable.add(`${prefix}a.zip`);
    await expect(src.deletePluginSourcePrefix({ orgId: ORG, pluginId: id, version: '1.0.0', prefix })).resolves.toBeUndefined();
    expect(await orphans()).toEqual([{ org_id: ORG, kind: 'prefix', bucket: SOURCES, target: prefix, plugin_id: id, plugin_version: '1.0.0', last_error: 'AccessDenied', attempts: 1 }]);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_delete_failures_total', { kind: 'prefix' });

    // A second failure upserts the same row.
    await src.deletePluginSourcePrefix({ orgId: ORG, pluginId: id, version: '1.0.0', prefix });
    expect((await orphans())[0]!.attempts).toBe(2);
  });

  it('the purge sweep retries an orphan: a success clears it, a failure counts again', async () => {
    const prefix = pluginSourceVersionPrefix(ORG, 'p-9', '2.0.0');
    store.put(SOURCES, `${prefix}a.zip`, 'x');
    store.failNext.set('List', Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    await src.deletePluginSourcePrefix({ orgId: ORG, prefix });
    expect(await orphans()).toHaveLength(1);

    store.failNext.set('List', Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    expect(await src.retryPluginSourceOrphans()).toEqual({ tried: 1, cleared: 0, failed: 1 });
    expect((await orphans())[0]!.attempts).toBe(2);

    expect(await src.retryPluginSourceOrphans()).toEqual({ tried: 1, cleared: 1, failed: 0 });
    expect(await orphans()).toEqual([]);
    // Unversioned bucket: nothing is left behind.
    expect(store.keys(SOURCES)).toEqual([]);
  });

  it('the orphan sweep NEVER deletes a kept source a live version still points to (and forgets that orphan)', async () => {
    const id = await seedPlugin();
    const prefix = pluginSourceVersionPrefix(ORG, id, '1.0.0');
    const key = `${prefix}${sha('z')}.zip`;
    store.put(SOURCES, key, 'z');
    await owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = $2, source_sha256 = $3, source_size_bytes = 1, source_kept_at = now() WHERE id = $1", [id, key, sha('z')]));
    await owner((q) => q.query(`INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error)
      VALUES ($1, 'prefix', $2, $3, 'E'), ($1, 'object', $2, $4, 'E')`, [ORG, SOURCES, prefix, key]));
    expect(await src.retryPluginSourceOrphans()).toEqual({ tried: 0, cleared: 0, failed: 0 });
    expect(store.get(SOURCES, key)).toBeDefined();
    expect(await orphans()).toEqual([]);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_auto_removal_skipped_total', { reason: 'active' }, 1);

    // Once the version is a tombstone again, a recorded orphan is retried as usual.
    await owner((q) => q.query('UPDATE plugins SET deleted_at = now(), is_active = false WHERE id = $1', [id]));
    await owner((q) => q.query("INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, 'prefix', $2, $3, 'E')", [ORG, SOURCES, prefix]));
    expect(await src.retryPluginSourceOrphans()).toEqual({ tried: 1, cleared: 1, failed: 0 });
    expect(store.get(SOURCES, key)).toBeUndefined();
  });

  it('image orphans wait for a caller that can discard images', async () => {
    await owner((q) => q.query("INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, 'image', 'org-x/lint', 'sha256:1', 'E')", [ORG]));
    expect(await src.retryPluginSourceOrphans()).toEqual({ tried: 0, cleared: 0, failed: 0 });
    const retryImage = jest.fn(async (_o: unknown) => undefined);
    expect(await src.retryPluginSourceOrphans({ retryImage })).toEqual({ tried: 1, cleared: 1, failed: 0 });
    expect(retryImage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', target: 'sha256:1' }));
  });

  it('the org purge removes plugin-sources/<orgId>/ only, and THROWS when it cannot', async () => {
    store.put(SOURCES, `${ORG}/p/1.0.0/a.zip`, 'x');
    store.put(SOURCES, `${ORG}/q/2.0.0/remediations/r/remediation.diff`, 'x');
    store.put(SOURCES, `${OTHER}/p/1.0.0/a.zip`, 'x');
    await expect(src.deleteOrgSources(ORG)).resolves.toBe(2);
    expect(store.keys(SOURCES)).toEqual([`${OTHER}/p/1.0.0/a.zip`]);

    store.undeletable.add(`${OTHER}/p/1.0.0/a.zip`);
    await expect(src.deleteOrgSources(OTHER)).rejects.toThrow(/not deleted/);
  });

  it('refuses a prefix that is not a directory (never a bucket-wide delete)', async () => {
    await src.deletePluginSourcePrefix({ orgId: ORG, prefix: '' });
    expect(store.sent.filter((c) => c.type === 'List')).toHaveLength(0);
    expect(await orphans()).toHaveLength(1);
  });
});

describe('listing copies, remediation artifacts and storage accounting', () => {
  it('a listed version gets its own copy under listings/<listingId>/<version>/', async () => {
    store.put(SOURCES, `${ORG}/p/1.0.0/${sha('z')}.zip`, 'z');
    const cols = await src.keepListingSource({ listingId: 'l-1', version: '1.0.0', from: { sourceKey: `${ORG}/p/1.0.0/${sha('z')}.zip`, sourceSha256: sha('z'), sourceSizeBytes: 1, sourceKind: 'zip' } });
    expect(cols).toMatchObject({ sourceKind: 'zip', sourceKey: `listings/l-1/1.0.0/${sha('z')}.zip`, sourceSha256: sha('z'), sourceSizeBytes: 1 });
    expect(store.get(SOURCES, `listings/l-1/1.0.0/${sha('z')}.zip`)?.body.toString()).toBe('z');
    // No source → none; a failed copy → none + alert.
    expect((await src.keepListingSource({ listingId: 'l-1', version: '1.0.1', from: { sourceKey: null, sourceSha256: null, sourceSizeBytes: null, sourceKind: 'none' } })).sourceKind).toBe('none');
    expect((await src.keepListingSource({ listingId: 'l-1', version: '1.0.2', from: { sourceKey: 'gone', sourceSha256: sha('q'), sourceSizeBytes: 1, sourceKind: 'zip' } })).sourceKind).toBe('none');
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_missing_total', { reason: 'keep_failed' });
  });

  it('stores a remediation artifact with a diff content type', async () => {
    await src.putRemediationArtifact('o/p/1/remediations/r/remediation.diff', '--- a\n+++ b\n');
    expect(store.get(SOURCES, 'o/p/1/remediations/r/remediation.diff')).toMatchObject({ contentType: 'text/x-diff' });
  });

  it('sums an org\'s kept-source bytes, tombstones included, never another org\'s', async () => {
    const a = await seedPlugin(ORG, 'lint', '1.0.0');
    const b = await seedPlugin(ORG, 'lint', '1.0.1');
    const c = await seedPlugin(OTHER, 'lint', '1.0.0');
    for (const [id, n] of [[a, 100], [b, 50], [c, 7]] as const) {
      await owner((q) => q.query("UPDATE plugins SET source_kind = 'zip', source_key = 'k' || $1::text, source_sha256 = $2, source_size_bytes = $3, source_kept_at = now() WHERE id = $1", [id, sha(id), n]));
    }
    await owner((q) => q.query('UPDATE plugins SET deleted_at = now(), is_active = false WHERE id = $1', [b]));
    const { runWithTenantContext } = await import('@pipeline-builder/pipeline-data');
    expect(await runWithTenantContext({ orgId: ORG, isSuperAdmin: false }, () => src.orgSourceBytes(ORG))).toBe(150);
    const per = await runWithTenantContext({ orgId: ORG, isSuperAdmin: false }, () => src.sourceBytesByVersion(ORG));
    expect([...per.values()].map((v) => v.bytes).sort()).toEqual([100, 50]);
  });
});
