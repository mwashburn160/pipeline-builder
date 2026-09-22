// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/ecosystem/*`: the
 * Verified-eligibility facts (DNS-verified domains, owners' second factors) and
 * the Ecosystem Manager approver count, as the plugin service reads them. The
 * models are stubbed; the input validation and the fact gathering run for real.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const mockDomainFind = jest.fn<(...a: unknown[]) => unknown>();
const mockMemberFind = jest.fn<(...a: unknown[]) => unknown>();
const mockHasFactor = jest.fn<(userId: string) => Promise<boolean>>();
const mockCount = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('mongoose', () => {
  class ObjectId { v: string; constructor(v: string) { this.v = v; } toString() { return this.v; } static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); } }
  const api = { Types: { ObjectId } };
  return { ...api, default: api };
});
const chain = (fn: (...a: unknown[]) => unknown) => ({
  find: (...a: unknown[]) => {
    const c = { select: () => c, lean: () => Promise.resolve(fn(...a)) };
    return c;
  },
});
jest.unstable_mockModule('../src/models/index.js', () => ({
  OrgDomain: chain(mockDomainFind),
  UserOrganization: chain(mockMemberFind),
}));
jest.unstable_mockModule('../src/helpers/auth-factors.js', () => ({ hasAnyMfaFactor: mockHasFactor }));
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({ countEcosystemApprovers: mockCount }));

const { getEcosystemApprovers, getPublisherEligibility } = await import('../src/controllers/ecosystem-internal.js');
const { publisherEligibilityFacts } = await import('../src/services/publisher-eligibility.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const body = (res: any) => res.json.mock.calls[0][0];

beforeEach(() => {
  mockDomainFind.mockReset().mockReturnValue([{ domain: 'Acme.dev' }, { domain: 'acme.io' }, { domain: 'acme.dev' }]);
  mockMemberFind.mockReset().mockReturnValue([{ userId: 'owner1' }, { userId: 'owner2' }, { userId: null }]);
  mockHasFactor.mockReset().mockImplementation(async (u) => u === 'owner1');
  mockCount.mockReset().mockResolvedValue({ holders: 3, eligible: 2, superadmins: 1 });
});

describe('publisherEligibilityFacts', () => {
  it('returns the VERIFIED domains (lowercased, de-duplicated) and how many active owners have a second factor', async () => {
    expect(await publisherEligibilityFacts(ORG)).toEqual({ verifiedDomains: ['acme.dev', 'acme.io'], owners: 2, ownersWithMfa: 1 });
    expect(mockDomainFind).toHaveBeenCalledWith({ organizationId: ORG, verified: true });
    expect(mockMemberFind).toHaveBeenCalledWith(expect.objectContaining({ isActive: true, role: 'owner' }));
  });

  it('an org with nothing verified and no owners reports zeros', async () => {
    mockDomainFind.mockReturnValue([]);
    mockMemberFind.mockReturnValue([]);
    expect(await publisherEligibilityFacts(ORG)).toEqual({ verifiedDomains: [], owners: 0, ownersWithMfa: 0 });
  });
});

describe('GET /internal/ecosystem/publisher-eligibility/:orgId', () => {
  it('answers the facts for a valid org id', async () => {
    const res = mockRes();
    await getPublisherEligibility({ params: { orgId: ORG.toUpperCase() } } as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res).data).toEqual({ verifiedDomains: ['acme.dev', 'acme.io'], owners: 2, ownersWithMfa: 1 });
    expect(mockDomainFind).toHaveBeenCalledWith({ organizationId: ORG, verified: true });
  });

  it('400s on a malformed org id without touching the directory', async () => {
    const res = mockRes();
    await getPublisherEligibility({ params: { orgId: 'nope' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDomainFind).not.toHaveBeenCalled();
  });
});

describe('GET /internal/ecosystem/approvers', () => {
  it('counts approvers for a decision permission, passing the conflicts through', async () => {
    const res = mockRes();
    await getEcosystemApprovers({ query: { permission: 'plugins:moderate', excludeOrgIds: `${ORG.toUpperCase()},${ORG}`, excludeUserIds: 'u1, u2' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res).data).toEqual({ holders: 3, eligible: 2, superadmins: 1 });
    expect(mockCount).toHaveBeenCalledWith('plugins:moderate', { memberOfOrgIds: [ORG], userIds: ['u1', 'u2'] });
  });

  it('accepts no exclusions', async () => {
    const res = mockRes();
    await getEcosystemApprovers({ query: { permission: 'publishers:verify' } } as any, res);
    expect(mockCount).toHaveBeenCalledWith('publishers:verify', { memberOfOrgIds: [], userIds: [] });
  });

  it.each([
    [{ permission: 'plugins:write' }],
    [{}],
    [{ permission: 'plugins:moderate', excludeOrgIds: 'not-an-org' }],
    [{ permission: 'plugins:moderate', excludeUserIds: ['a', 'b'] }],
    [{ permission: 'plugins:moderate', excludeUserIds: Array.from({ length: 21 }, (_, i) => `u${i}`).join(',') }],
  ])('400s on %p', async (query) => {
    const res = mockRes();
    await getEcosystemApprovers({ query } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCount).not.toHaveBeenCalled();
  });
});
