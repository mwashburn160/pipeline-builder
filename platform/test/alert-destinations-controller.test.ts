// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `listAllAlertDestinations` — the sysadmin-only cross-tenant
 * destinations view.
 *
 * The controller's contract: gate on sysadmin, escape RLS via
 * `runWithTenantContext({ isSuperAdmin: true })`, mask every row's
 * target before returning. The masking matters — Slack hook URLs are
 * bearer-equivalent secrets and the sysadmin's view does NOT entitle
 * them to read tenant secrets back in plaintext.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockListAll = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockRunWithTenantContext = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  sendQuotaExceeded: jest.fn(),
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

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  runWithTenantContext: (ctx: unknown, fn: () => unknown) => {
    mockRunWithTenantContext(ctx);
    return fn();
  },
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  isSystemAdmin: (req: any) => mockIsSystemAdmin(req),
  isOrgAdmin: jest.fn(),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
  requireOrgMembership: (req: any) => req.user?.organizationId ?? null,
  requireAuthContext: (req: any) =>
    req.user?.sub && req.user?.organizationId ? { userId: req.user.sub, orgId: req.user.organizationId } : null,
}));

jest.unstable_mockModule('../src/services/alert-destination-service.js', () => ({
  alertDestinationService: {
    listAllAcrossOrgs: (...a: unknown[]) => mockListAll(...a),
    listForOrg: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findById: jest.fn(),
    findForDelivery: jest.fn(),
  },
  // The real mask returns "••••<last 12 chars>". Match so we can assert the
  // controller actually invoked toApiDestination (and didn't leak raw target).
  toApiDestination: (d: { target: string }) => ({ ...d, target: '••••' + d.target.slice(-12), hasTarget: !!d.target }),
}));

jest.unstable_mockModule('../src/services/alert-relay.js', () => ({ relayWebhook: jest.fn() }));
jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  reserveFeatureQuota: jest.fn(),
  releaseFeatureQuota: jest.fn(),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: {} }));

const { listAllAlertDestinations } = await import('../src/controllers/alert-destinations.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockListAll.mockReset();
  mockIsSystemAdmin.mockReset();
  mockRunWithTenantContext.mockReset();
});

describe('listAllAlertDestinations', () => {
  it('returns 403 when caller is not a sysadmin', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = mockRes();
    await (listAllAlertDestinations as unknown as (req: any, res: any) => Promise<void>)({}, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockListAll).not.toHaveBeenCalled();
  });

  it('runs the cross-tenant query inside a sysadmin tenant context', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    mockListAll.mockResolvedValue([]);

    const res = mockRes();
    await (listAllAlertDestinations as unknown as (req: any, res: any) => Promise<void>)({}, res);

    // Crucial: the RLS context must be the superadmin variant — without it,
    // the cross-tenant SELECT would be blocked once RLS is enforced.
    expect(mockRunWithTenantContext).toHaveBeenCalledWith({ isSuperAdmin: true });
    expect(mockListAll).toHaveBeenCalled();
  });

  it('masks targets in the response', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    mockListAll.mockResolvedValue([
      { id: 'd1', orgId: 'org-a', target: 'https://hooks.slack.com/services/T00/B00/PREFIXSECRET', label: 'oncall' },
      { id: 'd2', orgId: 'org-b', target: 'https://example.com/webhook/MIDDLEKEY_TAILBYTES', label: 'platform' },
    ]);
    const res = mockRes();
    await (listAllAlertDestinations as unknown as (req: any, res: any) => Promise<void>)({}, res);

    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.destinations).toHaveLength(2);
    for (const d of payload.destinations) {
      expect(d.target.startsWith('••••')).toBe(true);
      // Mask preserves the last 12 chars (operator identifier), so check that
      // the leading host / path / middle bytes are hidden — that's the
      // actual security boundary, not the trailing identifier.
      expect(d.target).not.toContain('hooks.slack.com');
      expect(d.target).not.toContain('example.com');
      expect(d.target).not.toContain('MIDDLEKEY');
    }
  });
});
