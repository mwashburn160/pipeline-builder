// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/support-incidents — the handler bodies around the balance
 * helpers (which test/support-incidents.test.ts covers on their own).
 *
 * What is pinned here:
 *  - the balance is ACCOUNT-scoped: every route resolves the request org to its
 *    root first, so a team member's case spends the root's balance and an
 *    operator grant typed against a team lands where that case will look;
 *  - the root lookup fails CLOSED with a 503 (never spends/grants the wrong org);
 *  - grant validation bounds, the no-subscription 404, and the audit row.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();
const mockRecordAudit = jest.fn();
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendBadRequest: (res: unknown, msg: string, code: string) => mockSendError(res, 400, msg, code),
  requireAuth: passThrough,
  requireInternalService: () => passThrough,
  requirePermission: () => passThrough,
  requireSystemOrgPermission: () => [passThrough],
  requireStepUp: passThrough,
  getParam: (params: Record<string, string>, key: string) => params[key],
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (routeFn: (c: unknown) => Promise<unknown>) => async (req: { user?: { sub?: string; organizationId?: string } }, res: unknown) =>
    routeFn({ req, res, ctx: { log: jest.fn() }, orgId: req.user?.organizationId || '', userId: req.user?.sub || '' }),
}));

const mockResolveRoot = jest.fn<(orgId: string) => Promise<string>>();
jest.unstable_mockModule('../src/helpers/root-org-guard.js', () => ({ resolveAccountRootOrgId: mockResolveRoot }));

const mockGrant = jest.fn<(...a: unknown[]) => Promise<number | null>>();
const mockConsume = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockRefund = jest.fn<(...a: unknown[]) => Promise<number | null>>();
const mockRemaining = jest.fn<(...a: unknown[]) => Promise<number>>();
jest.unstable_mockModule('../src/helpers/support-incidents.js', () => ({
  MAX_INCIDENT_GRANT: 100,
  grantSupportIncidents: mockGrant,
  consumeSupportIncident: mockConsume,
  refundSupportIncident: mockRefund,
  supportIncidentsRemaining: mockRemaining,
}));

const { createSupportIncidentRoutes } = await import('../src/routes/support-incidents.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const router: any = createSupportIncidentRoutes();
function handler(method: string, routePath: string) {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
const call = (h: Function, req: any) => h({ params: {}, query: {}, body: {}, user: { sub: 'u-1', organizationId: 'team-1' }, ...req }, {});
/* eslint-enable @typescript-eslint/no-explicit-any */

const CONSUME = '/internal/support-incidents/:orgId/consume';
const REFUND = '/internal/support-incidents/:orgId/refund';
const GRANT = '/admin/orgs/:orgId/support-incidents';

beforeEach(() => {
  jest.clearAllMocks();
  // team-1 → its account root.
  mockResolveRoot.mockImplementation(async (id) => (id === 'team-1' ? 'root-1' : id));
  mockRemaining.mockResolvedValue(2);
});

describe('GET /support-incidents (the read surface)', () => {
  it("returns the ACCOUNT root's balance to a team member", async () => {
    await call(handler('get', '/support-incidents'), {});
    expect(mockResolveRoot).toHaveBeenCalledWith('team-1');
    expect(mockRemaining).toHaveBeenCalledWith('root-1');
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { balance: 2, accountOrgId: 'root-1' });
  });

  it('503s when the account cannot be resolved', async () => {
    mockResolveRoot.mockRejectedValueOnce(new Error('platform down'));
    await call(handler('get', '/support-incidents'), {});
    expect(mockSendError).toHaveBeenCalledWith({}, 503, expect.any(String), 'SERVICE_UNAVAILABLE');
    expect(mockRemaining).not.toHaveBeenCalled();
  });
});

describe('POST consume (message only)', () => {
  it("spends the ROOT's incident for a case opened from a team", async () => {
    mockConsume.mockResolvedValueOnce(true);
    mockRemaining.mockResolvedValueOnce(0);
    await call(handler('post', CONSUME), { params: { orgId: 'TEAM-1'.toLowerCase() } });
    expect(mockConsume).toHaveBeenCalledWith('root-1', 'service:message');
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { consumed: true, remaining: 0 });
  });

  it('answers consumed:false (200, not an error) when the account has none', async () => {
    mockConsume.mockResolvedValueOnce(false);
    await call(handler('post', CONSUME), { params: { orgId: 'root-1' } });
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { consumed: false, remaining: 2 });
  });

  it('fails CLOSED with 503 when the root lookup fails — nothing is spent', async () => {
    mockResolveRoot.mockRejectedValueOnce(new Error('cycle'));
    await call(handler('post', CONSUME), { params: { orgId: 'team-1' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 503, expect.any(String), 'SERVICE_UNAVAILABLE');
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('400s on a missing orgId', async () => {
    await call(handler('post', CONSUME), { params: { orgId: '' } });
    expect(mockSendError).toHaveBeenCalledWith({}, 400, 'orgId is required', 'MISSING_REQUIRED_FIELD');
  });
});

describe('POST refund (message only)', () => {
  it('gives the incident back to the root', async () => {
    mockRefund.mockResolvedValueOnce(3);
    await call(handler('post', REFUND), { params: { orgId: 'team-1' } });
    expect(mockRefund).toHaveBeenCalledWith('root-1', 'service:message');
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 200, { balance: 3 });
  });

  it('400s on a missing orgId', async () => {
    await call(handler('post', REFUND), { params: {} });
    expect(mockSendError).toHaveBeenCalledWith({}, 400, 'orgId is required', 'MISSING_REQUIRED_FIELD');
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

describe('POST /admin/orgs/:orgId/support-incidents (grant)', () => {
  const grantReq = (body: unknown, orgId = 'team-1') => ({ params: { orgId }, body, user: { sub: 'staff-1', organizationId: 'system' } });

  it.each([0, -1, 1.5, 101, '3', undefined])('rejects count %p with 400', async (count) => {
    await call(handler('post', GRANT), grantReq({ count }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, expect.stringMatching(/integer in 1\.\.100/), 'VALIDATION_ERROR');
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it('rejects a non-string note', async () => {
    await call(handler('post', GRANT), grantReq({ count: 1, note: 7 }));
    expect(mockSendError).toHaveBeenCalledWith({}, 400, 'note must be a string', 'VALIDATION_ERROR');
  });

  it('404s when the account holds no manageable subscription (no silent success)', async () => {
    mockGrant.mockResolvedValueOnce(null);
    await call(handler('post', GRANT), grantReq({ count: 2 }));
    expect(mockSendError).toHaveBeenCalledWith({}, 404, expect.any(String), 'NOT_FOUND');
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('grants to the ROOT of a team id and audits who, how many and the requested org', async () => {
    mockGrant.mockResolvedValueOnce(5);
    await call(handler('post', GRANT), grantReq({ count: 2, note: '  outage make-good  ' }));
    expect(mockGrant).toHaveBeenCalledWith('root-1', 2, expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'billing.support-incident.grant',
      affectedOrgId: 'root-1',
      targetId: 'root-1',
      details: { count: 2, balance: 5, requestedOrgId: 'team-1', note: 'outage make-good' },
    }));
    expect(mockSendSuccess).toHaveBeenCalledWith({}, 201, { balance: 5, accountOrgId: 'root-1' });
  });

  it('omits requestedOrgId when granted against the root directly', async () => {
    mockGrant.mockResolvedValueOnce(1);
    await call(handler('post', GRANT), grantReq({ count: 1 }, 'root-1'));
    const row = mockRecordAudit.mock.calls[0][0] as { details: Record<string, unknown> };
    expect(row.details).toEqual({ count: 1, balance: 1 });
  });

  it('503s rather than granting to the wrong org when the root lookup fails', async () => {
    mockResolveRoot.mockRejectedValueOnce(new Error('platform down'));
    await call(handler('post', GRANT), grantReq({ count: 1 }));
    expect(mockSendError).toHaveBeenCalledWith({}, 503, expect.any(String), 'SERVICE_UNAVAILABLE');
    expect(mockGrant).not.toHaveBeenCalled();
  });
});
