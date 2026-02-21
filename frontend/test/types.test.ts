import { isSystemAdmin, isOrgAdmin, User } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    username: 'testuser',
    email: 'test@example.com',
    role: 'user',
    isEmailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isSystemAdmin', () => {
  it('should return true for admin with system organizationId', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(true);
  });

  it('should return true for admin with system organizationName', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationName: 'system' }))).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationId: 'System' }))).toBe(true);
    expect(isSystemAdmin(mockUser({ role: 'admin', organizationName: 'SYSTEM' }))).toBe(true);
  });

  it('should return false for non-admin role', () => {
    expect(isSystemAdmin(mockUser({ role: 'user', organizationId: 'system' }))).toBe(false);
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

  it('should return false for system admin', () => {
    expect(isOrgAdmin(mockUser({ role: 'admin', organizationId: 'system' }))).toBe(false);
  });

  it('should return false for non-admin user', () => {
    expect(isOrgAdmin(mockUser({ role: 'user', organizationId: 'org-1' }))).toBe(false);
  });

  it('should return false for null user', () => {
    expect(isOrgAdmin(null)).toBe(false);
  });
});
