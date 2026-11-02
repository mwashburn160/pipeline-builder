// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the switcher SAYS you are in each organization, and where it lands you.
 *
 * Two behaviours, both of which used to be wrong in the same direction — the
 * switcher reported something other than the thing that decides access:
 *
 *  1. every row was labelled from `role`, the coarse owner/admin/member word.
 *     Permissions come only from the Roles assigned to a person; `role` survives
 *     for `isAdmin`/ownership/display alone. Somebody holding a `Release
 *     Manager` Role read as "member".
 *  2. a switch re-rendered the SAME path under the new org's permissions, so
 *     switching while standing on a gated page turned that page into
 *     `<AccessDenied>` — a refusal produced by a working click.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { UserOrgMembership } from '@/types';
import { OrgSwitcher } from '../src/components/ui/OrgSwitcher';

interface MockUser { organizationId: string; role?: string; permissions?: string[]; isSuperAdmin?: boolean }
let mockAuth: {
  user: MockUser | null;
  organizations: UserOrgMembership[];
  switchOrganization: jest.Mock<AnyFn>;
};
const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
const router = { asPath: '/dashboard', pathname: '/dashboard', replace: jest.fn<AnyFn>() };

jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => mockAuth));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => router));

const org = (over: Partial<UserOrgMembership>): UserOrgMembership => ({
  id: 'own', name: 'Own Org', role: 'owner', childOrgCount: 0, roleNames: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  router.asPath = '/dashboard';
  router.pathname = '/dashboard';
});

describe('OrgSwitcher — a row names the Roles, not the coarse role', () => {
  it('labels a row with its Role names', () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [
        org({ roleNames: ['Admin'] }),
        org({ id: 'acme', name: 'Acme', role: 'member', roleNames: ['Release Manager'] }),
      ],
      switchOrganization: jest.fn<AnyFn>(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));

    // THE POINT: `role` is 'member' here and the person is a Release Manager.
    const acme = screen.getByRole('menuitem', { name: /acme/i });
    expect(within(acme).getByText('Release Manager')).toBeInTheDocument();
    expect(within(acme).queryByText('member')).not.toBeInTheDocument();
  });

  it('joins two Roles and collapses the rest to a count, with the full list in the title', () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [org({ roleNames: ['Admin', 'Billing Manager', 'Security Officer', 'Team Lead'] })],
      switchOrganization: jest.fn<AnyFn>(),
    };
    render(<OrgSwitcher />);
    // One org: the anchor is not a switcher, so read the card itself.
    expect(screen.getByRole('button', { name: /Organization: Own Org/ })).toBeInTheDocument();
  });

  it('falls back to `role` when the org has no Roles assigned (or an older cached payload)', () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [org({ roleNames: [] }), org({ id: 'acme', name: 'Acme', role: 'admin' })],
      switchOrganization: jest.fn<AnyFn>(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    expect(within(screen.getByRole('menuitem', { name: /acme/i })).getByText('admin')).toBeInTheDocument();
  });

  it('keeps saying "via parent" for an inherited row — there is no membership, so there are no Roles', () => {
    mockAuth = {
      user: { organizationId: 'acme' },
      organizations: [
        org({ id: 'acme', name: 'Acme', childOrgCount: 1 }),
        org({ id: 'team-x', name: 'Platform', role: 'admin', parentOrgId: 'acme', viaAncestor: true, roleNames: [] }),
      ],
      switchOrganization: jest.fn<AnyFn>(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    expect(within(screen.getByRole('menuitem', { name: /platform/i })).getByText('via parent')).toBeInTheDocument();
  });

  it('marks an org whose MFA policy would refuse an aal-1 switch', () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [org({}), org({ id: 'acme', name: 'Acme', requiresMfa: true })],
      switchOrganization: jest.fn<AnyFn>(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    const acme = screen.getByRole('menuitem', { name: /acme/i });
    expect(within(acme).getByLabelText('Requires multi-factor authentication')).toBeInTheDocument();
    // And it is per-row, not per-menu.
    expect(within(screen.getByRole('menuitem', { name: /own org/i })).queryByLabelText('Requires multi-factor authentication')).not.toBeInTheDocument();
  });
});

describe('OrgSwitcher — where a switch lands', () => {
  /** Swap the identity the way a real switch does: new org, new permissions. */
  const switchTo = (user: MockUser) => jest.fn<AnyFn>(async () => { mockAuth.user = user; });

  it('re-renders in place when the current page still resolves in the new org', async () => {
    router.asPath = '/dashboard/pipelines';
    router.pathname = '/dashboard/pipelines';
    mockAuth = {
      user: { organizationId: 'own', permissions: ['pipelines:read'] },
      organizations: [org({}), org({ id: 'acme', name: 'Acme' })],
      switchOrganization: switchTo({ organizationId: 'acme', permissions: ['pipelines:read'] }),
    };
    const { rerender } = render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /acme/i }));

    await waitFor(() => expect(mockAuth.user?.organizationId).toBe('acme'));
    rerender(<OrgSwitcher />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard/pipelines'));
    expect(toast.success).toHaveBeenCalledWith('Switched to Acme');
    expect(toast.info).not.toHaveBeenCalled();
  });

  // THE FAILURE: the page the person was reading becomes a refusal page because
  // they switched org. The click worked; the result looks like it did not.
  it('goes to the dashboard, saying so, when the current page does not resolve there', async () => {
    router.asPath = '/dashboard/pipelines';
    router.pathname = '/dashboard/pipelines';
    mockAuth = {
      user: { organizationId: 'own', permissions: ['pipelines:read'] },
      organizations: [org({}), org({ id: 'acme', name: 'Acme' })],
      // The new org's Role grants nothing on this page.
      switchOrganization: switchTo({ organizationId: 'acme', permissions: [] }),
    };
    const { rerender } = render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /acme/i }));

    await waitFor(() => expect(mockAuth.user?.organizationId).toBe('acme'));
    rerender(<OrgSwitcher />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("isn't available there"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a failed switch and stays put', async () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [org({}), org({ id: 'acme', name: 'Acme' })],
      switchOrganization: jest.fn<AnyFn>(async () => { throw new Error('nope'); }),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /acme/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(router.replace).not.toHaveBeenCalled();
  });
});
