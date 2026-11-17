// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `mergedMetadataSources` — the SET value `pluginService.updateMany` writes for
 * `mergeMetadataSources` — against a REAL Postgres (PGlite, the shipped
 * postgres-init.sql, as the RLS-enforced app role).
 *
 * Bulk catalog edits mark each edited field's provenance `user`, like a single
 * update. The patch is merged into EVERY row's own `metadata_sources` in one
 * multi-row UPDATE (`coalesce(…) || patch`); what is under test is that SQL — a
 * shared written value would wipe the other fields' recorded provenance on
 * each row. (The CRUD base's own transaction is not redirectable to PGlite, so
 * the UPDATE is issued here with the same expression; the wiring from
 * `updateMany` to it is pinned in plugin-service.test.ts.)
 */

import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const { mergedMetadataSources } = await import('../src/services/plugin-service.js');
const { inArray } = await import('drizzle-orm');
const { schema } = realPipelineData;

afterAll(async () => { await raw.close(); });

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb1';

/** The multi-row UPDATE `updateMany` issues, as the caller's org (RLS scopes it). */
function bulkSet(ids: string[], set: Record<string, unknown>): Promise<Array<{ id: string }>> {
  return realPipelineData.runWithTenantContext({ orgId: ORG, isSuperAdmin: false }, () =>
    testDb.withTenantTx((tx) => tx.update(schema.plugin).set(set).where(inArray(schema.plugin.id, ids)).returning({ id: schema.plugin.id })));
}

async function seed(orgId: string, name: string, sources: Record<string, string>): Promise<string> {
  const r = await raw.query<{ id: string }>(
    'INSERT INTO plugins (org_id, name, version, created_by, updated_by, visibility, metadata_sources) VALUES ($1, $2, \'1.0.0\', \'u-1\', \'u-1\', \'org\', $3) RETURNING id',
    [orgId, name, JSON.stringify(sources)],
  );
  return r.rows[0]!.id;
}

async function sourcesOf(id: string): Promise<unknown> {
  const r = await raw.query<{ metadata_sources: unknown }>('SELECT metadata_sources FROM plugins WHERE id = $1', [id]);
  return r.rows[0]!.metadata_sources;
}

describe('mergedMetadataSources (bulk provenance merge)', () => {
  it("merges the patch into each row's own provenance, keeping its other fields", async () => {
    const a = await seed(ORG, 'a', { summary: 'manifest', description: 'derived' });
    const b = await seed(ORG, 'b', { license: 'manifest' });
    const other = await seed(OTHER, 'c', { description: 'derived' });

    const none = await seed(ORG, 'e', {});
    const updated = await bulkSet([a, b, none, other], { description: 'edited', metadataSources: mergedMetadataSources({ description: 'user' }) });

    expect(updated.map((p) => p.id).sort()).toEqual([a, b, none].sort());
    expect(await sourcesOf(a)).toEqual({ summary: 'manifest', description: 'user' });
    expect(await sourcesOf(b)).toEqual({ license: 'manifest', description: 'user' });
    // A row with no recorded provenance yet gets just the patch.
    expect(await sourcesOf(none)).toEqual({ description: 'user' });
    // Another org's row is never touched (RLS / the own-org write pin).
    expect(await sourcesOf(other)).toEqual({ description: 'derived' });
  });

  it('a later patch overrides an earlier source for the same field only', async () => {
    const a = await seed(ORG, 'd', { description: 'derived', keywords: 'user' });
    await bulkSet([a], { metadataSources: mergedMetadataSources({ description: 'user', category: 'user' }) });
    expect(await sourcesOf(a)).toEqual({ description: 'user', keywords: 'user', category: 'user' });
  });
});
