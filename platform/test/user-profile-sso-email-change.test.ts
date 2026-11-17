// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `updateProfile` — a member of an "SSO required" org must not escape the policy
 * by changing their email off the enforced domain.
 *
 * Enforcement (`findSsoEnforcementForEmail`) keys on the CURRENT address's
 * domain only. Before this fix a member could PATCH their email to a personal
 * address, keep the membership, and sign in by password again. The change is
 * now refused while the current address is governed for an account the person
 * belongs to.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindSsoEnforcement = jest.fn<AnyFn>();
const mockHasMembershipInAccount = jest.fn<AnyFn>();
const mockFindByIdAndUpdate = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/services/user-ecosystem-privacy.js', () => ({ anonymizeUserEcosystemContent: jest.fn(async () => 0) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  findSsoEnforcementForEmail: (...a: unknown[]) => mockFindSsoEnforcement(...a),
}));
jest.unstable_mockModule('../src/helpers/account-membership.js', () => ({
  hasMembershipInAccount: (...a: unknown[]) => mockHasMembershipInAccount(...a),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {},
  RoleAssignment: {},
  User: {
    findById: () => ({ select: () => ({ lean: async () => ({ _id: 'u1', email: 'alice@bigcorp.example' }) }) }),
    findOne: async () => null,
    findByIdAndUpdate: (...a: unknown[]) => ({ lean: async () => mockFindByIdAndUpdate(...a) }),
  },
  UserOrganization: {},
  Organization: {},
  UserPreferences: {},
}));
for (const m of [
  '../src/services/api-key-service.js',
  '../src/services/auth-service.js',
  '../src/services/user-cascade.js',
  '../src/helpers/active-org-info.js',
  '../src/helpers/password-policy.js',
  '../src/helpers/session-revocation.js',
  '../src/utils/mongo-tx.js',
]) {
  jest.unstable_mockModule(m, () => ({
    apiKeyService: {},
    authService: {},
    deleteUserCascade: jest.fn(),
    loadActiveOrgInfo: jest.fn(async () => ({ organizationName: 'Org', activeOrgRole: 'member' })),
    assertNewPasswordAcceptable: jest.fn(),
    publishUserRevocation: jest.fn(),
    publishUserDeletionRevocation: jest.fn(),
    withMongoTransaction: jest.fn(),
  }));
}

const { userProfileService } = await import('../src/services/user-profile-service.js');
const { PROFILE_EMAIL_SSO_MANAGED } = await import('../src/services/user-errors.js');

const USER_ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  mockFindSsoEnforcement.mockReset().mockResolvedValue(null);
  mockHasMembershipInAccount.mockReset().mockResolvedValue(false);
  mockFindByIdAndUpdate.mockReset().mockResolvedValue({ _id: USER_ID, email: 'alice@personal.example' });
});

describe('updateProfile — email change under "SSO required"', () => {
  it('REFUSES moving a member off an SSO-enforced domain (the escape)', async () => {
    mockFindSsoEnforcement.mockResolvedValue({ orgId: 'org-big', provider: 'okta', protocol: 'oidc' });
    mockHasMembershipInAccount.mockResolvedValue(true);

    await expect(userProfileService.updateProfile(USER_ID, { email: 'alice@personal.example' }))
      .rejects.toThrow(PROFILE_EMAIL_SSO_MANAGED);
    // Enforcement is judged on the CURRENT address, membership on the enforcing account.
    expect(mockFindSsoEnforcement).toHaveBeenCalledWith('alice@bigcorp.example');
    expect(mockHasMembershipInAccount).toHaveBeenCalledWith(USER_ID, 'org-big');
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the account membership cannot be read', async () => {
    mockFindSsoEnforcement.mockResolvedValue({ orgId: 'org-big', provider: 'okta', protocol: 'oidc' });
    mockHasMembershipInAccount.mockRejectedValue(new Error('lineage unreadable'));

    await expect(userProfileService.updateProfile(USER_ID, { email: 'alice@personal.example' }))
      .rejects.toThrow(PROFILE_EMAIL_SSO_MANAGED);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('allows the change when the enforcing org is not one the person belongs to', async () => {
    mockFindSsoEnforcement.mockResolvedValue({ orgId: 'org-big', provider: 'okta', protocol: 'oidc' });

    const r = await userProfileService.updateProfile(USER_ID, { email: 'alice@personal.example' });
    expect(r.previousEmail).toBe('alice@bigcorp.example');
    expect(mockFindByIdAndUpdate).toHaveBeenCalled();
  });

  it('allows the change when the current address is not SSO-enforced', async () => {
    const r = await userProfileService.updateProfile(USER_ID, { email: 'alice@personal.example' });
    expect(r.previousEmail).toBe('alice@bigcorp.example');
    expect(mockHasMembershipInAccount).not.toHaveBeenCalled();
  });
});
