// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline org purge — the pipeline service's leg of platform's durable cascade outbox,
 * against a REAL Postgres (PGlite + the shipped init script, as the app role
 * under RLS) through the real route handler.
 *
 * The answer is the outbox's ack, so it pins: 200 with per-table counts once
 * the org's rows in THIS service's own tables are gone; only the purged org's
 * rows are touched; a redelivery is a no-op that still answers 200
 * (idempotent); a missing org id is a 400 that purges nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'internal-org-purge-test-secret';

const { createInternalOrgPurgeRoutes } = await import('../src/routes/internal-org-purge.js');

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

const handler = routeHandler(createInternalOrgPurgeRoutes(), 'post', '/orgs/:orgId/purge');
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
  await owner((q) => q.exec('DELETE FROM pipeline_step_lookups;'));
});

describe('POST /pipelines/internal/orgs/:orgId/purge', () => {
  it('tears down the org\'s rows in this service\'s own tables and acks with the counts', async () => {
    await owner((q) => q.query(
      'INSERT INTO pipeline_step_lookups (org_id, pipeline_id, step_key, plugin_name) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)',
      [ORG, 'p-1', 'build/lint', 'lint', OTHER, 'p-2'],
    ));
    const res = await purge(ORG);

    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toMatchObject({ orgId: ORG, tables: expect.objectContaining({ pipeline_step_lookups: 1 }) });
    // Every table of the slice was attempted (the response names each one).
    expect(Object.keys(res.body?.data?.tables as object)).toEqual(expect.arrayContaining(['pipelines', 'pipeline_templates', 'pipeline_registry', 'pipeline_step_manifests', 'pipeline_security_reports']));
    const left = await owner((q) => q.query<{ org_id: string }>('SELECT org_id FROM pipeline_step_lookups ORDER BY org_id'));
    expect(left.rows.map((r) => r.org_id)).toEqual([OTHER]);
  });

  it('is idempotent: a redelivered leg matches nothing and still acks 200', async () => {
    await owner((q) => q.query(
      'INSERT INTO pipeline_step_lookups (org_id, pipeline_id, step_key, plugin_name) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)',
      [ORG, 'p-1', 'build/lint', 'lint', OTHER, 'p-2'],
    ));
    expect((await purge(ORG)).statusCode).toBe(200);
    const again = await purge(ORG);
    expect(again.statusCode).toBe(200);
    expect((again.body?.data?.tables as Record<string, number>).pipeline_step_lookups).toBe(0);
  });

  it('400s a missing org id and purges nothing', async () => {
    await owner((q) => q.query(
      'INSERT INTO pipeline_step_lookups (org_id, pipeline_id, step_key, plugin_name) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)',
      [ORG, 'p-1', 'build/lint', 'lint', OTHER, 'p-2'],
    ));
    const res = await purge('');
    expect(res.statusCode).toBe(400);
    const left = await owner((q) => q.query('SELECT 1 FROM pipeline_step_lookups'));
    expect(left.rows).toHaveLength(2);
  });
});
