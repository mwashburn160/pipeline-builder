// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemOrg, isSystemAdmin, isOrgAdmin, User } from '../src/types';

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

describe('isSystemOrg', () => {
  it('should return true for user with system organizationId', () => {
    expect(isSystemOrg(mockUser({ organizationId: 'system' }))).toBe(true);
  });

  it('should return true for user with system organizationName', () => {
    expect(isSystemOrg(mockUser({ organizationName: 'system' }))).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isSystemOrg(mockUser({ organizationId: 'System' }))).toBe(true);
    expect(isSystemOrg(mockUser({ organizationName: 'SYSTEM' }))).toBe(true);
  });

  it('should return true regardless of role', () => {
    expect(isSystemOrg(mockUser({ role: 'member', organizationId: 'system' }))).toBe(true);
    expect(isSystemOrg(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(true);
    expect(isSystemOrg(mockUser({ role: 'owner', organizationId: 'system' }))).toBe(true);
  });

  it('should return false for non-system org', () => {
    expect(isSystemOrg(mockUser({ organizationId: 'org-1' }))).toBe(false);
  });

  it('should return false for null user', () => {
    expect(isSystemOrg(null)).toBe(false);
  });

  it('should return false when organizationId and organizationName are undefined', () => {
    expect(isSystemOrg(mockUser())).toBe(false);
  });
});

describe('isSystemAdmin', () => {
  it('should return true for admin with system organizationId', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(true);
  });

  it('should return true for admin with system organizationName', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationName: 'system' }))).toBe(true);
  });

  it('should return true for owner in system org', () => {
    expect(isSystemAdmin(mockUser({ role: 'owner', organizationId: 'system' }))).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'System' }))).toBe(true);
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationName: 'SYSTEM' }))).toBe(true);
  });

  it('should return false for member role', () => {
    expect(isSystemAdmin(mockUser({ role: 'member', organizationId: 'system' }))).toBe(false);
  });

  it('should return false for admin in non-system org', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'org-1' }))).toBe(false);
  });

  it('should return false for null user', () => {
    expect(isSystemAdmin(null)).toBe(false);
  });

  it('should return false when organizationId and organizationName are undefined', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin' }))).toBe(false);
  });
});

describe('isOrgAdmin', () => {
  it('should return true for admin not in system org', () => {
    expect(isOrgAdmin(mockUser({ role: 'admin', organizationId: 'org-1' }))).toBe(true);
  });

  it('should return true for owner in non-system org', () => {
    expect(isOrgAdmin(mockUser({ role: 'owner', organizationId: 'org-1' }))).toBe(true);
  });

  it('should return false for system admin', () => {
    expect(isOrgAdmin(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(false);
  });

  it('should return false for member role', () => {
    expect(isOrgAdmin(mockUser({ role: 'member', organizationId: 'org-1' }))).toBe(false);
  });

  it('should return false for null user', () => {
    expect(isOrgAdmin(null)).toBe(false);
  });
});
