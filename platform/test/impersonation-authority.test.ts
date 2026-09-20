// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for WHO may open an impersonation session.
 *
 * The boundary under test is strictly downward: a sysadmin reaches anyone, a
 * parent-org admin reaches into its own subtree, and nothing else qualifies.
 * The same-org case is called out explicitly because it is the tempting mistake
 * — `canAdministerOrg` would admit it, which would silently turn this into
 * "any org admin may view as any of their members".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIsSystemAdmin = jest.fn();
const mockIsAncestorOrg = jest.fn();

// Spread the REAL api-core (apiCoreMock) rather than an inline literal: the real
// controller-helper this suite now loads pulls `createLogger`, `isSystemOrgId`,
// `normalizeOrgId` and `sendError` from the barrel, and a one-key literal linked
// them as undefined.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: (...a: unknown[]) => mockIsSystemAdmin(...a),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
}));

const { resolveImpersonationAuthority } = await import('../src/helpers/impersonation-authority.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
// `isOrgAdmin` runs for real and reads `req.user.role`, so org-admin authority is
// expressed by the FIXTURE rather than by stubbing the predicate.
const adminOf = (organizationId?: string) => ({ user: { sub: 'caller', organizationId, role: 'admin' } }) as any;
const memberOf = (organizationId?: string) => ({ user: { sub: 'caller', organizationId } }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSystemAdmin.mockReturnValue(false);
  mockIsAncestorOrg.mockResolvedValue(false);
});

describe('resolveImpersonationAuthority', () => {
  it('admits a sysadmin for any target', async () => {
    mockIsSystemAdmin.mockReturnValue(true);

    await expect(resolveImpersonationAuthority(adminOf('sys'), 'org-any')).resolves.toEqual({ kind: 'sysadmin' });
    // A sysadmin needs no hierarchy lookup at all.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('admits a sysadmin even with no pinned org', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    await expect(resolveImpersonationAuthority(adminOf('sys'), undefined)).resolves.toEqual({ kind: 'sysadmin' });
  });

  it('admits a parent-org admin reaching into its own subtree', async () => {
    mockIsAncestorOrg.mockResolvedValue(true);

    await expect(resolveImpersonationAuthority(adminOf('org-parent'), 'org-team')).resolves.toEqual({
      kind: 'ancestor', viaOrgId: 'org-parent',
    });
    expect(mockIsAncestorOrg).toHaveBeenCalledWith('org-parent', 'org-team');
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

  it('refuses a non-sysadmin when the session has no pinned org', async () => {

    // No pinned org means no subtree to be inside of.
    await expect(resolveImpersonationAuthority(adminOf('org-parent'), undefined)).resolves.toEqual({ kind: 'none' });
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a caller with no active org', async () => {
    await expect(resolveImpersonationAuthority(adminOf(undefined), 'org-team')).resolves.toEqual({ kind: 'none' });
  });
});
