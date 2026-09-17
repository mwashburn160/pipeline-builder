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

const mockIsSystemAdmin = jest.fn();
const mockIsOrgAdmin = jest.fn();
const mockIsAncestorOrg = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  isSystemAdmin: (...a: unknown[]) => mockIsSystemAdmin(...a),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  isOrgAdmin: (...a: unknown[]) => mockIsOrgAdmin(...a),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a),
}));

const { resolveImpersonationAuthority } = await import('../src/helpers/impersonation-authority.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const reqAs = (organizationId?: string) => ({ user: { sub: 'caller', organizationId } }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSystemAdmin.mockReturnValue(false);
  mockIsOrgAdmin.mockReturnValue(false);
  mockIsAncestorOrg.mockResolvedValue(false);
});

describe('resolveImpersonationAuthority', () => {
  it('admits a sysadmin for any target', async () => {
    mockIsSystemAdmin.mockReturnValue(true);

    await expect(resolveImpersonationAuthority(reqAs('sys'), 'org-any')).resolves.toEqual({ kind: 'sysadmin' });
    // A sysadmin needs no hierarchy lookup at all.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('admits a sysadmin even with no pinned org', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    await expect(resolveImpersonationAuthority(reqAs('sys'), undefined)).resolves.toEqual({ kind: 'sysadmin' });
  });

  it('admits a parent-org admin reaching into its own subtree', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    mockIsAncestorOrg.mockResolvedValue(true);

    await expect(resolveImpersonationAuthority(reqAs('org-parent'), 'org-team')).resolves.toEqual({
      kind: 'ancestor', viaOrgId: 'org-parent',
    });
    expect(mockIsAncestorOrg).toHaveBeenCalledWith('org-parent', 'org-team');
  });

  it('refuses a CHILD admin reaching up at the parent', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    // isAncestorOrg walks the TARGET's parents; parent is not below child.
    mockIsAncestorOrg.mockResolvedValue(false);

    await expect(resolveImpersonationAuthority(reqAs('org-team'), 'org-parent')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a SIBLING team admin', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    mockIsAncestorOrg.mockResolvedValue(false); // same tree, but not an ancestor

    await expect(resolveImpersonationAuthority(reqAs('org-team-a'), 'org-team-b')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses an admin of the target\'s OWN org', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    // The real isAncestorOrg returns false when the ids are equal — an org is
    // not its own ancestor. This is the line between "a parent manages its
    // teams" and "any admin may view any of their members".
    mockIsAncestorOrg.mockImplementation(async (a: unknown, b: unknown) => a !== b);

    await expect(resolveImpersonationAuthority(reqAs('org-a'), 'org-a')).resolves.toEqual({ kind: 'none' });
  });

  it('refuses a non-admin member even inside the subtree', async () => {
    mockIsOrgAdmin.mockReturnValue(false);
    mockIsAncestorOrg.mockResolvedValue(true);

    await expect(resolveImpersonationAuthority(reqAs('org-parent'), 'org-team')).resolves.toEqual({ kind: 'none' });
    // Refused before any hierarchy lookup — a member has no authority to scope.
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a non-sysadmin when the session has no pinned org', async () => {
    mockIsOrgAdmin.mockReturnValue(true);

    // No pinned org means no subtree to be inside of.
    await expect(resolveImpersonationAuthority(reqAs('org-parent'), undefined)).resolves.toEqual({ kind: 'none' });
    expect(mockIsAncestorOrg).not.toHaveBeenCalled();
  });

  it('refuses a caller with no active org', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    await expect(resolveImpersonationAuthority(reqAs(undefined), 'org-team')).resolves.toEqual({ kind: 'none' });
  });
});
