// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  isValidPermission,
  resolveUserPermissions,
} from '../src/types/permissions.js';

describe('resolveUserPermissions', () => {
  it('superadmin always gets the full ALL_PERMISSIONS bundle (assigned Roles ignored)', () => {
    const perms = resolveUserPermissions(['pipelines:read'], true);
    expect(perms).toEqual([...ALL_PERMISSIONS]);
    // Even with no assigned Roles, a superadmin short-circuits to ALL.
    expect(resolveUserPermissions(null, true)).toEqual([...ALL_PERMISSIONS]);
  });

  describe('single-source: permissions come ONLY from assigned Roles', () => {
    it('resolves exactly the union of the assigned Roles\' permissions', () => {
      // The built-in "Member" Role carries ROLE_PERMISSIONS.member explicitly.
      expect(resolveUserPermissions(ROLE_PERMISSIONS.member)).toEqual([...ROLE_PERMISSIONS.member]);
      // The built-in "Admin" Role carries the full set.
      expect(resolveUserPermissions(ROLE_PERMISSIONS.admin)).toEqual([...ALL_PERMISSIONS]);
    });

    it('a user with NO assigned Roles resolves to NO permissions (no baseline)', () => {
      expect(resolveUserPermissions()).toEqual([]);
      expect(resolveUserPermissions(null)).toEqual([]);
      expect(resolveUserPermissions([])).toEqual([]);
    });

    it('a narrow custom Role grants ONLY its permissions (cannot be widened by a hidden baseline)', () => {
      const perms = resolveUserPermissions(['reports:read']);
      expect(perms).toEqual(['reports:read']);
      expect(perms).not.toContain('pipelines:write');
      expect(perms).not.toContain('members:manage');
    });
  });

  it('merges (unions) permissions from multiple Roles without duplicates', () => {
    // Simulate a flattened list from several assigned Roles, with an overlap.
    const roleUnion = ['compliance:write', 'compliance:write', 'reports:read', 'registry:write'];
    const perms = resolveUserPermissions(roleUnion);
    expect(perms.filter(p => p === 'compliance:write')).toHaveLength(1);
    expect(perms).toContain('registry:write');
  });

  it('silently ignores invalid permission strings from Roles', () => {
    const perms = resolveUserPermissions(['not-a-real-perm', 'compliance:write', '']);
    expect(perms).toContain('compliance:write');
    expect(perms as string[]).not.toContain('not-a-real-perm');
    expect(perms.every(isValidPermission)).toBe(true);
  });

  it('returns permissions in canonical ALL_PERMISSIONS order', () => {
    const perms = resolveUserPermissions(['org:settings', 'compliance:write']);
    const orderInCatalog = perms.map(p => ALL_PERMISSIONS.indexOf(p));
    const sorted = [...orderInCatalog].sort((a, b) => a - b);
    expect(orderInCatalog).toEqual(sorted);
  });
});

describe('hasPermission', () => {
  it('superadmin bypass: true for any permission regardless of the granted list', () => {
    expect(hasPermission([], 'org:settings', true)).toBe(true);
    expect(hasPermission(null, 'billing:manage', true)).toBe(true);
    expect(hasPermission(undefined, 'members:manage', true)).toBe(true);
  });

  it('returns true only when the granted list includes the permission', () => {
    expect(hasPermission(['pipelines:read', 'plugins:read'], 'pipelines:read')).toBe(true);
    expect(hasPermission(['pipelines:read'], 'compliance:write')).toBe(false);
  });

  it('handles null/undefined granted lists (non-superadmin) as no access', () => {
    expect(hasPermission(null, 'pipelines:read')).toBe(false);
    expect(hasPermission(undefined, 'pipelines:read')).toBe(false);
    expect(hasPermission(null, 'pipelines:read', false)).toBe(false);
  });
});
