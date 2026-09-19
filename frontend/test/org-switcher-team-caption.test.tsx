// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A team whose parent the user isn't a member of renders at the switcher's top
 * level — so it must say whose team it is, or it passes for an account.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import type { UserOrgMembership } from '@/types';
import { OrgSwitcher } from '../src/components/ui/OrgSwitcher';

let mockAuth: { user: { organizationId: string } | null; organizations: UserOrgMembership[]; switchOrganization: jest.Mock };
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => mockAuth }));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => ({ asPath: '/dashboard', replace: jest.fn() }) }));
jest.mock('@/hooks/usePlugins', () => ({ __esModule: true, clearPluginCache: jest.fn() }));

const org = (over: Partial<UserOrgMembership>): UserOrgMembership => ({
  id: 'own', name: 'Own Org', role: 'owner', childOrgCount: 0, ...over,
});

describe('OrgSwitcher — orphan team caption', () => {
  it('captions a top-level-listed team "Team of {parent}" in the menu', () => {
    mockAuth = {
      user: { organizationId: 'own' },
      organizations: [org({}), org({ id: 'team-x', name: 'Platform', role: 'member', parentOrgId: 'acme', parentOrgName: 'Acme Corp' })],
      switchOrganization: jest.fn(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    const item = screen.getByRole('menuitem', { name: /platform/i });
    expect(within(item).getByText('Team of Acme Corp')).toBeInTheDocument();
    // A root row carries no team caption.
    expect(within(screen.getByRole('menuitem', { name: /own org/i })).queryByText(/team of/i)).not.toBeInTheDocument();
  });

  it('does not caption a team nested under a parent the user belongs to (it is indented instead)', () => {
    mockAuth = {
      user: { organizationId: 'acme' },
      organizations: [
        org({ id: 'acme', name: 'Acme Corp', childOrgCount: 1 }),
        org({ id: 'team-x', name: 'Platform', parentOrgId: 'acme', parentOrgName: 'Acme Corp' }),
      ],
      switchOrganization: jest.fn(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    expect(screen.queryByText('Team of Acme Corp')).not.toBeInTheDocument();
    expect(within(screen.getByRole('menuitem', { name: /platform/i })).getByText('team')).toBeInTheDocument();
  });

  it('captions the active team card with its parent', () => {
    mockAuth = {
      user: { organizationId: 'team-x' },
      organizations: [org({ id: 'team-x', name: 'Platform', parentOrgId: 'acme', parentOrgName: 'Acme Corp' })],
      switchOrganization: jest.fn(),
    };
    render(<OrgSwitcher />);
    expect(screen.getByText('Team of Acme Corp')).toBeInTheDocument();
  });

  it('falls back to "Team" when the parent name is unknown', () => {
    mockAuth = {
      user: { organizationId: 'team-x' },
      organizations: [org({ id: 'team-x', name: 'Platform', parentOrgId: 'acme' })],
      switchOrganization: jest.fn(),
    };
    render(<OrgSwitcher />);
    expect(screen.getByText('Team')).toBeInTheDocument();
  });
});

describe('OrgSwitcher — inherited (via-parent) teams', () => {
  it('lists a team reached through parent-admin authority, labelled "via parent"', () => {
    mockAuth = {
      user: { organizationId: 'acme' },
      organizations: [
        org({ id: 'acme', name: 'Acme', childOrgCount: 1 }),
        org({ id: 'team-y', name: 'Payments', role: 'admin', parentOrgId: 'acme', parentOrgName: 'Acme', viaAncestor: true }),
      ],
      switchOrganization: jest.fn(),
    };
    render(<OrgSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
    const item = screen.getByRole('menuitem', { name: /payments/i });
    expect(within(item).getByText('via parent')).toBeInTheDocument();
  });
});
