// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard soft delete → restore against a REAL Postgres (PGlite + the shipped
 * init script, as the application role under RLS), through the real
 * controllers and service.
 *
 * The case it exists for: `(org_id, name)` is unique only among LIVE rows, so a
 * tombstone can share its name with a newer live dashboard and restoring it
 * collides. Drizzle wraps the driver error (the SQLSTATE is on `cause`), so the
 * controller's old top-level `err.code === '23505'` check never matched and the
 * collision answered a raw 500 — this pins the intended 409 (with the reserved
 * quota slot given back).
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { featureQuotaMock } from './helpers/feature-quota-mock.js';
import { call, type Caller } from './helpers/pglite-controller.js';

process.env.JWT_SECRET ||= 'dashboards-restore-pglite-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const GRANTED = { exceeded: false, quota: { limit: 10, used: 1, remaining: 9 } };
const mockReserve = jest.fn<(orgId: string, type: string) => Promise<typeof GRANTED>>();
const mockRelease = jest.fn();

jest.unstable_mockModule('../src/middleware/quota.js', () => featureQuotaMock({
  reserveFeatureQuota: (orgId: string, type: string) => mockReserve(orgId, type),
  releaseFeatureQuota: (...a: unknown[]) => mockRelease(...a),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn(), recordAuditEvent: jest.fn() }));

const ctl = await import('../src/controllers/dashboards.js');

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);
const A: Caller = { orgId: 'org-dash-a', userId: 'user-a' };
const B: Caller = { orgId: 'org-dash-b', userId: 'user-b' };

async function createDashboard(caller: Caller, name: string): Promise<string> {
  const res = await call(ctl.createDashboard, caller, { body: { name } });
  expect(res.statusCode).toBe(201);
  return res.body!.data.dashboard.id as string;
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM dashboard_panels; DELETE FROM dashboards;'));
  mockReserve.mockReset().mockResolvedValue(GRANTED);
  mockRelease.mockReset();
});

describe('dashboard delete → restore (real Postgres)', () => {
  it('the creator deletes and restores their dashboard, releasing then re-reserving the slot', async () => {
    const id = await createDashboard(A, 'Ops');
    expect((await call(ctl.deleteDashboard, A, { params: { id } })).statusCode).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(A.orgId, 'dashboards', expect.any(Function), null);

    mockReserve.mockClear();
    const res = await call(ctl.restoreDashboard, A, { params: { id } });
    expect(res.statusCode).toBe(200);
    expect(mockReserve).toHaveBeenCalledWith(A.orgId, 'dashboards');
    // The retention stamp goes with the tombstone (as CrudService.restore does):
    // a restored LIVE row must not carry the old delete's `purge_after`.
    const { rows } = await owner((q) => q.query<{ deleted_at: Date | null; purge_after: Date | null }>('SELECT deleted_at, purge_after FROM dashboards WHERE id = $1', [id]));
    expect(rows[0]?.deleted_at).toBeNull();
    expect(rows[0]?.purge_after).toBeNull();
  });

  it('restoring onto a live namesake is a 409 (not a 500) and gives the reserved slot back', async () => {
    const first = await createDashboard(A, 'Ops');
    await call(ctl.deleteDashboard, A, { params: { id: first } });
    await createDashboard(A, 'Ops');
    mockRelease.mockClear();

    const res = await call(ctl.restoreDashboard, A, { params: { id: first } });
    expect(res.statusCode).toBe(409);
    expect(res.body?.message).toMatch(/already exists/);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    const { rows } = await owner((q) => q.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM dashboards WHERE id = $1', [first]));
    expect(rows[0]?.deleted_at).not.toBeNull();
  });

  it('another org cannot restore my tombstone', async () => {
    const id = await createDashboard(A, 'Mine');
    await call(ctl.deleteDashboard, A, { params: { id } });
    const res = await call(ctl.restoreDashboard, B, { params: { id } });
    expect([403, 404]).toContain(res.statusCode);
    const { rows } = await owner((q) => q.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM dashboards WHERE id = $1', [id]));
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});

describe('dashboard create / rename name collisions (real Postgres)', () => {
  it('creating a duplicate live name is a 409 (not a 500) and gives the reserved slot back', async () => {
    await createDashboard(A, 'Ops');
    mockRelease.mockClear();
    const res = await call(ctl.createDashboard, A, { body: { name: 'Ops' } });
    expect(res.statusCode).toBe(409);
    expect(mockRelease).toHaveBeenCalledWith(A.orgId, 'dashboards', expect.any(Function), expect.anything());
  });

  it('renaming onto a live namesake is a 409', async () => {
    await createDashboard(A, 'Ops');
    const other = await createDashboard(A, 'Other');
    const res = await call(ctl.updateDashboard, A, { params: { id: other }, body: { name: 'Ops' } });
    expect(res.statusCode).toBe(409);
  });

  it('the same name in another org is fine', async () => {
    await createDashboard(A, 'Ops');
    await createDashboard(B, 'Ops');
  });
});
