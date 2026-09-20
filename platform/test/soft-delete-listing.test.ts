// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Recently deleted" for dashboards, alert rules and alert destinations.
 *
 * Restore routes existed for all three, but nothing could LIST what they could
 * restore — so deleting one was effectively permanent even though the row sat
 * there restorable until the retention sweep. These suites pin the two halves
 * that make the panel honest:
 *
 *  - the listing shows only tombstones the caller may actually restore (never a
 *    Restore button that would 403 after the step-up prompt), and never another
 *    tenant's row;
 *  - purge finalizes a TOMBSTONE only — a live row 404s rather than being
 *    destroyed in one call — and is audited with safe metadata (never a
 *    destination's target, which is bearer-equivalent).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIsSystemAdmin = jest.fn<(req: unknown) => boolean>();
const mockHasPermission = jest.fn<(req: unknown, perm: string) => boolean>();
const mockAudit = jest.fn();

// ── dashboards ──────────────────────────────────────────────────────────────
const mockListDeletedDash = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockFindDeletedDash = jest.fn<(id: string) => Promise<unknown>>();
const mockPurgeDash = jest.fn<(id: string) => Promise<boolean>>();
const mockCanWrite = jest.fn<(row: any, ctx: any) => boolean>();

// ── alert rules / destinations ──────────────────────────────────────────────
const mockListDeletedRules = jest.fn<(orgId: string) => Promise<unknown[]>>();
const mockFindDeletedRule = jest.fn<(orgId: string, id: string) => Promise<unknown>>();
const mockPurgeRule = jest.fn<(orgId: string, id: string) => Promise<boolean>>();
const mockListDeletedDests = jest.fn<(orgId: string) => Promise<unknown[]>>();
const mockFindDeletedDest = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
const mockPurgeDest = jest.fn<(id: string, orgId: string) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: (req: unknown) => mockIsSystemAdmin(req),
  userHasPermission: (req: unknown, perm: string) => mockHasPermission(req, perm),
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  sendQuotaReserveDenied: jest.fn(),
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  softDeleteRetentionMs: () => 0,
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: mockAudit }));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    observability: {
      dashboardMaxName: 150,
      dashboardMaxDescription: 1000,
      dashboardMaxPanelTitle: 200,
      dashboardMaxPanels: 50,
      alertDestinationMaxLabel: 100,
      alertDestinationMaxTarget: 500,
      alertDeliveryTimeoutMs: 5000,
    },
  },
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  reserveFeatureQuota: jest.fn(async () => ({ exceeded: false })),
  releaseFeatureQuota: jest.fn(),
}));

jest.unstable_mockModule('../src/services/dashboard-service.js', () => ({
  dashboardService: {
    listDeleted: (...a: unknown[]) => mockListDeletedDash(...a),
    findDeletedById: (id: string) => mockFindDeletedDash(id),
    purgeById: (id: string) => mockPurgeDash(id),
    canWrite: (row: any, ctx: any) => mockCanWrite(row, ctx),
  },
}));

jest.unstable_mockModule('../src/services/alert-rule-service.js', () => ({
  alertRuleService: {
    listDeletedForOrg: (orgId: string) => mockListDeletedRules(orgId),
    findDeletedById: (orgId: string, id: string) => mockFindDeletedRule(orgId, id),
    purgeById: (orgId: string, id: string) => mockPurgeRule(orgId, id),
  },
  prepareRuleExpr: (expr: string) => expr,
  validateRule: () => ({ ok: true }),
  renderRulesYaml: () => '',
}));

class DestinationNotFoundError extends Error {}
jest.unstable_mockModule('../src/services/alert-destination-service.js', () => ({
  alertDestinationService: {
    listDeletedForOrg: (orgId: string) => mockListDeletedDests(orgId),
    findDeletedById: (id: string, orgId: string) => mockFindDeletedDest(id, orgId),
    purgeById: (id: string, orgId: string) => mockPurgeDest(id, orgId),
  },
  DestinationNotFoundError,
  // Mirror the real mask so a leak of the raw target would fail the assertion.
  toApiDestination: (d: any) => ({ ...d, target: `••••${String(d.target ?? '').slice(-12)}`, hasTarget: !!d.target }),
}));

jest.unstable_mockModule('../src/services/promql-rewriter.js', () => ({
  PromQLRewriteError: class extends Error {},
  injectOrgId: (expr: string) => expr,
  validateOrgIdMatchers: () => ({ ok: true }),
}));

jest.unstable_mockModule('../src/services/alert-relay.js', () => ({ relayWebhook: jest.fn() }));
jest.unstable_mockModule('../src/utils/email-address.js', () => ({ isValidEmail: () => true }));
jest.unstable_mockModule('../src/utils/string-guards.js', () => ({ isReasonableString: () => true }));

const { listDeletedDashboards, purgeDashboard } = await import('../src/controllers/dashboards.js');
const { listDeletedAlertRules, purgeAlertRule } = await import('../src/controllers/alert-rules.js');
const { listDeletedAlertDestinations, purgeAlertDestination } = await import('../src/controllers/alert-destinations.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

const req = (extra: Record<string, unknown> = {}) =>
  ({ user: { sub: 'u1', organizationId: 'org1' }, params: { id: 'x1' }, body: {}, ...extra }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSystemAdmin.mockReturnValue(false);
  mockHasPermission.mockReturnValue(true);
  mockCanWrite.mockReturnValue(true);
});

describe('GET /dashboards/deleted', () => {
  const MINE = { id: 'd1', name: 'Mine', orgId: 'org1', createdBy: 'u1', visibility: 'private', deletedAt: '2026-09-18T00:00:00Z' };
  const THEIRS = { id: 'd2', name: 'Someone else\'s', orgId: 'org1', createdBy: 'u2', visibility: 'private', deletedAt: '2026-09-17T00:00:00Z' };

  it('lists the tombstones the caller may restore', async () => {
    mockListDeletedDash.mockResolvedValue([MINE, THEIRS]);
    const res = makeRes();
    await listDeletedDashboards(req(), res);

    expect(res._status).toBe(200);
    expect(res._body.data.dashboards).toEqual([MINE, THEIRS]);
    // The listing is visibility-scoped in the service, with the caller's identity.
    expect(mockListDeletedDash).toHaveBeenCalledWith({ orgId: 'org1', userId: 'u1', isSuperAdmin: false });
  });

  it('hides a tombstone the caller could not actually restore', async () => {
    // Otherwise the panel offers a Restore that 403s after the password prompt.
    mockListDeletedDash.mockResolvedValue([MINE, THEIRS]);
    mockCanWrite.mockImplementation((row: any) => row.id === 'd1');

    const res = makeRes();
    await listDeletedDashboards(req(), res);

    expect(res._body.data.dashboards.map((d: any) => d.id)).toEqual(['d1']);
  });
});

describe('POST /dashboards/:id/purge', () => {
  const TOMB = { id: 'x1', name: 'Gone', orgId: 'org1', createdBy: 'u1', visibility: 'private' };

  it('hard-deletes the tombstone and audits it against the dashboard\'s own org', async () => {
    mockFindDeletedDash.mockResolvedValue(TOMB);
    mockPurgeDash.mockResolvedValue(true);

    const res = makeRes();
    await purgeDashboard(req(), res);

    expect(res._status).toBe(200);
    expect(mockPurgeDash).toHaveBeenCalledWith('x1');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'dashboard.purge', expect.objectContaining({
      targetId: 'x1', affectedOrgId: 'org1', details: { name: 'Gone' },
    }));
  });

  it('404s a live dashboard — purge only ever finalizes a soft-delete', async () => {
    mockFindDeletedDash.mockResolvedValue(null);

    const res = makeRes();
    await purgeDashboard(req(), res);

    expect(res._status).toBe(404);
    expect(mockPurgeDash).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('403s (without destroying anything) when the caller could not delete it', async () => {
    mockFindDeletedDash.mockResolvedValue(TOMB);
    mockCanWrite.mockReturnValue(false);

    const res = makeRes();
    await purgeDashboard(req(), res);

    expect(res._status).toBe(403);
    expect(mockPurgeDash).not.toHaveBeenCalled();
  });
});

describe('alert rules: deleted listing + purge', () => {
  it('lists this org\'s tombstones, org-scoped', async () => {
    mockListDeletedRules.mockResolvedValue([{ id: 'r1', name: 'Old rule', deletedAt: '2026-09-18T00:00:00Z' }]);

    const res = makeRes();
    await listDeletedAlertRules(req(), res);

    expect(mockListDeletedRules).toHaveBeenCalledWith('org1');
    expect(res._body.data.rules).toHaveLength(1);
  });

  it('purges a tombstone and audits the name', async () => {
    mockFindDeletedRule.mockResolvedValue({ id: 'x1', name: 'Old rule', orgId: 'org1' });
    mockPurgeRule.mockResolvedValue(true);

    const res = makeRes();
    await purgeAlertRule(req(), res);

    expect(res._status).toBe(200);
    expect(mockPurgeRule).toHaveBeenCalledWith('org1', 'x1');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.rule.purge', expect.objectContaining({
      targetId: 'x1', affectedOrgId: 'org1', details: { name: 'Old rule' },
    }));
  });

  it('404s when there is no tombstone for this org', async () => {
    mockFindDeletedRule.mockResolvedValue(null);

    const res = makeRes();
    await purgeAlertRule(req(), res);

    expect(res._status).toBe(404);
    expect(mockPurgeRule).not.toHaveBeenCalled();
  });
});

describe('alert destinations: deleted listing + purge', () => {
  it('masks the target on the deleted listing, exactly like the live one', async () => {
    mockListDeletedDests.mockResolvedValue([
      { id: 'dst1', label: 'Ops', channel: 'slack', target: 'https://hooks.slack.com/services/SECRET-TOKEN-VALUE', deletedAt: '2026-09-18T00:00:00Z' },
    ]);

    const res = makeRes();
    await listDeletedAlertDestinations(req(), res);

    const [row] = res._body.data.destinations;
    expect(mockListDeletedDests).toHaveBeenCalledWith('org1');
    expect(row.target).not.toContain('hooks.slack.com');
    expect(row.hasTarget).toBe(true);
  });

  it('purges a tombstone and audits metadata only — never the target', async () => {
    mockFindDeletedDest.mockResolvedValue({ id: 'x1', label: 'Ops', channel: 'slack', target: 'https://hooks.slack.com/services/SECRET', orgId: 'org1' });
    mockPurgeDest.mockResolvedValue(true);

    const res = makeRes();
    await purgeAlertDestination(req(), res);

    expect(res._status).toBe(200);
    expect(mockPurgeDest).toHaveBeenCalledWith('x1', 'org1');
    const [, action, entry] = mockAudit.mock.calls[0] as [unknown, string, any];
    expect(action).toBe('alert.destination.purge');
    expect(entry.details).toEqual({ channel: 'slack', label: 'Ops' });
    expect(JSON.stringify(entry)).not.toContain('SECRET');
  });

  it('404s when there is no tombstone for this org', async () => {
    mockFindDeletedDest.mockResolvedValue(null);

    const res = makeRes();
    await purgeAlertDestination(req(), res);

    expect(res._status).toBe(404);
    expect(mockPurgeDest).not.toHaveBeenCalled();
  });
});
