// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  ALL_PERMISSIONS,
  ORG_ASSIGNABLE_CATEGORIES,
  ORG_ASSIGNABLE_PERMISSIONS,
  ACCOUNT_MANAGER_PERMISSIONS,
  CONSOLE_ADMIN_PERMISSIONS,
  PLATFORM_OPERATOR_PERMISSIONS,
  SUPPORT_AGENT_PERMISSIONS,
  REGISTRY_OPERATOR_PERMISSIONS,
  SUPPORT_LEAD_PERMISSIONS,
  ROLE_TEMPLATES,
  SEED_BUNDLES,
  SEED_BUNDLE_IDS,
  SYSTEM_ORG_JOB_BUNDLES,
  ORG_AUTOMATION_BUNDLES,
  AUTOMATION_ACCOUNT_BUNDLES,
  PIPELINE_AUTOMATION_PERMISSIONS,
  PIPELINE_REGISTRATION_PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_CATALOG,
  PERMISSION_ID_SHAPE,
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
  confinePermissionsToOrg,
} from '../src/types/permissions.js';

/**
 * `SEED_BUNDLES` is the one table the mongoose enum, the bundle resolver and the
 * staffing roster all derive from. These are the invariants a reader of that
 * table would assume and nothing else checks.
 */
describe('SEED_BUNDLES — the one table', () => {
  it('gives every bundle a non-empty name and a non-empty permission list', () => {
    for (const id of SEED_BUNDLE_IDS) {
      const bundle = SEED_BUNDLES[id];
      expect({ id, name: bundle.name.length > 2, perms: bundle.permissions.length > 0 })
        .toEqual({ id, name: true, perms: true });
    }
  });

  /**
   * NAMES MUST BE UNIQUE. `roleSchema` carries a unique index on
   * `(organizationId, name)`, so two bundles sharing a name would make the
   * second insert of `seedDefaultRoles` fail — org creation breaking on a
   * duplicate-key error, for a clash visible only here.
   */
  it('gives every bundle a distinct name', () => {
    const names = SEED_BUNDLE_IDS.map((id) => SEED_BUNDLES[id].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names only real catalog permissions in every bundle', () => {
    for (const id of SEED_BUNDLE_IDS) {
      for (const p of SEED_BUNDLES[id].permissions) {
        expect({ id, permission: p, valid: isValidPermission(p) }).toEqual({ id, permission: p, valid: true });
      }
    }
  });

  it('draws the system-org job list from the bundle ids, and leaves out the tenant one', () => {
    for (const id of SYSTEM_ORG_JOB_BUNDLES) expect(SEED_BUNDLE_IDS).toContain(id);
    // `team_lead` is a TENANT job and a template now — a seed bundle (legacy
    // Roles keep theirs) that is seeded nowhere.
    expect(SYSTEM_ORG_JOB_BUNDLES).not.toContain('team_lead');
    expect(new Set(SYSTEM_ORG_JOB_BUNDLES).size).toBe(SYSTEM_ORG_JOB_BUNDLES.length);
  });

  /**
   * Every system-org job bundle carries at least one system-org-only
   * permission — which is WHY it is a seeded bundle rather than a template: a
   * template produces a custom Role, and `sanitizePermissions` refuses that
   * class outright.
   */
  it('gives every system-org job bundle a reason to be a bundle', () => {
    const templatable = SYSTEM_ORG_JOB_BUNDLES.filter(
      (id) => !SEED_BUNDLES[id].permissions.some((p) => isSystemOrgOnlyPermission(p)),
    );
    expect({
      templatable,
      fix: 'A system-org bundle carrying only org-assignable permissions needs no seeded Role — '
        + 'it could be a ROLE TEMPLATE instead, which leaves no undeletable row in the org.',
    }).toEqual({ templatable: [], fix: expect.any(String) });
  });
});

describe('ROLE_TEMPLATES — starting points for a custom Role', () => {
  // THE GAP THEY FILL: an org's seeded ladder is Member (15 permissions) then
  // Admin (all 37), so promoting anyone past "author and read" meant either
  // picking from the full catalog by hand or — the shortcut people actually took
  // — granting Admin.
  /**
   * THE CLIFF, as numbers, asserted instead of narrated.
   *
   * The templates' own doc block used to carry these inline — "an org seeds
   * three Roles: Member (15), Team Lead (17) and Admin (37)" — and every figure
   * went stale: `Team Lead` stopped being seeded when it became a template, and
   * both bundles grew. That paragraph is the stated rationale for templates
   * existing, so its decay made the feature look unmotivated.
   *
   * These are deliberately RELATIVE, not absolute. Pinning "Admin has 40" turns
   * every new permission into a failing test for no benefit; pinning "Admin is
   * the whole org-assignable set and Member is a strict subset, and the gap is
   * what a promotion hands over" is the claim the feature rests on.
   */
  it('still has the cliff the templates exist to soften', () => {
    const member = new Set<string>(ROLE_PERMISSIONS.member);
    const admin = new Set<string>(ROLE_PERMISSIONS.admin);

    // Admin IS the org-assignable set — the reason promoting is all-or-nothing.
    expect([...admin].sort()).toEqual([...ORG_ASSIGNABLE_PERMISSIONS].sort());
    // Member is a strict subset, so there IS a gap.
    for (const p of member) expect(admin.has(p)).toBe(true);
    const gap = [...admin].filter((p) => !member.has(p));
    expect(gap.length).toBeGreaterThan(15);

    // And the specific permissions the doc block names as the alarming part of
    // that gap are all really in it.
    for (const p of ['org_kms:write', 'org_idp:write', 'org_impersonation:write',
      'billing:manage', 'roles:manage', 'audit:read']) {
      expect({ permission: p, inGap: gap.includes(p) }).toEqual({ permission: p, inGap: true });
    }

    // Exactly two seeded Roles is what makes it a cliff rather than a ladder.
    // `Team Lead` is a TEMPLATE now and must not reappear as a seeded bundle in
    // a tenant org — that is what the first template below replaced.
    expect(SYSTEM_ORG_JOB_BUNDLES).not.toContain('team_lead');
  });

  it('offers a template per job, each with a real description', () => {
    expect(ROLE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    for (const t of ROLE_TEMPLATES) {
      expect(t.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(t.name.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.permissions.length).toBeGreaterThan(0);
    }
    expect(new Set(ROLE_TEMPLATES.map((t) => t.id)).size).toBe(ROLE_TEMPLATES.length);
  });

  /**
   * Every permission in a template is ORG-ASSIGNABLE.
   *
   * A template produces an ordinary custom Role, so it goes through
   * `sanitizePermissions` — which refuses anything superadmin-only or
   * system-org-only with `RL_PERMISSION_NOT_ASSIGNABLE`. A template carrying one
   * would present a button that cannot work, and the failure would arrive at
   * save time as a rejected request rather than here.
   */
  it('contains only permissions a custom Role may actually carry', () => {
    const offenders = ROLE_TEMPLATES.flatMap((t) => t.permissions
      .filter((p) => !isOrgAssignablePermission(p))
      .map((p) => `${t.id}: ${p}`));
    expect(offenders).toEqual([]);
  });

  it('names only real catalog permissions', () => {
    for (const t of ROLE_TEMPLATES) {
      for (const p of t.permissions) expect(isValidPermission(p)).toBe(true);
    }
  });

  /**
   * NO TEMPLATE GRANTS `roles:manage`.
   *
   * It is the one permission that compounds: its holder can mint further Roles,
   * up to their own ceiling. Acquiring it should be a conscious act, not a side
   * effect of clicking the job that sounded closest.
   */
  it('grants roles:manage in none of them', () => {
    const offenders = ROLE_TEMPLATES.filter((t) => t.permissions.includes('roles:manage')).map((t) => t.id);
    expect(offenders).toEqual([]);
  });

  /**
   * DEVELOPER is Member plus the two self-service operate writes — and the
   * assertion is mostly about what it does NOT carry.
   *
   * Everything in a developer's authoring loop is already in the member bundle
   * (`pipelines:write` covers create/edit/validate/run/stop/bulk/AI-generate),
   * so the template earns its place only by closing the operate gap: a person
   * who owns a pipeline could read its dashboards and metrics and change
   * neither. `logs:export` is excluded on purpose (bulk egress, admin/owner by
   * product decision) and so is `pipelines:publish` (a release decision, which
   * Release Manager carries).
   */
  it('makes Developer the member bundle plus the self-service operate writes, and nothing else', () => {
    const dev = ROLE_TEMPLATES.find((t) => t.id === 'developer');
    expect(dev).toBeDefined();
    const perms = new Set<string>(dev!.permissions);

    // Every member permission is still there — it is the baseline, not a subset.
    for (const p of ROLE_PERMISSIONS.member) expect(perms.has(p)).toBe(true);
    expect(perms.has('dashboards:write')).toBe(true);
    expect(perms.has('observability:write')).toBe(true);
    expect([...perms].length).toBe(ROLE_PERMISSIONS.member.length + 2);

    // The two deliberate exclusions, each with its own reason above.
    expect(perms.has('logs:export')).toBe(false);
    expect(perms.has('pipelines:publish')).toBe(false);
  });

  /**
   * The impersonation trio, placed where each one's JOB already is.
   *
   * `impersonation:approve` goes with the officer who owns the policy that
   * decides whether consent is needed — owning the policy and not the decision
   * was the asymmetry. `team_access:open` goes with the manager who owns the
   * roster, because reaching a team to work on its roster is the same job one
   * level down. And `Access Approver` exists for the case the split was FOR: an
   * org that wants the consent decision to rest with one named person rather
   * than with every admin.
   */
  it('puts the impersonation delegations with the jobs they belong to', () => {
    const byId = new Map(ROLE_TEMPLATES.map((t) => [t.id, t.permissions as readonly string[]]));
    expect(byId.get('security-officer')).toContain('impersonation:approve');
    expect(byId.get('security-officer')).toContain('org_impersonation:write');
    expect(byId.get('people-manager')).toContain('team_access:open');

    const approver = byId.get('access-approver');
    expect(approver).toBeDefined();
    // Two permissions and no more: approving is not administering.
    expect([...approver!].sort()).toEqual(['audit:read', 'impersonation:approve']);

    // And the vendor's own cross-tenant permission is in NO template — it is
    // system-org-only, so `sanitizePermissions` would refuse it anyway, but a
    // template offering it would present a button that cannot work.
    const templated = new Set<string>(ROLE_TEMPLATES.flatMap((t) => [...t.permissions]));
    expect(templated.has('impersonation:open')).toBe(false);
  });

  /**
   * Together they cover the Admin-only block that caused the cliff.
   *
   * Not a demand that every permission be templated — `org_settings:write` and
   * the publish-adjacent ones an admin keeps are deliberately theirs. This pins
   * the four that an org most often wants to delegate and previously could not
   * without handing over everything.
   */
  it('covers the delegations the cliff used to force Admin for', () => {
    const templated = new Set<string>(ROLE_TEMPLATES.flatMap((t) => [...t.permissions]));
    for (const p of ['audit:read', 'logs:export', 'billing:manage', 'members:manage',
      'invitations:manage', 'service_accounts:manage', 'compliance:write',
      'org_idp:write', 'org_kms:write', 'org_impersonation:write',
      'pipelines:publish', 'templates:publish', 'plugins:publish', 'plugin_installs:manage',
      // The two the impersonation consent flow added to the admin bundle. Both
      // are org-assignable and were in no template, so the delegation they exist
      // for had no starting point — the same shape as the cliff above.
      'impersonation:approve', 'team_access:open']) {
      expect({ permission: p, templated: templated.has(p) }).toEqual({ permission: p, templated: true });
    }
  });

  // Team Lead moved from a SEEDED Role to a template — the only built-in that
  // was a job description rather than a structural requirement. The template is
  // what keeps the capability discoverable after un-seeding it.
  it('keeps Team Lead available as a template after it stopped being seeded', () => {
    const lead = ROLE_TEMPLATES.find((t) => t.id === 'team-lead');
    expect(lead).toBeDefined();
    expect(lead!.permissions).toEqual(expect.arrayContaining(['reports:write', 'reports:publish']));
    // Still NOT `reports:rollup`: rolling up over descendant teams is downward
    // visibility across the org tree, granted explicitly to a PARENT org's lead
    // — see the TEAM_LEAD_PERMISSIONS comment. The template inherits that rule.
    expect(lead!.permissions).not.toContain('reports:rollup');
  });
});

describe('the `resource:action` naming strategy', () => {
  // The docs assert `resource:action` three times over; before this test nothing
  // held them to it, and two families had drifted to `resource:resource`
  // (`org:settings`, `consoles:datastore`). That is not cosmetic: the frontend's
  // read-only-impersonation gate classifies a permission by its SUFFIX, so a
  // noun-shaped action has to be hand-listed, and the one that is forgotten
  // renders an enabled write control that dead-ends on a 403.
  it('gives every permission a snake_case resource and a lower-case action', () => {
    for (const id of ALL_PERMISSIONS) expect(id).toMatch(PERMISSION_ID_SHAPE);
  });

  it('draws every action from the closed vocabulary', () => {
    for (const id of ALL_PERMISSIONS) {
      expect(PERMISSION_ACTIONS).toContain(id.split(':')[1]);
    }
  });

  // The vocabulary is only useful if it stays small: a new verb is a new case
  // every consumer that classifies by suffix has to learn. Adding one here is
  // deliberate and this assertion is the place it gets noticed.
  it('keeps the vocabulary closed and small', () => {
    expect([...PERMISSION_ACTIONS]).toEqual([
      'read', 'rollup',
      'write', 'manage', 'publish', 'open',
      'export', 'install', 'moderate', 'verify', 'operate', 'purge', 'approve',
    ]);
    const used = new Set(ALL_PERMISSIONS.map((id) => id.split(':')[1]));
    // No verb survives in the vocabulary that nothing uses.
    for (const action of PERMISSION_ACTIONS) expect(used).toContain(action);
  });
});

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
    const perms = resolveUserPermissions(['org_settings:write', 'compliance:write']);
    const orderInCatalog = perms.map(p => ALL_PERMISSIONS.indexOf(p));
    const sorted = [...orderInCatalog].sort((a, b) => a - b);
    expect(orderInCatalog).toEqual(sorted);
  });
});

describe('hasPermission', () => {
  it('superadmin bypass: true for any permission regardless of the granted list', () => {
    expect(hasPermission([], 'org_settings:write', true)).toBe(true);
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

  /**
   * No SEEDED bundle carries a superadmin-only permission.
   *
   * `sanitizePermissions` refuses one in a custom Role, and that was taken as
   * enough — but a built-in bundle never goes through it, so the only thing
   * keeping `SUPERADMIN_ONLY_PERMISSIONS` true was that no bundle happened to
   * include one. The Platform Operator bundle was written with `registry:read`
   * in it (the operator's registry browser wants it), which would have handed a
   * non-superadmin a permission this list says only a superadmin may hold, with
   * nothing failing. Promoting `registry:read` out of the list is a legitimate
   * change; doing it by side effect from a bundle is not.
   */
  /**
   * Every system-org-only permission is carried by at least one seeded bundle.
   *
   * THE FAILURE THIS CATCHES is how `platform:read` shipped: a permission that
   * no custom Role may carry in any org (SYSTEM_ORG_ONLY) and that no seeded
   * bundle carries either has NO GRANT PATH — it is superadmin-only in practice,
   * which is the exact thing these permissions exist to avoid. Nothing failed;
   * the permission simply did nothing for anyone but a superadmin, and the only
   * way to notice was to go looking.
   *
   * Deliberately asserted as "at least one", not a fixed map: which bundle
   * carries what is a product decision that should stay free to change. Having
   * NO carrier is the bug.
   */
  it('gives every system-org-only permission at least one seeded carrier', () => {
    const bundles: Record<string, readonly string[]> = {
      platform_operator: PLATFORM_OPERATOR_PERMISSIONS,
      account_manager: ACCOUNT_MANAGER_PERMISSIONS,
      console_admin: CONSOLE_ADMIN_PERMISSIONS,
      support_agent: SUPPORT_AGENT_PERMISSIONS,
      registry_operator: REGISTRY_OPERATOR_PERMISSIONS,
      support_lead: SUPPORT_LEAD_PERMISSIONS,
      ecosystem_manager: ECOSYSTEM_MANAGER_PERMISSIONS,
    };
    const orphaned = SYSTEM_ORG_ONLY_PERMISSIONS.filter(
      (p) => !Object.values(bundles).some((b) => b.includes(p)),
    );
    expect({
      orphaned,
      fix: 'A system-org-only permission with no seeded bundle carrying it is superadmin-only in '
        + 'practice — no custom Role may hold it in any org, so a superadmin composing one by hand '
        + 'is the only path and nobody finds it. Add it to the job Role whose work it belongs to '
        + '(api-core types/permissions.ts), or make it org-assignable instead.',
    }).toEqual({ orphaned: [], fix: expect.any(String) });
  });

  it('keeps every superadmin-only permission out of every seeded bundle', () => {
    const bundles: Record<string, readonly string[]> = {
      ...ROLE_PERMISSIONS,
      platform_operator: PLATFORM_OPERATOR_PERMISSIONS,
      account_manager: ACCOUNT_MANAGER_PERMISSIONS,
      console_admin: CONSOLE_ADMIN_PERMISSIONS,
      support_agent: SUPPORT_AGENT_PERMISSIONS,
      registry_operator: REGISTRY_OPERATOR_PERMISSIONS,
      support_lead: SUPPORT_LEAD_PERMISSIONS,
      ecosystem_manager: ECOSYSTEM_MANAGER_PERMISSIONS,
    };
    for (const [name, bundle] of Object.entries(bundles)) {
      for (const p of SUPERADMIN_ONLY_PERMISSIONS) {
        expect({ bundle: name, permission: p, carried: bundle.includes(p) })
          .toEqual({ bundle: name, permission: p, carried: false });
      }
    }
  });

  it('groups every org-assignable entry into exactly one category, dropping superadmin-only ones', () => {
    const grouped = ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((p) => p.id));
    expect([...grouped].sort()).toEqual([...ORG_ASSIGNABLE_PERMISSIONS].sort());
    for (const superadminOnly of SUPERADMIN_ONLY_PERMISSIONS) {
      expect(grouped).not.toContain(superadminOnly);
      expect(isOrgAssignablePermission(superadminOnly)).toBe(false);
    }
    // The Registry category disappears from the org picker, but for TWO reasons
    // now: `registry:purge` is superadmin-only and `registry:read`/`:write` are
    // system-org-only. Neither list is org-assignable, so the category is empty
    // and dropped — a tenant Role can still never carry a registry permission.
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

describe('org_settings:write split → org_idp:write / org_kms:write (C3)', () => {
  const SPLIT: ReadonlyArray<'org_idp:write' | 'org_kms:write'> = ['org_idp:write', 'org_kms:write'];

  it('adds org_idp:write and org_kms:write to the canonical catalog', () => {
    for (const p of SPLIT) expect(ALL_PERMISSIONS).toContain(p);
    // The original general-settings capability is retained (not renamed).
    expect(ALL_PERMISSIONS).toContain('org_settings:write');
  });

  it('both new caps are org-assignable (not superadmin-only)', () => {
    for (const p of SPLIT) {
      expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain(p);
      expect(ORG_ASSIGNABLE_PERMISSIONS).toContain(p);
      expect(isOrgAssignablePermission(p)).toBe(true);
    }
  });

  it('seeds org_idp:write and org_kms:write into the admin and owner bundles (no admin lockout)', () => {
    for (const p of SPLIT) {
      expect(ROLE_PERMISSIONS.admin).toContain(p);
      expect(ROLE_PERMISSIONS.owner).toContain(p);
    }
  });

  it('does NOT grant the sensitive caps to the member bundle', () => {
    for (const p of SPLIT) expect(ROLE_PERMISSIONS.member).not.toContain(p);
  });
});

describe('org_settings:write split → org_impersonation:write', () => {
  it('is in the canonical catalog, alongside the settings it was split from', () => {
    expect(ALL_PERMISSIONS).toContain('org_impersonation:write');
    expect(ALL_PERMISSIONS).toContain('org_settings:write');
  });

  it('is org-assignable — every org must be able to set its own policy', () => {
    expect(SUPERADMIN_ONLY_PERMISSIONS).not.toContain('org_impersonation:write');
    expect(ORG_ASSIGNABLE_PERMISSIONS).toContain('org_impersonation:write');
    expect(isOrgAssignablePermission('org_impersonation:write')).toBe(true);
  });

  it('is seeded into the admin and owner bundles (no admin lockout)', () => {
    expect(ROLE_PERMISSIONS.admin).toContain('org_impersonation:write');
    expect(ROLE_PERMISSIONS.owner).toContain('org_impersonation:write');
  });

  it('is NOT granted to members — it decides who may view the org\'s data', () => {
    expect(ROLE_PERMISSIONS.member).not.toContain('org_impersonation:write');
  });
});

describe('platform operations (platform:read, orgs:read, billing:operate, the consoles)', () => {
  const OPS = [
    'platform:read', 'orgs:read', 'billing:operate',
    'observability_console:open', 'database_console:open', 'objectstore_console:open',
  ] as const;

  it('are system-org-only and in NO built-in Role', () => {
    // The point of the pair: an operator can be staffed with a Role instead of
    // the superadmin flag, WITHOUT the permission becoming grantable inside a
    // tenant — each one reads or moves something belonging to organisations the
    // holder is not a member of.
    for (const p of OPS) {
      expect(isSystemOrgOnlyPermission(p)).toBe(true);
      expect(isOrgAssignablePermission(p)).toBe(false);
      expect(ORG_ASSIGNABLE_PERMISSIONS).not.toContain(p);
      for (const bundle of Object.values(ROLE_PERMISSIONS)) expect(bundle).not.toContain(p);
      expect(ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((m) => m.id))).not.toContain(p);
    }
  });

  it('are real catalog entries under their own category', () => {
    for (const p of OPS) {
      expect(ALL_PERMISSIONS).toContain(p);
      expect(isValidPermission(p)).toBe(true);
      expect(PERMISSION_CATALOG.find((m) => m.id === p)?.category).toBe('Platform operations');
    }
  });

  it('are held implicitly by a superadmin, so nothing an operator could do stops working', () => {
    const perms = resolveUserPermissions(null, true);
    for (const p of OPS) expect(perms).toContain(p);
  });

  it('are dropped when a token is confined to a tenant org', () => {
    const confined = confinePermissionsToOrg(resolveUserPermissions([], true), false);
    for (const p of OPS) expect(confined).not.toContain(p);
  });
});

describe('oncall:manage (docs/oncall-paging.md)', () => {
  it('is system-org-only and in NO built-in Role — so Super Admin only in practice', () => {
    expect(isSystemOrgOnlyPermission('oncall:manage')).toBe(true);
    expect(isOrgAssignablePermission('oncall:manage')).toBe(false);
    expect(ORG_ASSIGNABLE_PERMISSIONS).not.toContain('oncall:manage');
    for (const bundle of Object.values(ROLE_PERMISSIONS)) expect(bundle).not.toContain('oncall:manage');
    expect(ECOSYSTEM_MANAGER_PERMISSIONS).not.toContain('oncall:manage');
  });

  it('is a real permission in the catalog under its own category, not Plugin Ecosystem', () => {
    // Not a placeholder like the `registry:*` pair: it gates two live routes.
    expect(ALL_PERMISSIONS).toContain('oncall:manage');
    expect(isValidPermission('oncall:manage')).toBe(true);
    expect(PERMISSION_CATALOG.find((m) => m.id === 'oncall:manage')?.category).toBe('On-call');
  });

  it('never appears in a tenant-facing role editor', () => {
    expect(ORG_ASSIGNABLE_CATEGORIES.flatMap((c) => c.permissions.map((m) => m.id))).not.toContain('oncall:manage');
  });

  it('is held implicitly by a superadmin', () => {
    expect(resolveUserPermissions(null, true)).toContain('oncall:manage');
  });
});

describe('plugin ecosystem permissions (docs/plugin-publishing.md)', () => {
  const ORG_ASSIGNABLE = ['plugins:install', 'plugin_installs:manage', 'publishers:manage'] as const;

  // The ecosystem's OWN system-org-only pair. Named explicitly rather than taken
  // from SYSTEM_ORG_ONLY_PERMISSIONS, because that list is no longer the same
  // set: `oncall:manage` joined it and is deliberately NOT an ecosystem
  // permission (see the on-call block below). Iterating the whole list here is
  // what made adding a non-ecosystem one fail four assertions at once.
  const ECOSYSTEM_SYSTEM_ORG_ONLY = ['plugins:moderate', 'publishers:verify'] as const;

  it('adds every ecosystem permission to the catalog', () => {
    for (const p of [...ORG_ASSIGNABLE, ...ECOSYSTEM_SYSTEM_ORG_ONLY]) {
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

  it('SYSTEM_ORG_ONLY_PERMISSIONS are the ecosystem pair, the platform-operations surfaces and the vendor\'s own tasks, in no built-in bundle and never org-assignable', () => {
    expect([...SYSTEM_ORG_ONLY_PERMISSIONS]).toEqual([
      'plugins:moderate', 'publishers:verify',
      // The cross-tenant operator surfaces. Here rather than in a tenant-grantable
      // list because each reads or moves something belonging to an organisation
      // the holder is not a member of.
      // `platform:read` is the DEPLOY's own configuration; `orgs:read` is the
      // customer roster. One permission used to be both, and three of the four
      // job bundles carried it for the roster alone.
      'platform:read', 'orgs:read',
      // `registry:read` was SUPERADMIN-only, which made the registry browser
      // invisible to every Role; `registry:write` followed once the additive
      // half (copy/promote) was split from the destructive one. The destructive
      // rung, `registry:purge`, stays on the flag — see
      // SUPERADMIN_ONLY_PERMISSIONS.
      'registry:read', 'registry:write', 'billing:operate',
      // One permission per console CLASS, by blast radius. Three rather than one
      // so that staffing an operator with Grafana does not also hand over a
      // shell over every tenant's rows, nor the object store that holds the
      // signed audit chain heads.
      'observability_console:open', 'database_console:open', 'objectstore_console:open',
      // Opening a cross-tenant impersonation session. Carried by `Support Lead`
      // and by nothing else — the desk is who needs to see what a customer
      // sees. Emergency access is NOT this permission: `breakglass` bypasses
      // tenant consent and stays on the superadmin flag.
      'impersonation:open',
      'oncall:manage',
      // The vendor's own operational tasks. Each replaced a `requireSystemAdmin`
      // gate, so that one job can be staffed with a Role in the system org
      // instead of a flag that also carries impersonation, a database shell and
      // the ability to mint another superadmin.
      'support_cases:write', 'support_content:write',
      'subscriptions:read', 'subscriptions:manage',
      'orgs:manage', 'quotas:manage', 'plugin_queue:manage',
    ]);
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

  it('ECOSYSTEM_MANAGER_PERMISSIONS: the ecosystem system-org-only pair + moderator reads, nothing tenant-facing', () => {
    expect([...ECOSYSTEM_MANAGER_PERMISSIONS].sort()).toEqual(
      ['messages:read', 'observability:read', 'plugins:moderate', 'plugins:read', 'publishers:verify'],
    );
    for (const p of ECOSYSTEM_MANAGER_PERMISSIONS) expect(isValidPermission(p)).toBe(true);
    for (const p of ECOSYSTEM_SYSTEM_ORG_ONLY) expect(ECOSYSTEM_MANAGER_PERMISSIONS).toContain(p);
    // And NOT `oncall:manage`, although it is system-org-only: paging is the
    // vendor's own operational concern, and widening this Role to carry it
    // would hand the pager to people hired to review plugins.
    expect(ECOSYSTEM_MANAGER_PERMISSIONS).not.toContain('oncall:manage');
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
    expect(intersectPermissions(['pipelines:read', 'org_settings:write'], [])).toEqual([]);
    // Unknown strings in either input never survive.
    expect(intersectPermissions(['bogus'], ['bogus'])).toEqual([]);
  });
});

/**
 * The machine Roles. Their contents ARE the least-privilege claim, so they are
 * pinned exactly: adding a permission here widens what a leaked CI credential
 * can do in every org, and should have to change this test to happen.
 */
describe('machine Roles — least privilege for the stored credentials', () => {
  it('gives Pipeline Automation exactly the two reads the synth, deploy and plugin lookup make', () => {
    expect([...PIPELINE_AUTOMATION_PERMISSIONS].sort()).toEqual(['pipelines:read', 'plugins:read']);
    expect(SEED_BUNDLES.pipeline_automation.permissions).toBe(PIPELINE_AUTOMATION_PERMISSIONS);
  });

  it('gives Pipeline Registration the registry write and nothing else — not even a read', () => {
    expect([...PIPELINE_REGISTRATION_PERMISSIONS]).toEqual(['pipeline_registry:write']);
    expect(SEED_BUNDLES.pipeline_registration.permissions).toBe(PIPELINE_REGISTRATION_PERMISSIONS);
  });

  it('keeps every machine permission org-assignable (seeded in tenants, never system-org-only)', () => {
    for (const id of ORG_AUTOMATION_BUNDLES) {
      for (const p of SEED_BUNDLES[id].permissions) expect({ id, p, ok: isOrgAssignablePermission(p) }).toEqual({ id, p, ok: true });
    }
    for (const id of ORG_AUTOMATION_BUNDLES) expect(SYSTEM_ORG_JOB_BUNDLES).not.toContain(id);
  });

  it('maps every automation account to a machine Role or to none (a scoped key)', () => {
    for (const [account, bundle] of Object.entries(AUTOMATION_ACCOUNT_BUNDLES)) {
      expect({ account, ok: bundle === null || ORG_AUTOMATION_BUNDLES.includes(bundle) }).toEqual({ account, ok: true });
    }
    // The scoped accounts hold NO Role: their key's scope is their whole authority.
    expect(AUTOMATION_ACCOUNT_BUNDLES['reporting-ingest']).toBeNull();
    expect(AUTOMATION_ACCOUNT_BUNDLES['registry-push']).toBeNull();
  });

  // People keep registry access through their Roles rather than an OR'd gate:
  // every built-in bundle that can write pipelines can also register them.
  it('grants pipeline_registry:write beside pipelines:write in every built-in people bundle', () => {
    const bundles = [ROLE_PERMISSIONS.member, ROLE_PERMISSIONS.admin, ...ROLE_TEMPLATES.map((t) => t.permissions)];
    for (const b of bundles) {
      if (b.includes('pipelines:write')) expect(b).toContain('pipeline_registry:write');
    }
  });
});
