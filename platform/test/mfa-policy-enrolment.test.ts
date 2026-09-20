// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How many members could satisfy the MFA requirement today.
 *
 * `GET /organization/:id/mfa-policy` returns the policy AND this count, because
 * the admin reading it is choosing a grace period: the same "14 days" is
 * generous when everyone has already enrolled and a mass lockout when nobody
 * has, and the settings page had no number to show.
 *
 * Two things worth pinning: ENROLLED means what issuance means (a passkey or a
 * CONFIRMED authenticator enrolment), and someone holding both factors is ONE
 * person — a naive sum would report more enrolled members than members.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockMemberships = jest.fn<(...a: unknown[]) => Promise<Array<{ userId: unknown }>>>();
const mockPasskeyUserIds = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockTotpUserIds = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ isBootstrapExceptionOpen: async () => false }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
// The controller reaches config through the shared request validators; this
// suite is about a count, not about the service's environment.
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({
  DEFAULT_MFA_GRACE_DAYS: 14,
  // Re-exported by validation.js, which the controller pulls in transitively.
  MAX_MFA_GRACE_DAYS: 90,
  resolveEffectiveMfaPolicy: async () => ({
    requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false,
  }),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { exists: async () => true },
  User: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  UserOrganization: {
    find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockMemberships(...a) }) }),
  },
  WebAuthnCredential: { distinct: (...a: unknown[]) => mockPasskeyUserIds(...a) },
  UserTotp: { distinct: (...a: unknown[]) => mockTotpUserIds(...a) },
}));

const { getMfaPolicy } = await import('../src/controllers/org-mfa-policy.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

/**
 * `controller-helper` runs FOR REAL, so the READ gate (`canAdministerOrg`) is
 * satisfied by the FIXTURE: an admin/owner of the org named in `params.id`.
 */
const ORG_ADMIN = { sub: 'u1', organizationId: 'org1', role: 'admin' };
const req = (user: unknown = ORG_ADMIN) => ({ user, params: { id: 'org1' } }) as any;

/** Read the policy and return the enrolment block. */
async function read() {
  const res = makeRes();
  await getMfaPolicy(req(), res, jest.fn() as any);
  expect(res._status).toBe(200);
  return res._body.data.enrolment as { members: number; enrolled: number };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPasskeyUserIds.mockResolvedValue([]);
  mockTotpUserIds.mockResolvedValue([]);
});

describe('GET /organization/:id/mfa-policy — enrolment counts', () => {
  it('refuses a caller who does not administer the org, and counts nothing', async () => {
    // A plain member of org1: authenticated, but `isOrgAdmin` is false.
    mockMemberships.mockResolvedValue([{ userId: 'u1' }]);
    const res = makeRes();
    await getMfaPolicy(req({ sub: 'u9', organizationId: 'org1' }), res, jest.fn() as any);
    expect(res._status).toBe(403);
    expect(mockMemberships).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller with 401', async () => {
    const res = makeRes();
    await getMfaPolicy(req(null), res, jest.fn() as any);
    expect(res._status).toBe(401);
    expect(mockMemberships).not.toHaveBeenCalled();
  });

  it('counts active members and how many hold a factor', async () => {
    mockMemberships.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    mockPasskeyUserIds.mockResolvedValue(['u1']);
    mockTotpUserIds.mockResolvedValue(['u2']);

    expect(await read()).toEqual({ members: 3, enrolled: 2 });
  });

  it('counts a member with BOTH factors once', async () => {
    mockMemberships.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    mockPasskeyUserIds.mockResolvedValue(['u1']);
    mockTotpUserIds.mockResolvedValue(['u1']);

    // Not 2-of-2: only u1 can satisfy the requirement.
    expect(await read()).toEqual({ members: 2, enrolled: 1 });
  });

  it('reports nobody ready when the org is all password-only accounts', async () => {
    mockMemberships.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    expect(await read()).toEqual({ members: 2, enrolled: 0 });
  });

  it('asks nothing of the factor collections for an org with no members', async () => {
    mockMemberships.mockResolvedValue([]);
    expect(await read()).toEqual({ members: 0, enrolled: 0 });
    expect(mockPasskeyUserIds).not.toHaveBeenCalled();
    expect(mockTotpUserIds).not.toHaveBeenCalled();
  });

  it('only counts CONFIRMED authenticator enrolments', async () => {
    mockMemberships.mockResolvedValue([{ userId: 'u1' }]);
    await read();
    // A started-but-never-confirmed enrolment protects nothing, and issuance
    // does not accept it — so neither does this count.
    expect(mockTotpUserIds).toHaveBeenCalledWith('userId', expect.objectContaining({
      activatedAt: { $ne: null },
    }));
  });

  it('scopes both factor lookups to this org\'s members', async () => {
    mockMemberships.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    await read();
    expect(mockPasskeyUserIds).toHaveBeenCalledWith('userId', { userId: { $in: ['u1', 'u2'] } });
    expect(mockTotpUserIds).toHaveBeenCalledWith('userId', expect.objectContaining({
      userId: { $in: ['u1', 'u2'] },
    }));
  });
});
