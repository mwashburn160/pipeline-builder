// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the impersonation ORG PIN: `issueImpersonationToken` takes the
 * session's organization explicitly and resolves it STRICTLY.
 *
 * The distinction under test is the one that makes a pin a pin. The login path
 * (`resolveMembership`, exercised in token-soft-delete.test.ts) deliberately
 * FALLS BACK to another live membership when the requested org can't be scoped
 * to — correct when a person is signing in and their active org was just
 * soft-deleted. Impersonation must NOT do that: an operator who asked to view a
 * specific organization must never be silently landed in a different one.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      passwordMinLength: 8,
      jwt: { secret: 'test-jwt-secret', expiresIn: 7200, algorithm: 'HS256', tierExpiresIn: {} },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: 2592000 },
    },
  },
}));

const emptyFindChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });

const mockUOFindOne = jest.fn();
const mockUOFind = jest.fn();
const mockOrgFindById = jest.fn();

jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { updateOne: jest.fn().mockResolvedValue({}) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUOFindOne(...a),
    find: (...a: unknown[]) => mockUOFind(...a),
  },
  Role: { find: jest.fn(emptyFindChain) },
  RoleAssignment: { find: jest.fn(emptyFindChain) },
}));

const { issueImpersonationToken, signInAuth } = await import('../src/utils/token.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

/** The operator's own sign-in: an impersonation session inherits its assurance. */
const operatorAuth = signInAuth('pwd');

/* eslint-disable @typescript-eslint/no-explicit-any */
function target() {
  return {
    _id: { toString: () => 'target-user' },
    username: 'target',
    email: 'target@x.com',
    isEmailVerified: true,
    tokenVersion: 1,
  } as any;
}
/** findOne(...).lean() → membership. */
const findOneChain = (membership: unknown) => ({ lean: () => Promise.resolve(membership) });
/** find(...).sort(...).lean() → list. */
const findChain = (list: unknown[]) => ({ sort: () => ({ lean: () => Promise.resolve(list) }) });
/** findById(...).select(...).lean() → org doc. */
const orgChain = (doc: unknown) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

const claims = (t: string) =>
  jwt.decode(t) as { organizationId?: string; impersonatorId?: string; impersonationReadOnly?: boolean };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('issueImpersonationToken — organization pin', () => {
  it('pins the session to the org it was given', async () => {
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'member', organizationId: 'org-a' }));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Org A', deletedAt: null }));

    const { accessToken } = await issueImpersonationToken(target(), 'sysadmin-1', 'org-a', 'jti-1', operatorAuth);
    expect(claims(accessToken).organizationId).toBe('org-a');
  });

  it('does NOT fall back to another org when the pinned org has no membership', async () => {
    // No membership in the pinned org...
    mockUOFindOne.mockReturnValue(findOneChain(null));
    // ...but the user IS a live member elsewhere. The login path would land here;
    // impersonation must not, or the operator silently views the wrong tenant.
    mockUOFind.mockReturnValue(findChain([{ role: 'admin', organizationId: 'org-other' }]));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Other', deletedAt: null }));

    const { accessToken } = await issueImpersonationToken(target(), 'sysadmin-1', 'org-a', 'jti-1', operatorAuth);

    expect(claims(accessToken).organizationId).toBeUndefined();
    // The fallback query must not even be attempted.
    expect(mockUOFind).not.toHaveBeenCalled();
  });

  it('does NOT fall back when the pinned org is soft-deleted', async () => {
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'member', organizationId: 'org-a' }));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Org A', deletedAt: new Date() }));
    mockUOFind.mockReturnValue(findChain([{ role: 'admin', organizationId: 'org-other' }]));

    const { accessToken } = await issueImpersonationToken(target(), 'sysadmin-1', 'org-a', 'jti-1', operatorAuth);

    expect(claims(accessToken).organizationId).toBeUndefined();
    expect(mockUOFind).not.toHaveBeenCalled();
  });

  it('issues a token with no org context when no org is given', async () => {
    const { accessToken } = await issueImpersonationToken(target(), 'sysadmin-1', undefined, 'jti-1', operatorAuth);

    expect(claims(accessToken).organizationId).toBeUndefined();
    // An absent pin resolves to nothing rather than searching for an org.
    expect(mockUOFindOne).not.toHaveBeenCalled();
    expect(mockUOFind).not.toHaveBeenCalled();
  });

  it('still marks the token as a read-only impersonation of the target', async () => {
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'member', organizationId: 'org-a' }));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Org A', deletedAt: null }));

    const { accessToken, expiresIn } = await issueImpersonationToken(target(), 'sysadmin-1', 'org-a', 'jti-1', operatorAuth);

    expect(claims(accessToken).impersonatorId).toBe('sysadmin-1');
    expect(claims(accessToken).impersonationReadOnly).toBe(true);
    expect(expiresIn).toBe(15 * 60);
  });
});
