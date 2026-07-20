// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for auth-helpers: the read-only-impersonation write classifier
 * (`isMutationPermission`) plus the basic role/permission guards.
 *
 * `isMutationPermission` is the pure core of the app-wide read-only gate:
 * `useAuthGuard`'s `can()` returns false for any mutation permission while a
 * read-only impersonation session is active, so write controls disable
 * everywhere. The backend rejects every non-GET under an impersonation token,
 * so a misclassification here would surface an enabled button that only 403s.
 */
import {
  isMutationPermission,
  hasPermission,
  isSystemAdmin,
  isOrgAdmin,
} from '../src/lib/auth-helpers';
import { PERMISSION_CATALOG } from '../src/lib/permissions';
import type { User } from '../src/types';

describe('isMutationPermission', () => {
  it('treats :write permissions as mutations', () => {
    expect(isMutationPermission('pipelines:write')).toBe(true);
    expect(isMutationPermission('plugins:write')).toBe(true);
    expect(isMutationPermission('observability:write')).toBe(true);
  });

  it('treats :manage permissions as mutations', () => {
    expect(isMutationPermission('members:manage')).toBe(true);
    expect(isMutationPermission('roles:manage')).toBe(true);
    expect(isMutationPermission('invitations:manage')).toBe(true);
    expect(isMutationPermission('billing:manage')).toBe(true);
  });

  it('treats org:settings as a mutation', () => {
    expect(isMutationPermission('org:settings')).toBe(true);
  });

  it('treats :read permissions as non-mutations', () => {
    expect(isMutationPermission('pipelines:read')).toBe(false);
    expect(isMutationPermission('reports:read')).toBe(false);
    expect(isMutationPermission('quotas:read')).toBe(false);
    expect(isMutationPermission('billing:read')).toBe(false);
  });

  // Every catalog id must classify one way or the other, and the two classes
  // must partition the catalog exactly (no id both read AND write). This keeps
  // the classifier honest as the catalog grows.
  it('classifies every catalog permission as read xor write', () => {
    for (const { id } of PERMISSION_CATALOG) {
      const isWrite = isMutationPermission(id);
      const looksRead = id.endsWith(':read');
      // A :read id must never be a mutation; a non-:read id must be a mutation.
      expect(isWrite).toBe(!looksRead);
    }
  });
});

describe('hasPermission / role guards', () => {
  const member: User = {
    id: 'u1', username: 'm', email: 'm@x.io', role: 'member',
    permissions: ['pipelines:read', 'pipelines:write'],
  } as User;
  const superAdmin: User = { id: 'u2', username: 's', email: 's@x.io', role: 'member', isSuperAdmin: true } as User;
  const owner: User = { id: 'u3', username: 'o', email: 'o@x.io', role: 'owner' } as User;

  it('grants a held permission and denies an unheld one', () => {
    expect(hasPermission(member, 'pipelines:write')).toBe(true);
    expect(hasPermission(member, 'billing:manage')).toBe(false);
  });

  it('superadmin implicitly holds every permission', () => {
    expect(hasPermission(superAdmin, 'billing:manage')).toBe(true);
    expect(isSystemAdmin(superAdmin)).toBe(true);
  });

  it('org admin/owner is not a system admin', () => {
    expect(isSystemAdmin(owner)).toBe(false);
    expect(isOrgAdmin(owner)).toBe(true);
    expect(isOrgAdmin(superAdmin)).toBe(false);
  });

  it('is null-safe', () => {
    expect(hasPermission(null, 'pipelines:read')).toBe(false);
    expect(isSystemAdmin(null)).toBe(false);
    expect(isOrgAdmin(null)).toBe(false);
  });
});
