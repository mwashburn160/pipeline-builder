// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * When a team's MFA or impersonation policy is tightened by its parent, the
 * policy responses name that parent (`inheritedFromName`) next to its id
 * (`inheritedFrom`), so the settings page needn't resolve an org the admin may
 * not be able to read. Absent when nothing is inherited.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMfaPolicy = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
const mockImpPolicy = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
const mockGetOrgName = jest.fn<(...a: unknown[]) => Promise<string | undefined>>();
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
// These reads are `canAdministerOrg`-gated and that gate runs FOR REAL (see
// helpers/controller-helper-mock.ts). The fixture below is a genuine
// PARENT-org admin reading its TEAM's policy, which is exactly the cross-org
// branch `canAdministerOrg` resolves by lazily importing this module — so
// `isAncestorOrg` is mocked alongside `getOrgName`: root IS an ancestor of team.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getOrgName: (...a: unknown[]) => mockGetOrgName(...a),
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
}));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ isBootstrapExceptionOpen: async () => false }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
// Only reached when the admin-actions policy changes; stubbed so its graph stays out.
jest.unstable_mockModule('../src/services/admin-mfa-claims.js', () => ({ refreshAdminPolicyClaims: jest.fn(async () => 0) }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({
  DEFAULT_MFA_GRACE_DAYS: 14,
  MAX_MFA_GRACE_DAYS: 90,
  resolveEffectiveMfaPolicy: (...a: unknown[]) => mockMfaPolicy(...a),
}));
jest.unstable_mockModule('../src/helpers/impersonation-policy.js', () => ({
  canSelectDeniedPolicy: async () => true,
  IMPERSONATION_POLICIES: ['open', 'consent', 'denied'],
  MIN_SYSADMINS_FOR_DENIED: 2,
  resolveEffectiveImpersonationPolicy: (...a: unknown[]) => mockImpPolicy(...a),
  resolveImpersonationPolicy: jest.fn(),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { exists: async () => true },
  User: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  UserOrganization: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  WebAuthnCredential: { distinct: async () => [] },
  UserTotp: { distinct: async () => [] },
}));

const { getMfaPolicy } = await import('../src/controllers/org-mfa-policy.js');
const { getImpersonationPolicy } = await import('../src/controllers/org-impersonation-policy.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
/**
 * A PARENT-org admin reading the policy of a descendant team: `role` is what
 * the real `isOrgAdmin` reads, and `root` → `team` is resolved through the
 * mocked `isAncestorOrg`. `user` is overridable for the negative cases.
 */
const req = (user: unknown = { sub: 'u1', organizationId: 'root', role: 'admin' }) =>
  ({ user, params: { id: 'team' } }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrgName.mockResolvedValue('Acme Root');
  mockIsAncestorOrg.mockResolvedValue(true);
});

describe('GET /organization/:id/mfa-policy — inheritedFromName', () => {
  it('names the parent that imposes the requirement', async () => {
    mockMfaPolicy.mockResolvedValue({ requireMfa: true, enforced: true, own: false, idpEnforcesMfa: false, inheritedFrom: 'root' });
    const res = makeRes();
    await getMfaPolicy(req(), res, jest.fn() as any);

    expect(res._status).toBe(200);
    expect(res._body.data).toMatchObject({ inheritedFrom: 'root', inheritedFromName: 'Acme Root' });
    expect(mockGetOrgName).toHaveBeenCalledWith('root');
  });

  it('omits it (and reads nothing) when the policy is the org\'s own', async () => {
    mockMfaPolicy.mockResolvedValue({ requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false });
    const res = makeRes();
    await getMfaPolicy(req(), res, jest.fn() as any);

    expect(res._body.data).not.toHaveProperty('inheritedFromName');
    expect(mockGetOrgName).not.toHaveBeenCalled();
  });
});

describe('GET /organization/:id/impersonation-policy — inheritedFromName', () => {
  it('names the parent whose stricter policy applies', async () => {
    mockImpPolicy.mockResolvedValue({ impersonationPolicy: 'denied', allowSelfApproval: false, own: { impersonationPolicy: 'open' }, inheritedFrom: 'root' });
    const res = makeRes();
    await getImpersonationPolicy(req(), res, jest.fn() as any);

    expect(res._status).toBe(200);
    expect(res._body.data).toMatchObject({ inheritedFrom: 'root', inheritedFromName: 'Acme Root', impersonationPolicy: 'denied' });
  });

  it('omits it when nothing is inherited', async () => {
    mockImpPolicy.mockResolvedValue({ impersonationPolicy: 'consent', allowSelfApproval: true });
    const res = makeRes();
    await getImpersonationPolicy(req(), res, jest.fn() as any);

    expect(res._body.data).not.toHaveProperty('inheritedFromName');
  });
});

/**
 * The reach these reads depend on is the PARENT → team one, so prove it is a
 * gate and not a formality: a caller who is not an admin of an ancestor org
 * gets 403 and the policy is never resolved.
 */
describe('policy reads — the canAdministerOrg gate', () => {
  it.each([
    ['an anonymous caller', null, 401],
    ['a plain member of the parent org', { sub: 'u2', organizationId: 'root' }, 403],
    ['an admin of an unrelated org', { sub: 'u3', organizationId: 'other', role: 'admin' }, 403],
  ] as const)('refuses %s', async (_label, user, status) => {
    // Nobody is anyone's ancestor for this block — the unrelated admin must be
    // refused by the hierarchy walk, not by a same-org shortcut.
    mockIsAncestorOrg.mockResolvedValue(false);

    for (const handler of [getMfaPolicy, getImpersonationPolicy]) {
      const res = makeRes();
      // `null`, not `undefined` — an explicit `undefined` would re-trigger the
      // parent-admin default parameter.
      await handler(req(user) as any, res, jest.fn() as any);
      expect(res._status).toBe(status);
    }
    expect(mockMfaPolicy).not.toHaveBeenCalled();
    expect(mockImpPolicy).not.toHaveBeenCalled();
  });
});
