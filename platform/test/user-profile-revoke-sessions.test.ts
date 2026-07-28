// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: `userProfileService.revokeAllSessions` ("sign out everywhere")
 * must behave EXACTLY like auth logout — it now routes through the real
 * `authService.invalidateAllSessions`, so it MUST:
 *   - bump `tokenVersion` (via `$inc`),
 *   - CLEAR the stored `refreshToken` hash (via `$unset`), and
 *   - publish the revocation to the stateless services.
 *
 * Previously it called the model's `invalidateAllSessions()`, which only bumped
 * `tokenVersion` and left the refresh-token hash valid — a divergence from the
 * logout path masked only because refresh also re-checks `tokenVersion`. This
 * test imports the REAL auth-service (not a mock) so the actual `$unset` + publish
 * are asserted end-to-end, and confirms the returned doc carries the bumped
 * version for issuing a replacement token.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockPublishUser = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

// user-profile-service deps
jest.unstable_mockModule('../src/helpers/active-org-info.js', () => ({
  loadActiveOrgInfo: jest.fn(async () => ({ organizationName: null, activeOrgRole: null })),
}));

// Shared by BOTH user-profile-service and auth-service — the publisher under test.
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: (...a: unknown[]) => mockPublishUser(...a),
  publishUsersRevocation: jest.fn(async () => undefined),
}));

// auth-service deps (the real auth-service is imported below and must load).
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  seedDefaultRoles: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { auth: {} },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => unknown) => fn({ id: 'sess' }),
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({ hashRefreshToken: (t: string) => `hash:${t}` }));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
    updateOne: (...a: unknown[]) => mockUserUpdateOne(...a),
  },
  Organization: {},
  UserOrganization: {},
}));

const { userProfileService, PROFILE_USER_NOT_FOUND } = await import('../src/services/user-profile-service.js');

const selectResolving = (doc: unknown) => ({ select: () => Promise.resolve(doc) });

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateOne.mockResolvedValue(undefined);
});

describe('UserProfileService.revokeAllSessions — matches logout', () => {
  it('bumps tokenVersion, CLEARS the refreshToken hash, and publishes revocation', async () => {
    const userDoc = { _id: 'user-1', tokenVersion: 3, lastActiveOrgId: 'org-1', issuedTokens: [] };
    mockUserFindById.mockReturnValue(selectResolving(userDoc));

    const returned = await userProfileService.revokeAllSessions('user-1');

    // The authoritative write clears the refresh-token hash (the previously-missing
    // half) AND bumps the version — exactly what auth logout does.
    expect(mockUserUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: 'user-1' },
      { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
    );
    // Revocation is published so stateless services reject outstanding tokens.
    expect(mockPublishUser).toHaveBeenCalledTimes(1);
    expect(mockPublishUser).toHaveBeenCalledWith('user-1');
    // Returned doc carries the bumped version for minting the replacement token.
    expect(returned).toBe(userDoc);
    expect(returned.tokenVersion).toBe(4);
  });

  it('throws PROFILE_USER_NOT_FOUND without touching state when the user is gone', async () => {
    mockUserFindById.mockReturnValue(selectResolving(null));

    await expect(userProfileService.revokeAllSessions('ghost')).rejects.toThrow(PROFILE_USER_NOT_FOUND);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockPublishUser).not.toHaveBeenCalled();
  });
});
