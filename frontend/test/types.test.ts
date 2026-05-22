// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin, isOrgAdmin, User } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    username: 'testuser',
    email: 'test@example.com',
    role: 'member',
    isEmailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isSystemAdmin', () => {
  // Sysadmin authority now keys on the `isSuperAdmin` flag carried in the
  // JWT. The legacy "user is admin/owner in the well-known 'system' org"
  // branch was removed alongside the backend cutover.

  it('returns true when isSuperAdmin is true, regardless of role', () => {
    expect(isSystemAdmin(mockUser({ role: 'member', isSuperAdmin: true }))).toBe(true);
    expect(isSystemAdmin(mockUser({ role: 'admin', isSuperAdmin: true }))).toBe(true);
    expect(isSystemAdmin(mockUser({ role: 'owner', isSuperAdmin: true }))).toBe(true);
  });

  it('returns true even when active org is a regular customer org', () => {
    expect(isSystemAdmin(mockUser({
      role: 'member', organizationId: 'org-acme', isSuperAdmin: true,
    }))).toBe(true);
  });

  it('returns false when isSuperAdmin is unset / false', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(false);
    expect(isSystemAdmin(mockUser({ role: 'owner', organizationName: 'system' }))).toBe(false);
    expect(isSystemAdmin(mockUser({ role: 'admin', isSuperAdmin: false }))).toBe(false);
  });

  it('returns false for null user', () => {
    expect(isSystemAdmin(null)).toBe(false);
  });
});

describe('isOrgAdmin', () => {
  it('returns true for admin in a regular org (not a sysadmin)', () => {
    expect(isOrgAdmin(mockUser({ role: 'admin', organizationId: 'org-1' }))).toBe(true);
  });

  it('returns true for owner in a regular org', () => {
    expect(isOrgAdmin(mockUser({ role: 'owner', organizationId: 'org-1' }))).toBe(true);
  });

  it('returns false when the user is also a sysadmin', () => {
    // The UI typically wants org-admin affordances rendered separately
    // from operator affordances, so sysadmins shouldn't double-count.
    expect(isOrgAdmin(mockUser({ role: 'admin', organizationId: 'org-1', isSuperAdmin: true }))).toBe(false);
  });

  it('returns false for member role', () => {
    expect(isOrgAdmin(mockUser({ role: 'member', organizationId: 'org-1' }))).toBe(false);
  });

  it('returns false for null user', () => {
    expect(isOrgAdmin(null)).toBe(false);
  });
});
