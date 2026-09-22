// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  ALL_PERMISSIONS,
  ORG_ASSIGNABLE_CATEGORIES,
  ORG_ASSIGNABLE_PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_PERMISSIONS,
  SYSTEM_ORG_ONLY_PERMISSIONS,
  ECOSYSTEM_MANAGER_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  hasPermission,
  intersectPermissions,
  isOrgAssignablePermission,
  isSystemOrgOnlyPermission,
  normalizePermissionSubset,
  isValidPermission,
  permissionLabel,
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
      // Admin bundle is every ORG-ASSIGNABLE permission (registry:* are
      // superadmin-implicit-only, excluded from the built-in Admin Role).
      expect(resolveUserPermissions(ROLE_PERMISSIONS.admin)).toEqual([...ORG_ASSIGNABLE_PERMISSIONS]);
    });

    it('publish/rollup capabilities are Admin-only, org-assignable, and NOT in the Member bundle', () => {
      // Widened from label-authority (Tier 5): a custom Role CAN be granted these,
      // built-in Admin/Owner carry them, built-in Member must not.
      for (const cap of ['pipelines:publish', 'plugins:publish', 'reports:rollup'] as const) {
        expect(ORG_ASSIGNABLE_PERMISSIONS).toContain(cap); // grantable to custom Roles
        expect(ROLE_PERMISSIONS.admin).toContain(cap); // built-in Admin publishes
        expect(ROLE_PERMISSIONS.owner).toContain(cap); // built-in Owner publishes
        expect(ROLE_PERMISSIONS.member).not.toContain(cap); // members stay private-only
      }
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

describe('templates permission family', () => {
  it('is a first-class family in the catalog, distinct from pipelines', () => {
    for (const p of ['templates:read', 'templates:write', 'templates:publish']) {
      expect(isValidPermission(p)).toBe(true);
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it('is org-assignable (not part of the superadmin carve-out)', () => {
    // Unlike `registry:*`, a custom Role may grant template curation — that's the
    // whole point of splitting it out of `pipelines:*`.
    expect(ORG_ASSIGNABLE_PERMISSIONS).toContain('templates:write');
    expect(ORG_ASSIGNABLE_PERMISSIONS).toContain('templates:publish');
  });

  it('mirrors the pipelines bundle split: Member gets read+write, not publish', () => {
    expect(ROLE_PERMISSIONS.member).toContain('templates:read');
    expect(ROLE_PERMISSIONS.member).toContain('templates:write');
    expect(ROLE_PERMISSIONS.member).not.toContain('templates:publish');
    // Same shape as the pipeline family it was split from, so a Member's
    // day-to-day authoring reach is unchanged by the split.
    expect(ROLE_PERMISSIONS.member.includes('pipelines:publish')).toBe(false);
  });

  it('gives Admin and Owner the full family including publish', () => {
    for (const bundle of [ROLE_PERMISSIONS.admin, ROLE_PERMISSIONS.owner]) {
      expect(bundle).toContain('templates:read');
      expect(bundle).toContain('templates:write');
      expect(bundle).toContain('templates:publish');
    }
  });

  it('is grantable independently of the pipeline family', () => {
    // A curator Role: authors + publishes starters, but cannot touch pipelines.
    const curator = resolveUserPermissions(['templates:read', 'templates:write', 'templates:publish']);
    expect(hasPermission(curator, 'templates:publish')).toBe(true);
    expect(hasPermission(curator, 'pipelines:write')).toBe(false);

    // …and the inverse: a developer who builds pipelines but authors no starters.
    const developer = resolveUserPermissions(['pipelines:read', 'pipelines:write']);
    expect(hasPermission(developer, 'pipelines:write')).toBe(true);
    expect(hasPermission(developer, 'templates:write')).toBe(false);
  });
});

describe('PERMISSION_CATALOG (the single catalog the browser also imports)', () => {
  const ids = PERMISSION_CATALOG.map((p) => p.id);

  it('covers ALL_PERMISSIONS exactly once each', () => {
    expect([...ids].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the catalog in ALL_PERMISSIONS order (the picker\'s display order)', () => {
    expect(ids).toEqual([...ALL_PERMISSIONS]);
  });

  it('gives every entry a non-empty label, description, and category', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
      expect(p.category.trim().length).toBeGreaterThan(0);
    }
  });

  it('permissionLabel resolves known ids and falls back to the raw id', () => {
    expect(permissionLabel('plugins:write')).toBe('Manage plugins');
    expect(permissionLabel('does:notexist')).toBe('does:notexist');
  });

  it('groups every org-assignable entry into exactly one category, dropping superadmin-only ones', () => {
    const grouped = ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.id));
    expect([...grouped].sort()).toEqual([...ORG_ASSIGNABLE_PERMISSIONS].sort());
    for (const superadminOnly of SUPERADMIN_ONLY_PERMISSIONS) {
      expect(grouped).not.toContain(superadminOnly);
      expect(isOrgAssignablePermission(superadminOnly)).toBe(false);
    }
    // The Registry category holds only superadmin-only ids, so it disappears.
    expect(ORG_ASSIGNABLE_CATEGORIES.map((c) => c.category)).not.toContain('Registry');
  });

  it('has a browser-safe module graph (no runtime imports at all)', async () => {
    // The frontend imports this module through `@pipeline-builder/api-core/permissions`.
    // A single runtime import here (express, jsonwebtoken, ioredis, node:*) would
    // land in the Next.js bundle — or fail the build outright.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/types/permissions.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });
});

describe('org:settings split → org:idp / org:kms (C3)', () => {
  const SPLIT: ReadonlyArray<'org:idp' | 'org:kms'> = ['org:idp', 'org:kms'];

  it('adds org:idp and org:kms to the canonical catalog', () => {
    for (const p of SPLIT) expect(ALL_PERMISSIONS).toContain(p);
    // The original general-settings capability is retained (not renamed).
    expect(ALL_PERMISSIONS).toContain('org:settings');
  });

  it('both new caps are org-assignable (not superadmin-only)', () => {
    for (const p of SPLIT) {
      expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain(p);
      expect(ORG_ASSIGNABLE_PERMISSIONS).toContain(p);
      expect(isOrgAssignablePermission(p)).toBe(true);
    }
  });

  it('seeds org:idp and org:kms into the admin and owner bundles (no admin lockout)', () => {
    for (const p of SPLIT) {
      expect(ROLE_PERMISSIONS.admin).toContain(p);
      expect(ROLE_PERMISSIONS.owner).toContain(p);
    }
  });

  it('does NOT grant the sensitive caps to the member bundle', () => {
    for (const p of SPLIT) expect(ROLE_PERMISSIONS.member).not.toContain(p);
  });
});

describe('org:settings split → org:impersonation', () => {
  it('is in the canonical catalog, alongside the settings it was split from', () => {
    expect(ALL_PERMISSIONS).toContain('org:impersonation');
    expect(ALL_PERMISSIONS).toContain('org:settings');
  });

  it('is org-assignable — every org must be able to set its own policy', () => {
    expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain('org:impersonation');
    expect(ORG_ASSIGNABLE_PERMISSIONS).toContain('org:impersonation');
    expect(isOrgAssignablePermission('org:impersonation')).toBe(true);
  });

  it('is seeded into the admin and owner bundles (no admin lockout)', () => {
    expect(ROLE_PERMISSIONS.admin).toContain('org:impersonation');
    expect(ROLE_PERMISSIONS.owner).toContain('org:impersonation');
  });

  it('is NOT granted to members — it decides who may view the org\'s data', () => {
    expect(ROLE_PERMISSIONS.member).not.toContain('org:impersonation');
  });
});

describe('plugin ecosystem permissions (docs/plans/plugin-ecosystem.md §5a)', () => {
  const ORG_ASSIGNABLE = ['plugins:install', 'plugin_installs:manage', 'publishers:manage'] as const;

  it('adds every ecosystem permission to the catalog', () => {
    for (const p of [...ORG_ASSIGNABLE, ...SYSTEM_ORG_ONLY_PERMISSIONS]) {
      expect(ALL_PERMISSIONS).toContain(p);
      expect(PERMISSION_CATALOG.find((m) => m.id === p)?.category).toBe('Plugin Ecosystem');
    }
  });

  it('plugins:install is in the member, admin and owner bundles', () => {
    for (const bundle of [ROLE_PERMISSIONS.member, ROLE_PERMISSIONS.admin, ROLE_PERMISSIONS.owner]) {
      expect(bundle).toContain('plugins:install');
    }
  });

  it('plugin_installs:manage and publishers:manage are admin/owner only', () => {
    for (const p of ['plugin_installs:manage', 'publishers:manage'] as const) {
      expect(ORG_ASSIGNABLE_PERMISSIONS).toContain(p);
      expect(ROLE_PERMISSIONS.admin).toContain(p);
      expect(ROLE_PERMISSIONS.owner).toContain(p);
      expect(ROLE_PERMISSIONS.member).not.toContain(p);
    }
  });

  it('SYSTEM_ORG_ONLY_PERMISSIONS are moderate + verify, in no built-in bundle and never org-assignable', () => {
    expect([...SYSTEM_ORG_ONLY_PERMISSIONS]).toEqual(['plugins:moderate', 'publishers:verify']);
    for (const p of SYSTEM_ORG_ONLY_PERMISSIONS) {
      expect(isSystemOrgOnlyPermission(p)).toBe(true);
      expect(isOrgAssignablePermission(p)).toBe(false);
      expect(ORG_ASSIGNABLE_PERMISSIONS).not.toContain(p);
      expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain(p);
      for (const bundle of Object.values(ROLE_PERMISSIONS)) expect(bundle).not.toContain(p);
      expect(ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((m) => m.id))).not.toContain(p);
    }
    for (const p of ORG_ASSIGNABLE) expect(isSystemOrgOnlyPermission(p)).toBe(false);
  });

  it('superadmins hold the system-org-only permissions implicitly', () => {
    const perms = resolveUserPermissions(null, true);
    for (const p of SYSTEM_ORG_ONLY_PERMISSIONS) expect(perms).toContain(p);
  });

  it('ECOSYSTEM_MANAGER_PERMISSIONS: system-org-only perms + moderator reads, nothing tenant-facing', () => {
    expect([...ECOSYSTEM_MANAGER_PERMISSIONS].sort()).toEqual(
      ['messages:read', 'observability:read', 'plugins:moderate', 'plugins:read', 'publishers:verify'],
    );
    for (const p of ECOSYSTEM_MANAGER_PERMISSIONS) expect(isValidPermission(p)).toBe(true);
    for (const p of SYSTEM_ORG_ONLY_PERMISSIONS) expect(ECOSYSTEM_MANAGER_PERMISSIONS).toContain(p);
    for (const p of ['members:manage', 'roles:manage', 'registry:read', 'registry:write'] as const) {
      expect(ECOSYSTEM_MANAGER_PERMISSIONS).not.toContain(p);
    }
  });
});

describe('permission-scoped credentials', () => {
  it('READ_ONLY_PERMISSIONS is exactly the catalog\'s :read ids', () => {
    expect(READ_ONLY_PERMISSIONS.length).toBeGreaterThan(0);
    expect(READ_ONLY_PERMISSIONS.every((p) => p.endsWith(':read'))).toBe(true);
    expect(READ_ONLY_PERMISSIONS).toContain('pipelines:read');
    expect(READ_ONLY_PERMISSIONS).not.toContain('pipelines:write');
  });

  it('normalizePermissionSubset dedupes into catalog order and refuses unknown ids', () => {
    expect(normalizePermissionSubset(['plugins:read', 'pipelines:read', 'plugins:read']))
      .toEqual(['pipelines:read', 'plugins:read']);
    expect(normalizePermissionSubset([])).toEqual([]);
    expect(normalizePermissionSubset(['pipelines:read', 'nope:write'])).toBeNull();
    expect(normalizePermissionSubset([42])).toBeNull();
  });

  it('intersectPermissions keeps only what BOTH the subset and the holder grant', () => {
    expect(intersectPermissions(['pipelines:read', 'pipelines:write'], ['pipelines:read', 'billing:manage']))
      .toEqual(['pipelines:read']);
    // A later role loss shrinks it; nothing in the holder's set grows it.
    expect(intersectPermissions([], ['pipelines:read'])).toEqual([]);
    expect(intersectPermissions(['pipelines:read', 'org:settings'], [])).toEqual([]);
    // Unknown strings in either input never survive.
    expect(intersectPermissions(['bogus'], ['bogus'])).toEqual([]);
  });
});
