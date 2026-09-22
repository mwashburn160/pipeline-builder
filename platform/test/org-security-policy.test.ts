// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org password-policy and authenticator-policy admin endpoints: tenancy,
 * loosening needs an `aal: 2` session, the AAGUID list is validated and
 * normalized, the admin can't lock themselves out of MFA, member compliance is
 * reported, and every change is audited with both sides.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { selectLean } from './helpers/query-chain.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type */
const YUBIKEY = 'cb69481e-8ff7-4039-93ec-0a2729a154a8';
const ICLOUD = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

const mockAudit = jest.fn<AnyFn>();
const mockRefuseWeak = jest.fn((_req: unknown, res: any, _o: unknown) => {
  res.status(403).json({ success: false, code: 'ASSURANCE_REQUIRED' });
  return true;
});
let orgDoc: Record<string, unknown> = {};
let lineage: Array<Record<string, unknown>> = [];
let mfaEnforced = false;
let creds: Array<{ _id: string; userId: string; name: string; aaguid?: string }> = [];
let callerHasTotp = false;
const mockUpdateOne = jest.fn(async (..._args: unknown[]) => ({}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) => res.status(status).json({ success: true, data, message }),
  refuseWeakSession: (...a: [unknown, any, unknown]) => mockRefuseWeak(...a),
  getParam: (params: Record<string, string>, key: string) => params[key],
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: async () => false, getOrgName: async (id: string) => `name-of-${id}` }));
jest.unstable_mockModule('../src/helpers/org-policy-lineage.js', () => ({ readOrgPolicyLineage: async () => lineage }));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({ DEFAULT_MFA_GRACE_DAYS: 14, resolveEffectiveMfaPolicy: async () => ({ enforced: mfaEnforced }) }));
jest.unstable_mockModule('../src/services/fido-mds.js', () => ({
  listModels: async () => [{ aaguid: YUBIKEY, description: 'YubiKey 5 Series', compromised: false }],
}));
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  PASSWORD_MAX_LENGTH: 128,
  resolveEffectivePasswordPolicy: async () => ({
    minLength: (orgDoc.passwordMinLength as number | undefined) ?? 8,
    ...(orgDoc.passwordMinLength ? { own: orgDoc.passwordMinLength } : {}),
    platformMinLength: 8,
  }),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    exists: async () => ({ _id: 'org-1' }),
    findById: () => selectLean(orgDoc),
    updateOne: (...a: unknown[]) => (mockUpdateOne as any)(...a),
  },
  UserOrganization: { find: () => selectLean([{ userId: 'u1' }, { userId: 'u2' }]) },
  WebAuthnCredential: {
    find: (f: { userId: unknown }) => selectLean(typeof f.userId === 'string' ? creds.filter((c) => c.userId === f.userId) : creds),
  },
  User: { find: () => selectLean([{ _id: 'u2', username: 'sam', email: 'sam@example.com' }]) },
  UserTotp: {
    distinct: async () => [],
    exists: async () => (callerHasTotp ? { _id: 't' } : null),
  },
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, b: unknown) => b,
  updatePasswordPolicySchema: {},
  updateAuthenticatorPolicySchema: {},
}));

const ctrl = await import('../src/controllers/org-security-policy.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}
// `controller-helper` runs FOR REAL: `canManageOrgScope` reads
// `user.organizationId`, so the caller's scope is the FIXTURE. The capability
// (`org:settings`) is the route's `requirePermission`, not re-checked here.
const admin = { sub: 'u1', organizationId: 'org-1', role: 'admin', aal: 1 };
/** Same org, no admin role, but a custom Role delegating `org:settings`. */
const delegate = { sub: 'u1', organizationId: 'org-1', role: 'member', permissions: ['org:settings'], aal: 1 };
/** An admin of an unrelated org. */
const outsider = { sub: 'u9', organizationId: 'org-2', role: 'admin', aal: 1 };
// `user` defaults to the org admin; pass `null` for an ANONYMOUS caller.
const req = (body: Record<string, unknown> = {}, user: unknown = admin) =>
  ({ user, params: { id: 'org-1' }, body, headers: {} }) as any;
async function run(handler: unknown, r: any) {
  const res = makeRes();
  await (handler as (q: any, s: any) => Promise<void>)(r, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  orgDoc = {};
  lineage = [{ _id: 'org-1' }];
  mfaEnforced = false;
  callerHasTotp = false;
  creds = [
    { _id: 'c1', userId: 'u1', name: 'Admin key', aaguid: YUBIKEY },
    { _id: 'c2', userId: 'u2', name: 'Phone', aaguid: ICLOUD },
  ];
});

describe('password policy', () => {
  it('refuses an org outside the caller\'s scope', async () => {
    const res = await run(ctrl.getPasswordPolicy, req({}, outsider));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses an anonymous caller, and writes nothing', async () => {
    const res = await run(ctrl.updatePasswordPolicy, req({ minLength: 14 }, null));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses an out-of-scope caller on the WRITE path, and writes nothing', async () => {
    const res = await run(ctrl.updatePasswordPolicy, req({ minLength: 14 }, outsider));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('admits a non-admin whose custom Role delegates org:settings (permission union, not the coarse role)', async () => {
    orgDoc = { passwordMinLength: 10 };
    const res = await run(ctrl.updatePasswordPolicy, req({ minLength: 14 }, delegate));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it('raising the minimum is open to a single-factor admin, and audited with both sides', async () => {
    orgDoc = { passwordMinLength: 10 };
    const res = await run(ctrl.updatePasswordPolicy, req({ minLength: 14 }));
    expect(mockRefuseWeak).not.toHaveBeenCalled();
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'org-1' }, { $set: { passwordMinLength: 14 } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.password_policy.update', expect.objectContaining({
      details: { minLength: { from: 10, to: 14 } },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('lowering or clearing it needs an aal 2 session', async () => {
    orgDoc = { passwordMinLength: 14 };
    const res = await run(ctrl.updatePasswordPolicy, req({ minLength: null }));
    expect(mockRefuseWeak).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe('authenticator policy', () => {
  it('reports names from MDS and the members whose passkeys the list would not accept', async () => {
    lineage = [{ _id: 'org-1', allowedAuthenticatorAaguids: [YUBIKEY] }];
    const res = await run(ctrl.getAuthenticatorPolicy, req());
    const data = res.json.mock.calls[0][0].data;
    expect(data.effective).toEqual([{ aaguid: YUBIKEY, model: 'YubiKey 5 Series' }]);
    expect(data.mds.available).toBe(true);
    expect(data.compliance.nonCompliant).toEqual([
      expect.objectContaining({ email: 'sam@example.com', passkeys: [expect.objectContaining({ name: 'Phone', aaguid: ICLOUD })] }),
    ]);
    expect(data.compliance.modelsInUse).toEqual(expect.arrayContaining([expect.objectContaining({ aaguid: YUBIKEY, model: 'YubiKey 5 Series' })]));
  });

  it('refuses anything that is not an AAGUID (and the all-zero one)', async () => {
    const res = await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: ['yubikey', '00000000-0000-0000-0000-000000000000'] }));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_AAGUID');
  });

  it('stores a normalized, de-duplicated list and audits what was added', async () => {
    await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: [YUBIKEY.toUpperCase(), YUBIKEY] }));
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'org-1' }, { $set: { allowedAuthenticatorAaguids: [YUBIKEY] } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.authenticator_policy.update', expect.objectContaining({
      details: expect.objectContaining({ added: [YUBIKEY], removed: [] }),
    }));
  });

  it('widening or clearing an existing list needs an aal 2 session', async () => {
    orgDoc = { allowedAuthenticatorAaguids: [YUBIKEY] };
    const res = await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: [] }));
    expect(mockRefuseWeak).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses a list that would strip the admin of every accepted factor where MFA is enforced', async () => {
    mfaEnforced = true;
    const res = await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: [ICLOUD] }));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('AUTHENTICATOR_POLICY_LOCKOUT');
    expect(mockUpdateOne).not.toHaveBeenCalled();

    // …but the admin's own model on the list, or an authenticator app, is fine.
    const ok = await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: [YUBIKEY] }));
    expect(ok.status).toHaveBeenCalledWith(200);
    callerHasTotp = true;
    const alsoOk = await run(ctrl.updateAuthenticatorPolicy, req({ allowedAaguids: [ICLOUD] }));
    expect(alsoOk.status).toHaveBeenCalledWith(200);
  });
});
