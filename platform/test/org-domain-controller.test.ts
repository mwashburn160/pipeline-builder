// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

// The real `canManageOrgScope` falls through to a lazy `org-hierarchy.js` import
// on the CROSS-ORG branch; stub the walk so the ancestor case is a decision, not
// a Mongoose round-trip.
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockAddDomain = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockListDomains = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIsEntitled = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockDecide = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSetSharing = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_s: unknown, body: unknown) => body,
  addDomainSchema: {},
  setDomainModeSchema: {},
  setDomainSharingSchema: {},
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
}));
jest.unstable_mockModule('../src/services/org-domain-service.js', () => ({
  orgDomainService: {
    addDomain: (...a: unknown[]) => mockAddDomain(...a),
    listDomains: (...a: unknown[]) => mockListDomains(...a),
    isEntitled: (...a: unknown[]) => mockIsEntitled(...a),
    decideJoinRequest: (...a: unknown[]) => mockDecide(...a),
    setDomainSharing: (...a: unknown[]) => mockSetSharing(...a),
  },
  VERIFY_RECORD_HOST: (domain: string) => `_pipeline-builder-verify.${domain}`,
  VERIFY_RECORD_VALUE: (token: string) => `pb-verify=${token}`,
}));

const { listOrgDomains, addOrgDomain, decideOrgJoinRequest, setOrgDomainSharing } = await import('../src/controllers/org-domain.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
/**
 * `controller-helper` runs FOR REAL, so `canManageOrgScope` is satisfied by the
 * FIXTURE, not by a stub: a caller whose active org is the one named in
 * `params.id`. The `org_settings:write` capability is the route's gate.
 */
const ORG_ADMIN = { sub: 'u1', organizationId: 'org-1', role: 'admin' };
/** Same org, no admin role, but a custom Role delegating `org_settings:write`. */
const DELEGATE = { sub: 'u2', organizationId: 'org-1', role: 'member', permissions: ['org_settings:write'] };

const req = (over: any = {}) => ({ user: ORG_ADMIN, params: { id: 'org-1' }, body: {}, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAncestorOrg.mockResolvedValue(false); // flat org tree by default
  mockIsEntitled.mockResolvedValue(true);
});

describe('org-domain controller', () => {
  it('addOrgDomain: admits a non-admin whose custom Role delegates org_settings:write', async () => {
    const res = makeRes();
    await (addOrgDomain as any)(req({ user: DELEGATE, body: { domain: 'acme.com' } }), res);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockAddDomain).toHaveBeenCalled();
  });

  it('addOrgDomain: 403 for an admin of a DIFFERENT org', async () => {
    const res = makeRes();
    await (addOrgDomain as any)(req({ user: { sub: 'u3', organizationId: 'org-other', role: 'admin' }, body: { domain: 'acme.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('addOrgDomain: 401 for an anonymous caller', async () => {
    const res = makeRes();
    await (addOrgDomain as any)(req({ user: undefined, body: { domain: 'acme.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('addOrgDomain: maps DOMAIN_TAKEN → 409', async () => {
    mockAddDomain.mockRejectedValue(new Error('DOMAIN_TAKEN'));
    const res = makeRes();
    await (addOrgDomain as any)(req({ body: { domain: 'acme.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('addOrgDomain: 201 + domain view on success', async () => {
    mockAddDomain.mockResolvedValue({ _id: 'd1', domain: 'acme.com', verified: false, verificationToken: 'tok', autoJoin: 'off' });
    const res = makeRes();
    await (addOrgDomain as any)(req({ body: { domain: 'acme.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = (res.json as jest.Mock<AnyFn>).mock.calls[0][0] as any;
    expect(body.data.domain.domain).toBe('acme.com');
    expect(body.data.domain.verification.value).toBe('pb-verify=tok'); // token exposed while unverified
  });

  it('listOrgDomains: 200 with domains + entitlement', async () => {
    mockListDomains.mockResolvedValue([{ _id: 'd1', domain: 'acme.com', verified: true, verificationToken: '', autoJoin: 'auto' }]);
    const res = makeRes();
    await (listOrgDomains as any)(req(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock<AnyFn>).mock.calls[0][0] as any;
    expect(body.data.entitled).toBe(true);
    expect(body.data.domains[0].verification).toBeUndefined(); // hidden once verified
  });

  it('decideOrgJoinRequest: 400 on an invalid decision', async () => {
    const res = makeRes();
    await (decideOrgJoinRequest as any)(req({ params: { id: 'org-1', reqId: 'r1', decision: 'bogus' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('decideOrgJoinRequest: approve → 200', async () => {
    mockDecide.mockResolvedValue({ userId: 'u2', status: 'approved' });
    const res = makeRes();
    await (decideOrgJoinRequest as any)(req({ params: { id: 'org-1', reqId: 'r1', decision: 'approve' } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDecide).toHaveBeenCalledWith('org-1', 'r1', 'approve', 'u1');
  });

  it('setOrgDomainSharing: shares a root domain with teams, audits it, and reports the flag', async () => {
    mockSetSharing.mockResolvedValue({ _id: 'd1', domain: 'acme.com', verified: true, verificationToken: 't', autoJoin: 'off', sharedWithTeams: true });
    const res = makeRes();
    await (setOrgDomainSharing as any)(req({ params: { id: 'org-1', domainId: 'd1' }, body: { sharedWithTeams: true } }), res);
    expect(mockSetSharing).toHaveBeenCalledWith('org-1', 'd1', true);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock<AnyFn>).mock.calls[0][0] as any;
    expect(body.data.domain.sharedWithTeams).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.domain.share', expect.objectContaining({
      affectedOrgId: 'org-1',
      details: { domain: 'acme.com', domainId: 'd1', sharedWithTeams: true },
    }));
  });

  it('setOrgDomainSharing: 403 for an admin of a DIFFERENT org', async () => {
    const res = makeRes();
    await (setOrgDomainSharing as any)(req({ user: { sub: 'u3', organizationId: 'org-other', role: 'admin' }, params: { id: 'org-1', domainId: 'd1' }, body: { sharedWithTeams: true } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSetSharing).not.toHaveBeenCalled();
  });

  it('setOrgDomainSharing: maps DOMAIN_SHARE_NOT_ROOT / DOMAIN_SHARE_UNVERIFIED → 409', async () => {
    for (const code of ['DOMAIN_SHARE_NOT_ROOT', 'DOMAIN_SHARE_UNVERIFIED']) {
      mockSetSharing.mockRejectedValueOnce(new Error(code));
      const res = makeRes();
      await (setOrgDomainSharing as any)(req({ params: { id: 'org-1', domainId: 'd1' }, body: { sharedWithTeams: true } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    }
    expect(mockAudit).not.toHaveBeenCalledWith(expect.anything(), 'org.domain.share', expect.anything());
  });

  it('listOrgDomains: sharedWithTeams defaults to false in the view', async () => {
    mockListDomains.mockResolvedValue([{ _id: 'd1', domain: 'acme.com', verified: true, verificationToken: '', autoJoin: 'off' }]);
    const res = makeRes();
    await (listOrgDomains as any)(req(), res);
    const body = (res.json as jest.Mock<AnyFn>).mock.calls[0][0] as any;
    expect(body.data.domains[0].sharedWithTeams).toBe(false);
  });
});
