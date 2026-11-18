// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center's org purge — its leg of platform's durable cascade outbox,
 * against a REAL Postgres (PGlite + the shipped init script, as the app role
 * under RLS) through the real route handler.
 *
 * Before the split, platform purged dashboards and the org's alert rules and
 * destinations itself; the outbox's `ops-center` leg is what keeps an org
 * purge deleting them. Pins: 200 with per-table counts once the org's rows are
 * gone (tombstoned for the soft tables, removed for the delivery status); only
 * the purged org is touched; a redelivery is a no-op that still answers 200;
 * a missing org id is a 400 that purges nothing.
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

async function seed(): Promise<void> {
  await owner(async (q) => {
    for (const org of [ORG, OTHER]) {
      await q.query(
        'INSERT INTO org_alert_destinations (org_id, created_by, updated_by, channel, label) VALUES ($1, \'u\', \'u\', \'in-app\', \'inbox\')',
        [org],
      );
      await q.query(
        'INSERT INTO alert_destination_status (destination_id, org_id, channel, last_attempt_at, last_ok) VALUES ($1, $2, \'in-app\', now(), true)',
        [`dest-${org}`, org],
      );
    }
  });
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM alert_destination_status; DELETE FROM org_alert_destinations;'));
});

describe('POST /ops/internal/orgs/:orgId/purge', () => {
  it('tears down the org\'s rows in this service\'s own tables and acks with the counts', async () => {
    await seed();
    const res = await purge(ORG);

    expect(res.statusCode).toBe(200);
    expect(res.body?.data).toMatchObject({
      orgId: ORG,
      tables: expect.objectContaining({ org_alert_destinations: 1, alert_destination_status: 1 }),
    });
    expect(Object.keys(res.body?.data?.tables as object)).toEqual(expect.arrayContaining(['dashboards', 'org_alert_rules', 'org_alert_destinations', 'alert_destination_status']));
    // Soft table: tombstoned for the retention sweep; hard table: removed.
    const dests = await owner((q) => q.query<{ org_id: string; deleted_at: Date | null }>('SELECT org_id, deleted_at FROM org_alert_destinations ORDER BY org_id'));
    expect(dests.rows.find((r) => r.org_id === ORG)?.deleted_at).not.toBeNull();
    expect(dests.rows.find((r) => r.org_id === OTHER)?.deleted_at).toBeNull();
    const status = await owner((q) => q.query<{ org_id: string }>('SELECT org_id FROM alert_destination_status ORDER BY org_id'));
    expect(status.rows.map((r) => r.org_id)).toEqual([OTHER]);
  });

  it('is idempotent: a redelivered leg matches nothing and still acks 200', async () => {
    await seed();
    expect((await purge(ORG)).statusCode).toBe(200);
    const again = await purge(ORG);
    expect(again.statusCode).toBe(200);
    expect((again.body?.data?.tables as Record<string, number>).alert_destination_status).toBe(0);
  });

  it('400s a missing org id and purges nothing', async () => {
    await seed();
    const res = await purge('');
    expect(res.statusCode).toBe(400);
    const left = await owner((q) => q.query('SELECT 1 FROM alert_destination_status'));
    expect(left.rows).toHaveLength(2);
  });
});
