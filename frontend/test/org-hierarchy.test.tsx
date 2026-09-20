// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org → team hierarchy signal and the home-dashboard surfaces it drives:
 * hierarchy UI renders only when the active org parents teams (or, for the
 * "pooled" note, only when it IS a team).
 */

import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { UserOrgMembership } from '@/types';

let mockAuth: { user: { organizationId?: string; permissions?: string[] } | null; organizations: UserOrgMembership[] };
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => mockAuth }));

jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => false, isLoaded: true, isSuperAdmin: false }),
}));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnQuotas: jest.fn().mockResolvedValue({ success: false }),
    listInvitations: jest.fn().mockResolvedValue({ success: false }),
    getComplianceAuditLog: jest.fn().mockResolvedValue({ success: false }),
    getMfaPolicy: jest.fn().mockResolvedValue({
      success: true,
      data: { requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false, defaultGraceDays: 14, enrolment: { members: 4, enrolled: 1 } },
    }),
  },
}));
jest.mock('@/lib/query-cache', () => ({
  __esModule: true,
  runQuery: jest.fn().mockResolvedValue({ success: true, data: { members: [], pagination: { total: 4 } } }),
}));

import { useOrgHierarchy } from '../src/hooks/useOrgHierarchy';
import { OrgAdminHome } from '../src/components/dashboard/OrgAdminHome';

const org = (over: Partial<UserOrgMembership>): UserOrgMembership => ({
  id: 'root', name: 'Root', role: 'owner', childOrgCount: 0, ...over,
});

describe('useOrgHierarchy', () => {
  it('flat org: neither a parent nor a team', () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({})] };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current).toMatchObject({ isChildOrg: false, hasChildOrgs: false, childOrgCount: 0 });
  });

  it('parent org: hasChildOrgs from its membership row\'s childOrgCount', () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({ childOrgCount: 3 })] };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current).toMatchObject({ isChildOrg: false, hasChildOrgs: true, childOrgCount: 3 });
  });

  it('team: isChildOrg with its parent id, and no children of its own', () => {
    mockAuth = {
      user: { organizationId: 'team-a' },
      organizations: [org({ childOrgCount: 1 }), org({ id: 'team-a', name: 'A', parentOrgId: 'root' })],
    };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current).toMatchObject({ isChildOrg: true, hasChildOrgs: false, parentOrgId: 'root' });
  });

  it('reads the ACTIVE org, not any parent the user also belongs to', () => {
    mockAuth = {
      user: { organizationId: 'solo' },
      organizations: [org({ childOrgCount: 2 }), org({ id: 'solo', name: 'Solo' })],
    };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current.hasChildOrgs).toBe(false);
  });

  it('is inert before the org list loads', () => {
    mockAuth = { user: null, organizations: [] };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current).toMatchObject({ activeOrg: undefined, isChildOrg: false, hasChildOrgs: false });
  });
});

describe('OrgAdminHome — hierarchy tiles', () => {
  it('shows the Teams tile with the count only when the org parents teams', async () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({ childOrgCount: 2 })] };
    render(<OrgAdminHome organizationId="root" />);
    expect(await screen.findByText('Teams')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides the Teams tile on a flat org', async () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({})] };
    render(<OrgAdminHome organizationId="root" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument());
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    expect(screen.queryByText(/pooled across the parent/i)).not.toBeInTheDocument();
  });

  it('tells a team its quota is pooled across the parent', async () => {
    mockAuth = { user: { organizationId: 'team-a' }, organizations: [org({ id: 'team-a', parentOrgId: 'root' })] };
    render(<OrgAdminHome organizationId="team-a" />);
    expect(await screen.findByText(/pooled across the parent organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
  });
});

describe('OrgAdminHome — organization security card', () => {
  it('is shown to a holder of org:settings', async () => {
    mockAuth = { user: { organizationId: 'root', permissions: ['org:settings'] }, organizations: [org({})] };
    render(<OrgAdminHome organizationId="root" />);
    expect(await screen.findByRole('heading', { name: 'Organization security' })).toBeInTheDocument();
    expect(await screen.findByText('3 of 4')).toBeInTheDocument();
  });

  it('is hidden without org:settings', async () => {
    mockAuth = { user: { organizationId: 'root', permissions: [] }, organizations: [org({})] };
    render(<OrgAdminHome organizationId="root" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Organization security' })).not.toBeInTheDocument();
  });
});
