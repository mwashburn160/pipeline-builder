// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog-scope visibility on the dashboards surface.
 *
 * A panel whose catalog key the caller can't run 403s at the observability
 * query layer — a fleet-wide key for a non-sysadmin, an admin-only key (the
 * org-scoped audit trail) for a plain member — so the dashboards API must not
 * hand those panels out: they're withheld on get/clone, a dashboard with no
 * renderable panel is hidden (list) / 404'd (get, clone), and the caller can't
 * author one. Regression for org members opening seeded dashboards to a wall of
 * "system admin access required" panels, and for org admins getting their own
 * org's Audit Activity.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIsSystemAdmin = jest.fn<(req: unknown) => boolean>();
const mockIsOrgAdmin = jest.fn<(req: unknown) => boolean>();
const mockList = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockListPanelKeys = jest.fn<(ids: string[]) => Promise<Map<string, string[]>>>();
const mockFindById = jest.fn<(id: string) => Promise<unknown>>();
const mockClone = jest.fn<(source: any, caller: unknown) => Promise<unknown>>();
const mockCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: (req: unknown) => mockIsSystemAdmin(req),
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  sendQuotaReserveDenied: jest.fn(),
  userHasPermission: () => true,
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { observability: { dashboardMaxName: 150, dashboardMaxDescription: 1000, dashboardMaxPanelTitle: 200, dashboardMaxPanels: 50 } },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  getAdminContext: (req: unknown) => ({ isSuperAdmin: mockIsSystemAdmin(req), isOrgAdmin: mockIsOrgAdmin(req), adminType: 'org admin' }),
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
  requireAuthContext: (req: any) => ({ userId: req.user.sub, orgId: req.user.organizationId }),
}));

jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  reserveFeatureQuota: jest.fn(async () => ({ exceeded: false })),
  releaseFeatureQuota: jest.fn(),
}));

jest.unstable_mockModule('../src/services/dashboard-service.js', () => ({
  dashboardService: {
    list: (...a: unknown[]) => mockList(...a),
    listPanelKeys: (ids: string[]) => mockListPanelKeys(ids),
    findById: (id: string) => mockFindById(id),
    canRead: () => true,
    clone: (source: unknown, caller: unknown) => mockClone(source, caller),
    create: (...a: unknown[]) => mockCreate(...a),
  },
}));

const { listDashboards, getDashboard, cloneDashboard, createDashboard } = await import('../src/controllers/dashboards.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

const req = (extra: Record<string, unknown> = {}) =>
  ({ user: { sub: 'u1', organizationId: 'org1' }, params: { id: 'd1' }, body: {}, ...extra }) as any;

// Seeded-default shapes: Queue Health is all fleet-wide; Audit Activity is all
// org-scoped + admin-only; Plugin Builds mixes orgScoped and fleet-wide panels;
// an empty dashboard has no panels at all.
const panel = (queryKey: string) => ({ id: queryKey, queryKey });
const QUEUE = { id: 'queue', name: 'Queue Health', panels: [panel('plugin_job_wait_p50'), panel('plugin_dlq_size')] };
const AUDIT = { id: 'audit', name: 'Audit Activity', panels: [panel('audit_events_per_hour_by_event'), panel('audit_recent_events')] };
const MIXED = { id: 'mixed', name: 'Plugin Builds', panels: [panel('plugin_builds_per_min'), panel('plugin_queue_depth')] };
const EMPTY = { id: 'empty', name: 'Fresh', panels: [] };
const ALL = [QUEUE, AUDIT, MIXED, EMPTY];

const asMember = () => { mockIsSystemAdmin.mockReturnValue(false); mockIsOrgAdmin.mockReturnValue(false); };
const asOrgAdmin = () => { mockIsSystemAdmin.mockReturnValue(false); mockIsOrgAdmin.mockReturnValue(true); };
const asSysadmin = () => { mockIsSystemAdmin.mockReturnValue(true); mockIsOrgAdmin.mockReturnValue(false); };
const keysOf = (panels: Array<{ queryKey: string }>) => panels.map(p => p.queryKey);

beforeEach(() => {
  jest.clearAllMocks();
  asMember();
  mockList.mockResolvedValue(ALL.map(({ panels: _p, ...row }) => row));
  mockListPanelKeys.mockResolvedValue(new Map(ALL.filter(d => d.panels.length > 0).map(d => [d.id, keysOf(d.panels)])));
  mockClone.mockImplementation(async (source: any) => ({ ...source, id: 'copy' }));
  mockCreate.mockImplementation(async (input: any) => ({ id: 'new', ...input }));
});

async function listedNames(): Promise<string[]> {
  const res = makeRes();
  await listDashboards(req(), res);
  return (res._body.data.dashboards as Array<{ name: string }>).map(d => d.name);
}

describe('listDashboards', () => {
  it('shows a plain member only dashboards with a panel they can render', async () => {
    expect(await listedNames()).toEqual(['Plugin Builds', 'Fresh']);
  });

  it('shows an org admin their org-scoped Audit Activity, still not fleet-wide ones', async () => {
    asOrgAdmin();
    expect(await listedNames()).toEqual(['Audit Activity', 'Plugin Builds', 'Fresh']);
  });

  it('shows a sysadmin everything without the extra panel lookup', async () => {
    asSysadmin();
    expect(await listedNames()).toHaveLength(4);
    expect(mockListPanelKeys).not.toHaveBeenCalled();
  });
});

describe('getDashboard', () => {
  it('404s a plain member on Audit Activity (admin-only panels)', async () => {
    mockFindById.mockResolvedValue(AUDIT);
    const res = makeRes();
    await getDashboard(req(), res);
    expect(res._status).toBe(404);
  });

  it('serves an org admin Audit Activity with its panels', async () => {
    asOrgAdmin();
    mockFindById.mockResolvedValue(AUDIT);
    const res = makeRes();
    await getDashboard(req(), res);
    expect(res._status).toBe(200);
    expect(keysOf(res._body.data.dashboard.panels)).toEqual(keysOf(AUDIT.panels));
  });

  it('404s an org admin on an all-fleet-wide dashboard (Queue Health)', async () => {
    asOrgAdmin();
    mockFindById.mockResolvedValue(QUEUE);
    const res = makeRes();
    await getDashboard(req(), res);
    expect(res._status).toBe(404);
  });

  it('withholds fleet-wide panels on a mixed dashboard', async () => {
    mockFindById.mockResolvedValue(MIXED);
    const res = makeRes();
    await getDashboard(req(), res);
    expect(res._status).toBe(200);
    expect(keysOf(res._body.data.dashboard.panels)).toEqual(['plugin_builds_per_min']);
  });

  it('returns every panel to a sysadmin', async () => {
    asSysadmin();
    mockFindById.mockResolvedValue(QUEUE);
    const res = makeRes();
    await getDashboard(req(), res);
    expect(res._status).toBe(200);
    expect(res._body.data.dashboard.panels).toHaveLength(2);
  });
});

describe('cloneDashboard', () => {
  it('copies only the panels the caller can render', async () => {
    mockFindById.mockResolvedValue(MIXED);
    const res = makeRes();
    await cloneDashboard(req(), res);
    expect(res._status).toBe(201);
    expect(keysOf(mockClone.mock.calls[0][0].panels)).toEqual(['plugin_builds_per_min']);
  });

  it('404s an org admin cloning an all-fleet-wide dashboard', async () => {
    asOrgAdmin();
    mockFindById.mockResolvedValue(QUEUE);
    const res = makeRes();
    await cloneDashboard(req(), res);
    expect(res._status).toBe(404);
    expect(mockClone).not.toHaveBeenCalled();
  });
});

describe('createDashboard', () => {
  const create = async (queryKey: string) => {
    const res = makeRes();
    await createDashboard(req({ body: { name: 'Mine', panels: [{ queryKey, title: 'P' }] } }), res);
    return res;
  };

  it('rejects a fleet-wide panel key from an org admin', async () => {
    asOrgAdmin();
    const res = await create('platform_orgs_total');
    expect(res._status).toBe(400);
    expect(res._body.message).toMatch(/not available to you/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an audit panel from a plain member', async () => {
    const res = await create('audit_recent_events');
    expect(res._status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('lets an org admin build on their own audit trail', async () => {
    asOrgAdmin();
    const res = await create('audit_recent_events');
    expect(res._status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
