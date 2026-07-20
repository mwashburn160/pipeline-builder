// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SOFT-DELETE token chokepoint: `resolveMembership` (exercised via
 * `issueTokens`) must refuse to scope a token to a soft-deleted org, and the
 * fallback must skip soft-deleted orgs. Combined with the tokenVersion bump on
 * soft-delete, this cuts off ALL access without per-read filtering.
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
  User: { updateOne: jest.fn().mockResolvedValue({}) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUOFindOne(...a),
    find: (...a: unknown[]) => mockUOFind(...a),
  },
  Role: { find: jest.fn(emptyFindChain) },
  RoleAssignment: { find: jest.fn(emptyFindChain) },
}));

const { issueTokens } = await import('../src/utils/token.js');

function user() {
  return { _id: { toString: () => 'user-1' }, username: 'u', email: 'e@x.com', isEmailVerified: true, tokenVersion: 1 } as any;
}
/** findOne(...).lean() → membership. */
function findOneChain(membership: unknown) {
  return { lean: () => Promise.resolve(membership) };
}
/** find(...).sort(...).lean() → list. */
function findChain(list: unknown[]) {
  return { sort: () => ({ lean: () => Promise.resolve(list) }) };
}
/** findById(...).select(...).lean() → org doc. */
function orgChain(doc: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}
function orgIdOf(token: string): string | undefined {
  return (jwt.decode(token) as { organizationId?: string }).organizationId;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveMembership soft-delete chokepoint (via issueTokens)', () => {
  it('scopes the token to a LIVE org (baseline)', async () => {
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'admin', organizationId: 'org-live' }));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Live', deletedAt: null }));

    const { accessToken } = await issueTokens(user(), 'org-live');
    expect(orgIdOf(accessToken)).toBe('org-live');
  });

  it('REFUSES to scope a token to a soft-deleted org (falls through to none)', async () => {
    // Explicit active org is a member org, but it's soft-deleted.
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'admin', organizationId: 'org-dead' }));
    mockOrgFindById.mockReturnValue(orgChain({ name: 'Dead', deletedAt: new Date() }));
    // No other memberships to fall back to.
    mockUOFind.mockReturnValue(findChain([]));

    const { accessToken } = await issueTokens(user(), 'org-dead');
    // The token must NOT carry the soft-deleted org.
    expect(orgIdOf(accessToken)).toBeUndefined();
  });

  it('fallback skips a soft-deleted org and lands on the next LIVE membership', async () => {
    // Explicit active org is soft-deleted...
    mockUOFindOne.mockReturnValue(findOneChain({ role: 'admin', organizationId: 'org-dead' }));
    // ...fallback list has the dead org first, then a live one.
    mockUOFind.mockReturnValue(findChain([
      { organizationId: { toString: () => 'org-dead' }, role: 'admin' },
      { organizationId: { toString: () => 'org-live' }, role: 'member' },
    ]));
    mockOrgFindById.mockImplementation((id: string) =>
      orgChain(id === 'org-dead' ? { name: 'Dead', deletedAt: new Date() } : { name: 'Live', deletedAt: null }),
    );

    const { accessToken } = await issueTokens(user(), 'org-dead');
    expect(orgIdOf(accessToken)).toBe('org-live');
  });
});
