// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin org purge and user erasure — the plugin service's leg of platform's durable cascade outbox,
 * against a REAL Postgres (PGlite + the shipped init script, as the app role
 * under RLS) through the real route handler.
 *
 * The answer is the outbox's ack, so it pins: 200 with per-table counts once
 * the org's rows in THIS service's own tables are gone; only the purged org's
 * rows are touched; a redelivery is a no-op that still answers 200
 * (idempotent); a missing org id is a 400 that purges nothing.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { createFakeS3Store, fakeS3Module } from './helpers/fake-s3.js';

// The kept plugin sources live on RustFS: an in-memory one here.
const s3 = createFakeS3Store();
jest.unstable_mockModule('@aws-sdk/client-s3', () => fakeS3Module(s3));

process.env.JWT_SECRET ||= 'internal-org-purge-test-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-purge-'));

const { createInternalRoutes } = await import('../src/routes/internal.js');

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-purged';
const OTHER = 'org-kept';

function makeRes() {
  const res: { statusCode?: number; body?: { data?: Record<string, unknown>; message?: string }; status: (n: number) => unknown; json: (b: unknown) => unknown; setHeader: () => void } = {
    status(n: number) { res.statusCode = n; return res; },
    json(b: unknown) { res.body = b as never; return res; },
    setHeader() { /* envelope headers are irrelevant here */ },
  };
  return res;
}

const handler = routeHandler(createInternalRoutes(), 'post', '/plugins/orgs/:orgId/purge');
const purge = async (orgId?: string) => {
  const res = makeRes();
  await handler({ params: orgId === undefined ? {} : { orgId }, headers: {} }, res);
  return res;
};

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  s3.reset();
  s3.buckets.set('plugin-sources', new Map());
  await owner((q) => q.exec('DELETE FROM plugin_install_policies; DELETE FROM plugin_reviews; DELETE FROM plugin_source_orphans;'));
});

describe('POST /internal/plugins/orgs/:orgId/purge', () => {
  it('tears down the org\'s rows in this service\'s own tables and acks with the counts', async () => {
    await owner((q) => q.query('INSERT INTO plugin_install_policies (org_id) VALUES ($1), ($2)', [ORG, OTHER]));
    const res = await purge(ORG);

    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toMatchObject({ orgId: ORG, tables: expect.objectContaining({ plugin_install_policies: 1 }) });
    // Every table of the slice was attempted (the response names each one).
    expect(Object.keys(res.body?.data?.tables as object)).toEqual(expect.arrayContaining(['plugins', 'plugin_installs', 'plugin_advisory_deliveries', 'org_toolchain_default']));
    const left = await owner((q) => q.query<{ org_id: string }>('SELECT org_id FROM plugin_install_policies ORDER BY org_id'));
    expect(left.rows.map((r) => r.org_id)).toEqual([OTHER]);
  });

  it('is idempotent: a redelivered leg matches nothing and still acks 200', async () => {
    await owner((q) => q.query('INSERT INTO plugin_install_policies (org_id) VALUES ($1), ($2)', [ORG, OTHER]));
    expect((await purge(ORG)).statusCode).toBe(200);
    const again = await purge(ORG);
    expect(again.statusCode).toBe(200);
    expect((again.body?.data?.tables as Record<string, number>).plugin_install_policies).toBe(0);
  });

  it('deletes the org\'s kept sources (plugin-sources/<orgId>/) first, and no other org\'s', async () => {
    s3.put('plugin-sources', `${ORG}/p1/1.0.0/abc.zip`, 'zip');
    s3.put('plugin-sources', `${ORG}/p1/1.0.0/remediations/r1/remediation.diff`, 'diff');
    s3.put('plugin-sources', `${OTHER}/p2/1.0.0/def.zip`, 'zip');
    const res = await purge(ORG);
    expect(res.statusCode).toBe(200);
    expect(s3.keys('plugin-sources')).toEqual([`${OTHER}/p2/1.0.0/def.zip`]);
  });

  it('a failed source delete is NOT an ack (500) and leaves the tables (orphan rows included) for the retry', async () => {
    s3.put('plugin-sources', `${ORG}/p1/1.0.0/abc.zip`, 'zip');
    s3.undeletable.add(`${ORG}/p1/1.0.0/abc.zip`);
    await owner((q) => q.query('INSERT INTO plugin_install_policies (org_id) VALUES ($1)', [ORG]));
    await owner((q) => q.query("INSERT INTO plugin_source_orphans (org_id, kind, bucket, target, last_error) VALUES ($1, 'prefix', 'plugin-sources', 'x/', 'E')", [ORG]));
    const res = await purge(ORG);
    expect(res.statusCode).toBe(500);
    const left = await owner((q) => q.query('SELECT 1 FROM plugin_install_policies UNION ALL SELECT 1 FROM plugin_source_orphans'));
    expect(left.rows).toHaveLength(2);
  });

  it('400s a missing org id and purges nothing', async () => {
    await owner((q) => q.query('INSERT INTO plugin_install_policies (org_id) VALUES ($1), ($2)', [ORG, OTHER]));
    const res = await purge('');
    expect(res.statusCode).toBe(400);
    const left = await owner((q) => q.query('SELECT 1 FROM plugin_install_policies'));
    expect(left.rows).toHaveLength(2);
  });
});

describe('POST /internal/plugins/users/:userId/erase', () => {
  const erase = routeHandler(createInternalRoutes(), 'post', '/plugins/users/:userId/erase');
  const run = async (userId?: string) => {
    const res = makeRes();
    await erase({ params: userId === undefined ? {} : { userId }, headers: {}, user: undefined }, res);
    return res;
  };

  /** A review row, seeded with FK checks off (its listing is irrelevant to the scrub). */
  async function seedReview(author: string, org: string): Promise<void> {
    await owner(async (q) => {
      await q.exec('SET session_replication_role = replica');
      try {
        await q.query(
          `INSERT INTO plugin_reviews (listing_id, rating, body_md, body_html, author_user_id, author_org_id, author_display_name)
           VALUES (gen_random_uuid(), 4, 'my words', '<p>my words</p>', $1, $2, 'Pat')`,
          [author, org],
        );
      } finally {
        await q.exec('SET session_replication_role = DEFAULT');
      }
    });
  }

  it('scrubs the person out of their reviews in EVERY org (rating kept) and acks the count', async () => {
    await seedReview('u-gone', ORG);
    await seedReview('u-gone', OTHER);
    await seedReview('u-stays', ORG);

    const res = await run('u-gone');

    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toEqual({ userId: 'u-gone', reviews: 2 });
    const rows = await owner((q) => q.query<{ author_user_id: string | null; body_md: string | null; author_display_name: string | null; rating: number }>(
      'SELECT author_user_id, body_md, author_display_name, rating FROM plugin_reviews ORDER BY author_user_id NULLS FIRST',
    ));
    expect(rows.rows).toEqual([
      { author_user_id: null, body_md: null, author_display_name: null, rating: 4 },
      { author_user_id: null, body_md: null, author_display_name: null, rating: 4 },
      { author_user_id: 'u-stays', body_md: 'my words', author_display_name: 'Pat', rating: 4 },
    ]);
  });

  it('is idempotent: a redelivery scrubs nothing and still acks 200', async () => {
    await seedReview('u-gone', ORG);
    expect((await run('u-gone')).body?.data).toEqual({ userId: 'u-gone', reviews: 1 });
    const again = await run('u-gone');
    expect(again.statusCode).toBe(200);
    expect(again.body?.data).toEqual({ userId: 'u-gone', reviews: 0 });
  });

  it('400s a missing user id', async () => {
    expect((await run('')).statusCode).toBe(400);
  });
});
