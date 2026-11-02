// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for WHO may open an impersonation session.
 *
 * The boundary under test is strictly downward: a system-org member holding
 * `impersonation:open` reaches anyone, a parent-org admin holding
 * `team_access:open` reaches into its own subtree, and nothing else qualifies.
 * The same-org case is called out explicitly because it is the tempting mistake
 * — `canAdministerOrg` would admit it, which would silently turn this into
 * "any org admin may view as any of their members".
 *
 * BOTH halves of each branch matter, and each has its own case below:
 *  - the vendor branch needs the system org AND the permission, because
 *    `team_access:open` is org-assignable and a permission claim alone must
 *    never carry a tenant across the boundary;
 *  - the tenant branch needs the admin label AND the permission, so an org can
 *    withhold team access from an admin with a custom Role.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIsAncestorOrg = jest.fn<AnyFn>();

// `isSystemOrgId` and `userHasPermission` run FOR REAL (they only read the
// claim), so authority is expressed entirely by the fixture — which is the point:
// a stubbed predicate could not have caught "the permission is checked but the
// org is not".
//
// Spread the REAL api-core (apiCoreMock) rather than an inline literal: the real
// controller-helper this suite loads pulls `createLogger`, `isSystemOrgId`,
// `normalizeOrgId` and `sendError` from the barrel, and a one-key literal linked
// them as undefined.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
}));

const { resolveImpersonationAuthority } = await import('../src/helpers/impersonation-authority.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The default `SYSTEM_ORG_ID` — what `isSystemOrgId` accepts. */
const SYSTEM_ORG = '000000000000000000000001';

// `isOrgAdmin` runs for real and reads `req.user.role`, so org-admin authority is
// expressed by the FIXTURE rather than by stubbing the predicate. So are the
// permissions: a tenant admin holds `team_access:open` because it is in the
// admin bundle.
const adminOf = (organizationId?: string) => ({
  user: { sub: 'caller', organizationId, role: 'admin', permissions: ['team_access:open'] },
}) as any;
const memberOf = (organizationId?: string) => ({ user: { sub: 'caller', organizationId, permissions: [] } }) as any;
/** A system-org member holding `impersonation:open` — the Support Lead shape, no flag. */
const platformOf = (permissions: string[] = ['impersonation:open']) => ({
  user: { sub: 'caller', organizationId: SYSTEM_ORG, role: 'member', permissions },
}) as any;
/** The superadmin flag, which implies every permission. */
const superadminOf = (organizationId = SYSTEM_ORG, role?: string) => ({
  user: { sub: 'caller', organizationId, role, isSuperAdmin: true },
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAncestorOrg.mockResolvedValue(false);
});

describe('resolveImpersonationAuthority', () => {
  it('admits a system-org holder of impersonation:open for any target, with no flag', async () => {
    await expect(resolveImpersonationAuthority(platformOf(), 'org-any')).resolves.toEqual({ kind: 'platform' });
    // The vendor branch needs no hierarchy lookup at all.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('admits a superadmin, who holds the permission implicitly', async () => {
    await expect(resolveImpersonationAuthority(superadminOf(), 'org-any')).resolves.toEqual({ kind: 'platform' });
  });

  it('admits the vendor branch even with no pinned target org', async () => {
    await expect(resolveImpersonationAuthority(platformOf(), undefined)).resolves.toEqual({ kind: 'platform' });
  });

  // THE FENCE. `team_access:open` is org-assignable, so any tenant admin holds
  // it; if the vendor branch tested the permission alone, one of them would get
  // cross-tenant authority over every organization in the deployment.
  it('refuses a TENANT caller who holds impersonation:open in their claim', async () => {
    const tenantWithSystemPerm = {
      user: { sub: 'caller', organizationId: 'org-a', role: 'admin', permissions: ['impersonation:open'] },
    } as any;
    await expect(resolveImpersonationAuthority(tenantWithSystemPerm, 'org-b')).resolves.toEqual({ kind: 'none' });
  });

  // And the other half: a system-org MEMBER who was never given the permission
  // gets nothing from being in the system org.
  it('refuses a system-org member without impersonation:open', async () => {
    await expect(resolveImpersonationAuthority(platformOf([]), 'org-any')).resolves.toEqual({ kind: 'none' });
  });

  // A BEHAVIOUR CHANGE, pinned deliberately. A superadmin whose ACTIVE org is a
  // tenant now has NO impersonation authority and must switch back to the system
  // org — the vendor branch requires the system org, and `isOrgAdmin` refuses a
  // superadmin outright (controller-helper, so the flag cannot borrow the tenant
  // branch either).
  //
  // This makes impersonation consistent with every other cross-tenant surface,
  // all of which run `requireSystemOrg` and would already refuse the same
  // caller. It is also what token confinement has always implied:
  // `confinePermissionsToOrg` strips system-org-only ids from any token whose
  // active org is a tenant, so the only thing that kept impersonation reachable
  // from a tenant seat was `hasPermission`'s superadmin short-circuit.
  it('refuses a superadmin whose ACTIVE org is a tenant — they must switch to the system org', async () => {
    mockIsAncestorOrg.mockResolvedValue(true);
    for (const role of ['admin', 'owner', undefined]) {
      await expect(resolveImpersonationAuthority(superadminOf('org-parent', role), 'org-team'))
        .resolves.toEqual({ kind: 'none' });
    }
  });

  it('admits a parent-org admin reaching into its own subtree', async () => {
    mockIsAncestorOrg.mockResolvedValue(true);

    await expect(resolveImpersonationAuthority(adminOf('org-parent'), 'org-team')).resolves.toEqual({
      kind: 'ancestor', viaOrgId: 'org-parent',
    });
    expect(mockIsAncestorOrg).toHaveBeenCalledWith('org-parent', 'org-team');
  });

  // The delegation this permission exists for: an org may take team access away
  // from one of its admins without demoting them.
  it('refuses a parent-org admin whose Role withholds team_access:open', async () => {
    mockIsAncestorOrg.mockResolvedValue(true);
    const strippedAdmin = {
      user: { sub: 'caller', organizationId: 'org-parent', role: 'admin', permissions: ['members:manage'] },
    } as any;
    await expect(resolveImpersonationAuthority(strippedAdmin, 'org-team')).resolves.toEqual({ kind: 'none' });
    // Refused before any hierarchy lookup — no authority to scope.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a CHILD admin reaching up at the parent', async () => {
    // isAncestorOrg walks the TARGET's parents; parent is not below child.
    mockIsAncestorOrg.mockResolvedValue(false);

    await expect(resolveImpersonationAuthority(adminOf('org-team'), 'org-parent')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a SIBLING team admin', async () => {
    mockIsAncestorOrg.mockResolvedValue(false); // same tree, but not an ancestor

    await expect(resolveImpersonationAuthority(adminOf('org-team-a'), 'org-team-b')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses an admin of the target\'s OWN org', async () => {
    // The real isAncestorOrg returns false when the ids are equal — an org is
    // not its own ancestor. This is the line between "a parent manages its
    // teams" and "any admin may view any of their members".
    mockIsAncestorOrg.mockImplementation(async (a: unknown, b: unknown) => a !== b);

    await expect(resolveImpersonationAuthority(adminOf('org-a'), 'org-a')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a non-admin member even inside the subtree', async () => {
    mockIsAncestorOrg.mockResolvedValue(true);

    await expect(resolveImpersonationAuthority(memberOf('org-parent'), 'org-team')).resolves.toEqual({ kind: 'none' });
    // Refused before any hierarchy lookup — a member has no authority to scope.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a tenant admin when the session has no pinned org', async () => {

    // No pinned org means no subtree to be inside of.
    await expect(resolveImpersonationAuthority(adminOf('org-parent'), undefined)).resolves.toEqual({ kind: 'none' });
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a caller with no active org', async () => {
    await expect(resolveImpersonationAuthority(adminOf(undefined), 'org-team')).resolves.toEqual({ kind: 'none' });
  });
});
