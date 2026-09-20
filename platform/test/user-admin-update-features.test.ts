// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: UserAdminService.updateFeatures must invalidate the target's
 * outstanding sessions.
 *
 * Resolved feature flags are baked into the access token (utils/token.ts), so a
 * feature grant/revoke via the admin `PUT /users/:id/features` endpoint has to
 * bump `tokenVersion` (so requireAuth rejects the old JWTs) AND publish the new
 * version to the stateless services — otherwise a revoked feature would keep
 * working until the token naturally expires. This mirrors the bump the
 * password/role edit paths already do.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockSave = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
const mockPublishUser = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockLoadActiveOrgInfo = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  assertActorMayAssignBuiltinAdmin: jest.fn(),
  assertNotLastPrivilegedMember: jest.fn(),
  assignBuiltinAdminRole: jest.fn(async () => true),
  ensureBaselineRole: jest.fn(async () => undefined),
  recomputeUserOrgRole: jest.fn(async () => undefined),
  removeBuiltinAdminRole: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({
  loadActiveOrgInfo: (...a: unknown[]) => mockLoadActiveOrgInfo(...a),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ seatCapacityAvailable: jest.fn(async () => true), seatCapacityStillWithinCap: jest.fn(async () => true), userHasSeatInAccount: jest.fn(async () => false) }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: (...a: unknown[]) => mockPublishUser(...a),
  publishUserDeletionRevocation: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
jest.unstable_mockModule('../src/utils/regex.js', () => ({ escapeRegex: (s: string) => s }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  JoinRequest: {},
  // The user-delete cascade also removes the account's passkeys.
  WebAuthnCredential: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  UserTotp: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })), exists: jest.fn(async () => null) },
  MfaRecoveryCodes: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  MfaResetRequest: { deleteMany: jest.fn(async () => ({ deletedCount: 0 })) },
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: {},
  UserOrganization: {},
  Role: {},
  RoleAssignment: {},
}));

// The password-policy helper reads platform config at import; these suites
// don't exercise password rules, so it is stubbed like the other services.
jest.unstable_mockModule('../src/helpers/password-policy.js', () => ({
  assertNewPasswordAcceptable: jest.fn(async () => undefined),
}));

const { userAdminService } = await import('../src/services/user-admin-service.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadActiveOrgInfo.mockResolvedValue({ organizationName: 'Acme', activeOrgRole: 'member', tier: 'developer' });
});

describe('UserAdminService.updateFeatures → session invalidation', () => {
  it('bumps tokenVersion and publishes the revocation after saving the overrides', async () => {
    const userDoc: any = {
      _id: 'user1',
      username: 'alice',
      email: 'a@x.io',
      isEmailVerified: true,
      isSuperAdmin: false,
      lastActiveOrgId: { toString: () => 'org1' },
      tokenVersion: 3,
      save: mockSave,
    };
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(userDoc) });

    const { user } = await userAdminService.updateFeatures('user1', { audit_log: true });

    // The override Map was applied...
    expect((user.featureOverrides as Map<string, boolean>).get('audit_log')).toBe(true);
    // ...tokenVersion was bumped (3 → 4) so requireAuth drops the old tokens...
    expect(user.tokenVersion).toBe(4);
    expect(mockSave).toHaveBeenCalledTimes(1);
    // ...and the new version was published to the stateless services.
    expect(mockPublishUser).toHaveBeenCalledTimes(1);
    expect(mockPublishUser).toHaveBeenCalledWith('user1');
  });
});
