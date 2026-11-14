// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every seed bundle resolves to ITS OWN permissions — the assertion whose
 * absence made a whole class of silent privilege drift possible.
 *
 * `builtinRolePermissions` was a nine-branch `if` chain over string literals,
 * ending in a fall-through to the coarse `grantsRole` bundle. Every system-org
 * job Role grants `member`. So a bundle added to the id list WITHOUT its branch
 * did not fail: it quietly resolved to the plain Member bundle, the seeder
 * wrote that, and `rbac-backfill` Pass A re-synced the Role to that wrong value
 * on every boot. The Role existed, appeared on the staffing panel, was
 * assignable, and granted fifteen tenant permissions instead of its job.
 *
 * Nothing anywhere exercised the resolver per bundle, so nothing could notice.
 * The fall-through is now one keyed lookup into api-core's `SEED_BUNDLES`, which
 * makes a missing entry a COMPILE error — and this is the runtime half: it walks
 * every id and refuses the Member bundle as an answer.
 */

import { jest, describe, it, expect } from '@jest/globals';
import {
  ROLE_GRANTS, ROLE_PERMISSIONS, SEED_BUNDLES, SEED_BUNDLE_IDS, SYSTEM_ORG_JOB_BUNDLES,
} from '@pipeline-builder/api-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: jest.fn() }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {},
  RoleAssignment: {},
  User: {},
  UserOrganization: {},
}));

const { builtinRolePermissions } = await import('../src/services/role-authority.js');
const { SYSTEM_ORG_ROLES, DEFAULT_ORG_ROLES } = await import('../src/services/roles-service.js');

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('builtinRolePermissions — every seed bundle resolves to its own bundle', () => {
  it.each(SEED_BUNDLE_IDS)('%s resolves to its own permissions, not the grantsRole fallback', (bundle) => {
    const resolved = builtinRolePermissions({ grantsRole: 'member', seedBundle: bundle });
    expect(sorted(resolved)).toEqual(sorted(SEED_BUNDLES[bundle].permissions));
  });

  /**
   * THE FAILURE MODE, stated as its own case: a bundle that falls through is
   * indistinguishable from one that genuinely grants the Member bundle, so the
   * check above would pass for a broken bundle if any bundle's contents HAPPENED
   * to equal Member's. None does, and this is what keeps that true.
   */
  it.each(SEED_BUNDLE_IDS)('%s is not merely the Member bundle under another name', (bundle) => {
    expect(sorted(SEED_BUNDLES[bundle].permissions)).not.toEqual(sorted(ROLE_PERMISSIONS.member));
  });

  /**
   * Every value of `ROLE_GRANTS`, so a new coarse grant cannot be added without
   * deciding which bundle it takes.
   *
   * Note what is NOT here: `owner`. It is a MEMBERSHIP role
   * (`UserOrganization.role`), never a Role's `grantsRole` — the two
   * vocabularies share three words out of four, and `permissionsForGrantsRole`
   * documented `owner` as if it were a grant until this test would not compile.
   */
  it.each(ROLE_GRANTS)('falls back to the %s bundle for a Role with NO seedBundle', (grantsRole) => {
    const expected = grantsRole === 'member' ? ROLE_PERMISSIONS.member : ROLE_PERMISSIONS.admin;
    expect(sorted(builtinRolePermissions({ grantsRole }))).toEqual(sorted(expected));
  });

  // Boot path: an id written around the model must not take the deployment down,
  // but it must not pass unremarked either.
  it('falls back for an UNKNOWN bundle id rather than throwing', () => {
    const resolved = builtinRolePermissions({
      grantsRole: 'member',
      seedBundle: 'not_a_bundle' as never,
    });
    expect(sorted(resolved)).toEqual(sorted(ROLE_PERMISSIONS.member));
  });
});

describe('the seeded Role set is derived from the one table', () => {
  it('seeds every system-org job bundle, under the name api-core gives it', () => {
    const seeded = new Map(SYSTEM_ORG_ROLES.map((r) => [r.seedBundle, r.name]));
    for (const bundle of SYSTEM_ORG_JOB_BUNDLES) {
      expect({ bundle, name: seeded.get(bundle) })
        .toEqual({ bundle, name: SEED_BUNDLES[bundle].name });
    }
  });

  /**
   * `grantsRole: 'member'` for every job Role, asserted ONCE instead of being
   * restated in seven hand-written specs — which was also seven places it could
   * quietly stop being true. None of them confers admin over the system org.
   */
  it('gives every job Role the coarse member grant, and only the structural Roles anything more', () => {
    for (const spec of SYSTEM_ORG_ROLES) {
      if (!spec.seedBundle) continue; // Super Admin / Admin / Member
      expect({ name: spec.name, grantsRole: spec.grantsRole })
        .toEqual({ name: spec.name, grantsRole: 'member' });
    }
  });

  it('keeps the structural Roles, in order, ahead of the jobs', () => {
    expect(SYSTEM_ORG_ROLES.slice(0, 1 + DEFAULT_ORG_ROLES.length).map((r) => r.name))
      .toEqual(['Super Admin', ...DEFAULT_ORG_ROLES.map((r) => r.name)]);
  });

  // `team_lead` is a tenant job and a TEMPLATE now, so it is a seed bundle
  // (legacy Roles keep theirs, and Pass A keeps it current) without being
  // seeded anywhere.
  it('does not seed team_lead, which became a template', () => {
    expect(SYSTEM_ORG_JOB_BUNDLES).not.toContain('team_lead');
    expect(SYSTEM_ORG_ROLES.map((r) => r.seedBundle)).not.toContain('team_lead');
    expect(SEED_BUNDLE_IDS).toContain('team_lead');
  });
});
