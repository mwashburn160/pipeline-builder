// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The listing hook (services/ecosystem/listing-purge.ts +
 * plugin-sources `deleteListingSources`): purging a listing version, or
 * removing a listing, deletes its kept sources under
 * `plugin-sources/listings/<listingId>/…` — objects no org purge covers — and a
 * failed delete lands in plugin_source_orphans for the purge sweep's retry.
 * Against a REAL Postgres (PGlite + the shipped init script) and an in-memory RustFS.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { createFakeS3Store, fakeS3Module } from './helpers/fake-s3.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const s3 = createFakeS3Store();
jest.unstable_mockModule('@aws-sdk/client-s3', () => fakeS3Module(s3));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: jest.fn() }));
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter }));

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);
const { purgeListingVersion, removeListing } = await import('../src/services/ecosystem/listing-purge.js');
const { listingSourcePrefix, retryPluginSourceOrphans } = await import('../src/services/plugin-sources.js');
const { listingSourceKey, SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');

const SOURCES = 'plugin-sources';
const LISTING = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const SHA = 'a'.repeat(64);

async function seedListing(id: string, name: string, versionsToSeed: string[]): Promise<void> {
  await owner((q) => q.query("INSERT INTO plugin_listings (id, publisher_id, name) SELECT $1, id, $2 FROM publishers WHERE handle = 'pipeline-builder'", [id, name]));
  for (const v of versionsToSeed) {
    const key = listingSourceKey(id, v, SHA);
    await owner((q) => q.query(
      `INSERT INTO plugin_listing_versions (listing_id, version, published_by, source_kind, source_key, source_sha256, source_size_bytes, source_kept_at)
       VALUES ($1, $2, 'u-1', 'zip', $3, $4, 3, now())`, [id, v, key, SHA]));
    s3.put(SOURCES, key, 'zip');
    s3.put(SOURCES, `${listingSourcePrefix(id, v)}remediations/r1/remediation.diff`, 'diff');
  }
}
const versionsOf = (id: string) => owner((q) => q.query<{ version: string }>('SELECT version FROM plugin_listing_versions WHERE listing_id = $1 ORDER BY version', [id])).then((r) => r.rows.map((x) => x.version));
const orphans = () => owner((q) => q.query<{ org_id: string; kind: string; target: string }>('SELECT org_id, kind, target FROM plugin_source_orphans')).then((r) => r.rows);

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  s3.reset();
  s3.buckets.set(SOURCES, new Map());
  await owner((q) => q.exec('DELETE FROM plugin_source_orphans; DELETE FROM plugin_listing_versions; DELETE FROM plugin_listings;'));
  await seedListing(LISTING, 'lint', ['1.0.0', '1.1.0']);
  await seedListing(OTHER, 'fmt', ['1.0.0']);
});

describe('listing hook: kept listing sources go with the listing version', () => {
  it('a purged listing version takes its listings/<id>/<version>/ prefix with it, and nothing else', async () => {
    expect(await purgeListingVersion(LISTING, '1.0.0')).toBe(true);
    expect(await versionsOf(LISTING)).toEqual(['1.1.0']);
    expect(s3.keys(SOURCES).sort()).toEqual([
      listingSourceKey(LISTING, '1.1.0', SHA),
      listingSourceKey(OTHER, '1.0.0', SHA),
      `${listingSourcePrefix(LISTING, '1.1.0')}remediations/r1/remediation.diff`,
      `${listingSourcePrefix(OTHER, '1.0.0')}remediations/r1/remediation.diff`,
    ].sort());
    const latest = await owner((q) => q.query<{ latest_version: string | null }>('SELECT latest_version FROM plugin_listings WHERE id = $1', [LISTING]));
    expect(latest.rows[0]!.latest_version).toBe('1.1.0');
    expect(await purgeListingVersion(LISTING, '1.0.0')).toBe(false);
  });

  it('a removed listing takes every version\'s sources with it', async () => {
    expect(await removeListing(LISTING)).toBe(true);
    expect(await versionsOf(LISTING)).toEqual([]);
    expect(s3.keys(SOURCES).every((k) => k.startsWith(listingSourcePrefix(OTHER)))).toBe(true);
    expect(s3.keys(SOURCES)).toHaveLength(2);
    expect(await removeListing(LISTING)).toBe(false);
    expect(await removeListing('not-a-uuid')).toBe(false);
  });

  it('a failed delete never undoes the purge: it is a system-org prefix orphan the sweep retries', async () => {
    s3.undeletable.add(listingSourceKey(LISTING, '1.0.0', SHA));
    expect(await purgeListingVersion(LISTING, '1.0.0')).toBe(true);
    expect(await versionsOf(LISTING)).toEqual(['1.1.0']);
    expect(await orphans()).toEqual([{ org_id: SYSTEM_ORG_ID, kind: 'prefix', target: listingSourcePrefix(LISTING, '1.0.0') }]);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_source_delete_failures_total', { kind: 'prefix' });

    s3.undeletable.clear();
    expect(await retryPluginSourceOrphans()).toEqual({ tried: 1, cleared: 1, failed: 0 });
    expect(await orphans()).toEqual([]);
    expect(s3.keys(SOURCES).some((k) => k.startsWith(listingSourcePrefix(LISTING, '1.0.0')))).toBe(false);
    expect(s3.keys(SOURCES).some((k) => k.startsWith(listingSourcePrefix(LISTING, '1.1.0')))).toBe(true);
  });
});
