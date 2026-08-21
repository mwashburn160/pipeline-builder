// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `updateOrganizationSeatLimit`'s feature-flag WHITELIST validation.
 *
 * The `features[]` this endpoint persists lands on the account ROOT and is
 * propagated to every descendant team; an unknown/junk flag would perpetually
 * trip billing's entitlement-drift reconciler and pollute `featureEntitlements`.
 * The controller therefore rejects (400) any value that isn't a canonical
 * feature flag (api-core `isValidFeatureFlag`) BEFORE calling setSeatLimit —
 * defense-in-depth against a caller injecting bogus flags.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSetSeatLimit = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSetTier = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCheckTierOvercap = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  // Service-principal gate passes so we reach the body validation.
  isServicePrincipal: () => true,
  sendError: (res: any, status: number, message: string, code?: string, details?: unknown) =>
    res.status(status).json({ success: false, message, code, details }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (_req: any, _res: any) => true,
  requireAuth: (_req: any, _res: any) => true,
  canAccessOrg: jest.fn(),
  canAdministerOrg: jest.fn(),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => {
      try {
        await fn(req, res);
      } catch {
        return res.status(500).json({ success: false, message: 'error' });
      }
    },
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: jest.fn() }));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn(), pooledFeatureEntitlements: jest.fn() }));

jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: {
    setSeatLimit: (...a: unknown[]) => mockSetSeatLimit(...a),
    setTier: (...a: unknown[]) => mockSetTier(...a),
    checkTierOvercap: (...a: unknown[]) => mockCheckTierOvercap(...a),
  },
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  SYSTEM_ORG_DELETE_FORBIDDEN: 'SYSTEM_ORG_DELETE_FORBIDDEN',
  ORG_SLUG_TAKEN: 'ORG_SLUG_TAKEN',
  ORG_AI_KEY_TOO_LONG: 'ORG_AI_KEY_TOO_LONG',
  changedAiProviderFields: () => [],
}));

jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  softDeleteOrg: jest.fn(),
  exportOrg: jest.fn(),
  ORG_ALREADY_DELETED: 'ORG_ALREADY_DELETED',
  ORG_SNAPSHOT_FAILED: 'ORG_SNAPSHOT_FAILED',
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  createOrganizationSchema: {},
  updateOrganizationSchema: {},
  updateOrgIdentitySchema: {},
  updateQuotasSchema: {},
}));

const { updateOrganizationSeatLimit, updateOrganizationTier } = await import('../src/controllers/organization.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const call = updateOrganizationSeatLimit as unknown as (req: any, res: any) => Promise<void>;
const req = (body: unknown) => ({ user: { sub: 'svc', isSuperAdmin: true }, params: { id: 'root-1' }, body });

beforeEach(() => {
  jest.clearAllMocks();
  mockSetSeatLimit.mockResolvedValue({ rootOrgId: 'root-1', seats: 5 });
  mockCheckTierOvercap.mockResolvedValue([]);
});

describe('updateOrganizationSeatLimit — feature-flag whitelist', () => {
  it('rejects an unknown feature flag with 400 and does NOT persist', async () => {
    const res = mockRes();

    await call(req({ seats: 5, features: ['sso', 'not_a_real_flag'] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSeatLimit).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('accepts a fully-valid feature set and persists it', async () => {
    const res = mockRes();

    await call(req({ seats: 5, features: ['sso', 'advanced_reporting'] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetSeatLimit).toHaveBeenCalledWith('root-1', 5, ['sso', 'advanced_reporting'], undefined);
  });

  it('still rejects the array-of-strings shape check (non-string entry) with 400', async () => {
    const res = mockRes();

    await call(req({ seats: 5, features: ['sso', 123] }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSeatLimit).not.toHaveBeenCalled();
  });

  it('permits a seat-only update (no features) unchanged', async () => {
    const res = mockRes();

    await call(req({ seats: 8 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetSeatLimit).toHaveBeenCalledWith('root-1', 8, undefined, undefined);
  });

  it('passes a valid tier through to setSeatLimit (billing tier push)', async () => {
    const res = mockRes();

    await call(req({ seats: 5, tier: 'pro' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetSeatLimit).toHaveBeenCalledWith('root-1', 5, undefined, 'pro');
  });

  it('rejects an unknown tier with 400 and does NOT persist', async () => {
    const res = mockRes();

    await call(req({ seats: 5, tier: 'platinum' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSetSeatLimit).not.toHaveBeenCalled();
  });

  it('records the features added/removed DELTA in the audit (DORA grant/revoke reconstructable)', async () => {
    const res = mockRes();
    mockSetSeatLimit.mockResolvedValue({
      rootOrgId: 'root-1',
      seats: 5,
      featureDelta: { added: ['advanced_reporting'], removed: ['sso'] },
    });

    await call(req({ seats: 5, features: ['advanced_reporting'] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const auditDetails = (mockAudit.mock.calls[0][2] as any).details;
    expect(auditDetails.featuresAdded).toEqual(['advanced_reporting']);
    expect(auditDetails.featuresRemoved).toEqual(['sso']);
    expect(auditDetails.features).toEqual(['advanced_reporting']);
  });

  it('omits the delta fields when the entitlement set did not change (empty delta)', async () => {
    const res = mockRes();
    mockSetSeatLimit.mockResolvedValue({
      rootOrgId: 'root-1',
      seats: 5,
      featureDelta: { added: [], removed: [] },
    });

    await call(req({ seats: 5, features: ['sso'] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const auditDetails = (mockAudit.mock.calls[0][2] as any).details;
    expect(auditDetails.featuresAdded).toBeUndefined();
    expect(auditDetails.featuresRemoved).toBeUndefined();
  });
});

describe('updateOrganizationTier — audit records lost features on a downgrade', () => {
  const tierCall = updateOrganizationTier as unknown as (req: any, res: any) => Promise<void>;
  const tierReq = (body: unknown) => ({ user: { sub: 'svc', isSuperAdmin: true }, params: { id: 'root-1' }, body });

  it('records featuresRemoved in the admin.org.tier.update audit on a downgrade (mirrors setSeatLimit)', async () => {
    const res = mockRes();
    mockSetTier.mockResolvedValue({
      id: 'root-1',
      previousTier: 'team',
      tier: 'pro',
      featuresRemoved: ['audit_log', 'sso'],
    });

    await tierCall(tierReq({ tier: 'pro' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const auditCall = mockAudit.mock.calls.find((c) => c[1] === 'admin.org.tier.update');
    expect(auditCall).toBeDefined();
    const auditDetails = (auditCall![2] as any).details;
    expect(auditDetails.previousTier).toBe('team');
    expect(auditDetails.tier).toBe('pro');
    expect(auditDetails.featuresRemoved).toEqual(['audit_log', 'sso']);
  });

  it('omits featuresRemoved on an upgrade (service returns none)', async () => {
    const res = mockRes();
    mockSetTier.mockResolvedValue({ id: 'root-1', previousTier: 'pro', tier: 'team' });

    await tierCall(tierReq({ tier: 'team' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const auditCall = mockAudit.mock.calls.find((c) => c[1] === 'admin.org.tier.update');
    const auditDetails = (auditCall![2] as any).details;
    expect(auditDetails.featuresRemoved).toBeUndefined();
  });
});
