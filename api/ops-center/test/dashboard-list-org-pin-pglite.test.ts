// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The LIST reads apply the same org pin `canRead` / `canWrite` do on a PRIVATE
 * dashboard: the creator, and only while acting in the dashboard's own org.
 *
 * A person's id is the same in every org they belong to, and RLS lets every
 * org read system-org rows (the shared-defaults carve-out). So a system-org
 * member's private dashboard, listed by the same person acting in a tenant org,
 * passed both RLS and the old `created_by = me` branch — the list offered a
 * dashboard that GET /:id then refused. Runs on a REAL Postgres (PGlite + the
 * shipped init script, as the application role under RLS).
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { featureQuotaMock } from './helpers/feature-quota-mock.js';
import { call, type Caller } from './helpers/pglite-controller.js';

process.env.JWT_SECRET ||= 'dashboard-list-org-pin-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const GRANTED = { exceeded: false, quota: { limit: 10, used: 1, remaining: 9 } };
jest.unstable_mockModule('../src/middleware/quota.js', () => featureQuotaMock({
  reserveFeatureQuota: async () => GRANTED,
  releaseFeatureQuota: () => undefined,
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn(), recordAuditEvent: jest.fn() }));

const ctl = await import('../src/controllers/dashboards.js');

const SYSTEM_ORG = '000000000000000000000001';
const PERSON = 'user-both-orgs';
const IN_SYSTEM: Caller = { orgId: SYSTEM_ORG, userId: PERSON };
const IN_TENANT: Caller = { orgId: 'org-dash-tenant', userId: PERSON };

let tdb: TenantTestDb;

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => {
  await tdb.asOwner((q) => q.exec('DELETE FROM dashboard_panels; DELETE FROM dashboards;'));
});

async function createPrivate(caller: Caller, name: string): Promise<string> {
  const res = await call(ctl.createDashboard, caller, { body: { name, visibility: 'private' } });
  expect(res.statusCode).toBe(201);
  return res.body!.data.dashboard.id as string;
}

const ids = (res: { body?: { data?: any } }): string[] =>
  (res.body?.data?.dashboards as Array<{ id: string }>).map((d) => d.id);

describe('private dashboards are listed only in their own org', () => {
  it('the creator acting in ANOTHER org does not list their system-org private dashboard', async () => {
    const id = await createPrivate(IN_SYSTEM, 'Mine');
    // Sanity: the read-by-id ladder already refuses it from the tenant org.
    expect((await call(ctl.getDashboard, IN_TENANT, { params: { id } })).statusCode).not.toBe(200);

    expect(ids(await call(ctl.listDashboards, IN_TENANT))).not.toContain(id);
    expect(ids(await call(ctl.listDashboards, IN_SYSTEM))).toContain(id);
  });

  it('the tombstone list applies the same pin', async () => {
    const id = await createPrivate(IN_SYSTEM, 'Gone');
    expect((await call(ctl.deleteDashboard, IN_SYSTEM, { params: { id } })).statusCode).toBe(200);

    expect(ids(await call(ctl.listDeletedDashboards, IN_TENANT))).not.toContain(id);
    expect(ids(await call(ctl.listDeletedDashboards, IN_SYSTEM))).toContain(id);
  });
});
