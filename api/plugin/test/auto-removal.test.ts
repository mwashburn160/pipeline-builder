// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one rule every AUTOMATIC clean-up asks (helpers/auto-removal.ts): never
 * an active version, never a name's only remaining version — as a pure
 * predicate and as the SQL twin the sweeps and the retention pass evaluate, on
 * a REAL Postgres (PGlite + the shipped init script).
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter }));

const ar = await import('../src/helpers/auto-removal.js');
const { sql } = await import('drizzle-orm');
const { PgDialect } = await import('drizzle-orm/pg-core');

describe('autoRemovalProtection', () => {
  it.each([
    [{ isActive: true, deletedAt: null, otherLiveVersions: 3 }, 'active'],
    [{ isActive: false, deletedAt: null, otherLiveVersions: 0 }, 'only_version'],
    // Only-version protects LIVE versions only: a tombstone with no live sibling
    // (the whole plugin soft-deleted) is purged after its window.
    [{ isActive: true, deletedAt: new Date(), otherLiveVersions: 0 }, null],
    [{ isActive: false, deletedAt: new Date(), otherLiveVersions: 0 }, null],
    [{ isActive: true, deletedAt: new Date(), otherLiveVersions: 1 }, null],
    [{ isActive: false, deletedAt: null, otherLiveVersions: 1 }, null],
  ] as const)('%j → %s', (facts, want) => {
    expect(ar.autoRemovalProtection(facts)).toBe(want);
    expect(ar.isProtectedFromAutoRemoval(facts)).toBe(want !== null);
  });

  it('counts a skip with a bounded reason', async () => {
    ar.recordAutoRemovalSkip('only_version', { path: 'sweep', orgId: 'o', name: 'lint', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_auto_removal_skipped_total', { reason: 'only_version' }, 1);
  });
});

describe('the SQL twin', () => {
  let tdb: TenantTestDb;
  const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
  beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
  afterAll(async () => { await tdb?.close(); });
  beforeEach(async () => { await tdb.asOwner((q) => q.exec('DELETE FROM plugins;')); });

  const seed = (version: string, over: { active?: boolean; deleted?: boolean } = {}) => tdb.asOwner((q) => q.query(
    "INSERT INTO plugins (org_id, name, version, created_by, updated_by, visibility, is_active, deleted_at) VALUES ($1, 'lint', $2, 'u', 'u', 'org', $3, $4)",
    [ORG, version, over.active ?? true, over.deleted ? new Date() : null]));
  const reasons = async () => {
    const q = new PgDialect().sqlToQuery(sql`SELECT pr.version, ${ar.autoRemovalReasonSql(sql`pr`)} AS reason, ${ar.autoRemovalProtectedSql(sql`pr`)} AS protected FROM plugins pr ORDER BY pr.version`);
    return (await tdb.asOwner((db) => db.query<{ version: string; reason: string | null; protected: boolean }>(q.sql, q.params))).rows;
  };

  it('agrees with the predicate: active, only version, and the removable rest', async () => {
    await seed('1.0.0', { active: false });
    await seed('1.1.0', { active: true });
    await seed('0.9.0', { active: true, deleted: true });
    expect(await reasons()).toEqual([
      { version: '0.9.0', reason: null, protected: false },
      { version: '1.0.0', reason: null, protected: false },
      { version: '1.1.0', reason: 'active', protected: true },
    ]);
  });

  it('the last non-deleted version is only_version; a tombstone with no live sibling is not protected', async () => {
    await seed('1.0.0', { active: false });
    await seed('0.9.0', { deleted: true });
    expect(await reasons()).toEqual([
      { version: '0.9.0', reason: null, protected: false },
      { version: '1.0.0', reason: 'only_version', protected: true },
    ]);
    await tdb.asOwner((q) => q.query("UPDATE plugins SET deleted_at = now() WHERE version = '1.0.0'"));
    expect(await reasons()).toEqual([
      { version: '0.9.0', reason: null, protected: false },
      { version: '1.0.0', reason: null, protected: false },
    ]);
  });
});
