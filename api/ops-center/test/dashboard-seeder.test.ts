// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/dashboard-seeder.ts against a REAL Postgres (PGlite + the shipped
 * init script). The default dashboards moved with the seeder from platform's
 * boot to ops-center's: they must land once, as public system-org rows
 * with their panels, every panel must name a catalog key, and a restart must
 * not duplicate them.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { bootTenantDb, SYSTEM_ORG, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'dashboard-seeder-test-secret';

const { seedDefaultDashboards } = await import('../src/services/dashboard-seeder.js');
const { QUERIES } = await import('../src/observability/catalog.js');

let tdb: TenantTestDb;

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

const rows = () => tdb.asOwner(async (q) => (await q.query<{ name: string; org_id: string; visibility: string; panels: number }>(
  `SELECT d.name, d.org_id, d.visibility, (SELECT count(*)::int FROM dashboard_panels p WHERE p.dashboard_id = d.id) AS panels
     FROM dashboards d WHERE d.deleted_at IS NULL ORDER BY d.name`)).rows);

describe('seedDefaultDashboards', () => {
  it('seeds the five defaults once, public and system-owned, with their panels', async () => {
    await seedDefaultDashboards();
    const first = await rows();
    expect(first).toHaveLength(5);
    for (const d of first) {
      expect(d.org_id).toBe(SYSTEM_ORG);
      expect(d.visibility).toBe('public');
      expect(d.panels).toBeGreaterThan(0);
    }
    await seedDefaultDashboards();
    expect(await rows()).toEqual(first);
  });

  it('every seeded panel names a query the catalog serves', async () => {
    const keys = await tdb.asOwner(async (q) => (await q.query<{ query_key: string }>('SELECT DISTINCT query_key FROM dashboard_panels')).rows.map((r) => r.query_key));
    expect(keys.filter((k) => !Object.hasOwn(QUERIES, k))).toEqual([]);
  });

  // Moved from platform's scraper suite: platform still publishes these gauges
  // (one series per pod), and the catalog that renders them lives here now.
  it.each(['platform_orgs_total', 'platform_users_total', 'platform_memberships_active_total'])(
    'catalog collapses the per-pod %s series with max()',
    (key) => {
      expect(QUERIES[key]!.query).toBe(`max(${key})`);
    },
  );
});
