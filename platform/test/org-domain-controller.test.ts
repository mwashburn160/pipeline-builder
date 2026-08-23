// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCanAdminister = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockAddDomain = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockListDomains = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIsEntitled = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockDecide = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string) => { res.status(status).json({ success: false, message }); return res; },
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_s: unknown, body: unknown) => body,
  addDomainSchema: {}, setDomainModeSchema: {},
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuth: (req: any, res: any) => { if (!req.user) { res.status(401).json({ success: false }); return false; } return true; },
  canAdministerOrg: (...a: unknown[]) => mockCanAdminister(...a),
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try { return await fn(req, res); } catch (e: any) {
        const mapped = errorMap?.[e?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, message: mapped.message });
        return res.status(500).json({ success: false, message: e?.message });
      }
    },
}));
jest.unstable_mockModule('../src/services/org-domain-service.js', () => ({
  orgDomainService: {
    addDomain: (...a: unknown[]) => mockAddDomain(...a),
    listDomains: (...a: unknown[]) => mockListDomains(...a),
    isEntitled: (...a: unknown[]) => mockIsEntitled(...a),
    decideJoinRequest: (...a: unknown[]) => mockDecide(...a),
  },
  DOMAIN_TAKEN: 'DOMAIN_TAKEN', DOMAIN_NOT_FOUND: 'DOMAIN_NOT_FOUND', DOMAIN_NOT_VERIFIED: 'DOMAIN_NOT_VERIFIED',
  DOMAIN_VERIFY_FAILED: 'DOMAIN_VERIFY_FAILED', DOMAIN_NOT_ENTITLED: 'DOMAIN_NOT_ENTITLED', DOMAIN_LIMIT: 'DOMAIN_LIMIT',
  DOMAIN_PUBLIC: 'DOMAIN_PUBLIC', JOIN_NOT_ELIGIBLE: 'JOIN_NOT_ELIGIBLE', JOIN_REQUEST_NOT_FOUND: 'JOIN_REQUEST_NOT_FOUND',
  JOIN_SEAT_LIMIT: 'JOIN_SEAT_LIMIT',
  VERIFY_RECORD_HOST: (domain: string) => `_pipeline-builder-verify.${domain}`,
  VERIFY_RECORD_VALUE: (token: string) => `pb-verify=${token}`,
}));

const { listOrgDomains, addOrgDomain, decideOrgJoinRequest } = await import('../src/controllers/org-domain.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const req = (over: any = {}) => ({ user: { sub: 'u1' }, params: { id: 'org-1' }, body: {}, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockCanAdminister.mockResolvedValue(true);
  mockIsEntitled.mockResolvedValue(true);
});

describe('org-domain controller', () => {
  it('addOrgDomain: 403 when the caller does not administer the org', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = makeRes();
    await (addOrgDomain as any)(req({ body: { domain: 'acme.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
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
    const body = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(body.data.domain.domain).toBe('acme.com');
    expect(body.data.domain.verification.value).toBe('pb-verify=tok'); // token exposed while unverified
  });

  it('listOrgDomains: 200 with domains + entitlement', async () => {
    mockListDomains.mockResolvedValue([{ _id: 'd1', domain: 'acme.com', verified: true, verificationToken: '', autoJoin: 'auto' }]);
    const res = makeRes();
    await (listOrgDomains as any)(req(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0] as any;
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
});
