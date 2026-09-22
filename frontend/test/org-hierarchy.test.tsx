// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org → team hierarchy signal and the home-dashboard surfaces it drives:
 * hierarchy UI renders only when the active org parents teams (or, for the
 * "pooled" note, only when it IS a team).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { UserOrgMembership } from '@/types';

let mockAuth: { user: { organizationId?: string; permissions?: string[] } | null; organizations: UserOrgMembership[] };
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => mockAuth));

jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => false, isLoaded: true, isSuperAdmin: false }),
}));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnQuotas: jest.fn<AnyFn>().mockResolvedValue({ success: false }),
    listInvitations: jest.fn<AnyFn>().mockResolvedValue({ success: false }),
    getComplianceAuditLog: jest.fn<AnyFn>().mockResolvedValue({ success: false }),
    getMfaPolicy: jest.fn<AnyFn>().mockResolvedValue({
      success: true,
      data: { requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false, defaultGraceDays: 14, enrolment: { members: 4, enrolled: 1, declined: 0 } },
    }),
  },
}));
jest.mock('@/lib/query-cache', () => ({
  __esModule: true,
  runQuery: jest.fn<AnyFn>().mockResolvedValue({ success: true, data: { members: [], pagination: { total: 4 } } }),
}));

import { useOrgHierarchy } from '../src/hooks/useOrgHierarchy';
import { OrgAdminHome } from '../src/components/dashboard/OrgAdminHome';
import { POOLING_TITLE } from '../src/components/quotas/constants';

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
    expect(result.current).toMatchObject({ activeOrg: undefined, isChildOrg: false, hasChildOrgs: false, viaAncestor: false });
  });

  it('flags an inherited-authority session (admin of the parent, not a member here)', () => {
    mockAuth = {
      user: { organizationId: 'team-y' },
      organizations: [
        org({ id: 'acme', name: 'Acme', childOrgCount: 1 }),
        org({ id: 'team-y', name: 'Payments', role: 'admin', parentOrgId: 'acme', parentOrgName: 'Acme', viaAncestor: true }),
      ],
    };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current).toMatchObject({ isChildOrg: true, viaAncestor: true, parentOrgName: 'Acme' });
  });

  it('a real membership in a team is NOT via-ancestor', () => {
    mockAuth = {
      user: { organizationId: 'team-y' },
      organizations: [org({ id: 'team-y', name: 'Payments', parentOrgId: 'acme' })],
    };
    expect(renderHook(() => useOrgHierarchy()).result.current.viaAncestor).toBe(false);
  });

  it('names the active org\'s teams, falling back to the id for one it cannot see', () => {
    mockAuth = {
      user: { organizationId: 'root' },
      organizations: [
        org({ childOrgCount: 2 }),
        org({ id: 'team-a', name: 'Payments', parentOrgId: 'root' }),
        org({ id: 'other', name: 'Elsewhere', parentOrgId: 'somewhere-else' }),
      ],
    };
    const { result } = renderHook(() => useOrgHierarchy());
    expect(result.current.childOrgs.map((o) => o.id)).toEqual(['team-a']);
    expect(result.current.teamName('team-a')).toBe('Payments');
    expect(result.current.teamName('team-unknown')).toBe('team-unknown');
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

  // The wording is the app-wide pooling constant; these assert the GATING —
  // both hierarchy states say it, a flat org says nothing.
  it('tells a team its quota is pooled with the rest of the account', async () => {
    mockAuth = { user: { organizationId: 'team-a' }, organizations: [org({ id: 'team-a', parentOrgId: 'root' })] };
    render(<OrgAdminHome organizationId="team-a" />);
    expect(await screen.findByText(POOLING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
  });

  it('tells a PARENT its quota figures already include its teams', async () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({ childOrgCount: 2 })] };
    render(<OrgAdminHome organizationId="root" />);
    expect(await screen.findByText(POOLING_TITLE)).toBeInTheDocument();
  });

  it('says nothing about pooling on a flat org', async () => {
    mockAuth = { user: { organizationId: 'root' }, organizations: [org({})] };
    render(<OrgAdminHome organizationId="root" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument());
    expect(screen.queryByText(POOLING_TITLE)).not.toBeInTheDocument();
  });
});

describe('OrgAdminHome — inherited authority', () => {
  it('says the viewer is not on the roster when they reach the team via its parent', async () => {
    mockAuth = {
      user: { organizationId: 'team-a' },
      organizations: [
        org({ id: 'acme', name: 'Acme', childOrgCount: 1 }),
        org({ id: 'team-a', name: 'Payments', role: 'admin', parentOrgId: 'acme', parentOrgName: 'Acme', viaAncestor: true }),
      ],
    };
    render(<OrgAdminHome organizationId="team-a" />);
    expect(await screen.findByText(/you administer this team through acme/i)).toBeInTheDocument();
    expect(screen.getByText(/use none of its seats/i)).toBeInTheDocument();
  });

  it('says nothing of the sort for a real member of the team', async () => {
    mockAuth = {
      user: { organizationId: 'team-a' },
      organizations: [org({ id: 'team-a', name: 'Payments', parentOrgId: 'acme', parentOrgName: 'Acme' })],
    };
    render(<OrgAdminHome organizationId="team-a" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument());
    expect(screen.queryByText(/you administer this team through/i)).not.toBeInTheDocument();
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
