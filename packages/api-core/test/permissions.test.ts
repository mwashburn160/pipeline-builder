// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import type { OrgRole } from '../src/types/common.js';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
  hasPermission,
  isValidPermission,
  resolveUserPermissions,
} from '../src/types/permissions.js';

describe('resolveUserPermissions', () => {
  it('superadmin always gets the full ALL_PERMISSIONS bundle (role/groups ignored)', () => {
    const perms = resolveUserPermissions('member', ['pipelines:read'], true);
    expect(perms).toEqual([...ALL_PERMISSIONS]);
    // Even a nonsense role short-circuits to ALL for a superadmin.
    expect(resolveUserPermissions('member', null, true)).toEqual([...ALL_PERMISSIONS]);
  });

  describe('base role bundles', () => {
    const cases: Array<{ role: OrgRole; expected: readonly Permission[] }> = [
      { role: 'member', expected: ROLE_PERMISSIONS.member },
      { role: 'admin', expected: ROLE_PERMISSIONS.admin },
      { role: 'owner', expected: ROLE_PERMISSIONS.owner },
    ];

    it.each(cases)('$role resolves to its base bundle when no groups are supplied', ({ role, expected }) => {
      expect(resolveUserPermissions(role)).toEqual([...expected]);
    });

    it('admin and owner both resolve to the full permission set', () => {
      expect(resolveUserPermissions('admin')).toEqual([...ALL_PERMISSIONS]);
      expect(resolveUserPermissions('owner')).toEqual([...ALL_PERMISSIONS]);
    });

    it('member does NOT include admin-only permissions', () => {
      const perms = resolveUserPermissions('member');
      expect(perms).not.toContain('members:manage');
      expect(perms).not.toContain('groups:manage');
      expect(perms).not.toContain('compliance:write');
      expect(perms).not.toContain('billing:manage');
      expect(perms).not.toContain('org:settings');
    });
  });

  it('unions group-granted permissions on top of the base role bundle', () => {
    const perms = resolveUserPermissions('member', ['compliance:write', 'org:settings']);
    // Base member perms are retained…
    expect(perms).toContain('pipelines:read');
    // …plus the group-granted ones.
    expect(perms).toContain('compliance:write');
    expect(perms).toContain('org:settings');
  });

  it('merges (unions) permissions from multiple groups without duplicates', () => {
    // Simulate a flattened list from several groups, with an overlap.
    const groupUnion = ['compliance:write', 'compliance:write', 'reports:read', 'registry:write'];
    const perms = resolveUserPermissions('member', groupUnion);
    expect(perms.filter(p => p === 'compliance:write')).toHaveLength(1);
    expect(perms).toContain('registry:write');
  });

  it('silently ignores invalid permission strings from groups', () => {
    const perms = resolveUserPermissions('member', ['not-a-real-perm', 'compliance:write', '']);
    expect(perms).toContain('compliance:write');
    expect(perms as string[]).not.toContain('not-a-real-perm');
    // Every resolved entry is a valid permission.
    expect(perms.every(isValidPermission)).toBe(true);
  });

  it('returns permissions in canonical ALL_PERMISSIONS order', () => {
    const perms = resolveUserPermissions('member', ['org:settings', 'compliance:write']);
    const orderInCatalog = perms.map(p => ALL_PERMISSIONS.indexOf(p));
    const sorted = [...orderInCatalog].sort((a, b) => a - b);
    expect(orderInCatalog).toEqual(sorted);
  });

  it('falls back to the member bundle for an unknown role', () => {
    const perms = resolveUserPermissions('bogus' as OrgRole);
    expect(perms).toEqual([...ROLE_PERMISSIONS.member]);
  });

  it('handles null/undefined group permissions', () => {
    expect(resolveUserPermissions('member', null)).toEqual([...ROLE_PERMISSIONS.member]);
    expect(resolveUserPermissions('member', undefined)).toEqual([...ROLE_PERMISSIONS.member]);
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
