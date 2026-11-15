// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The invitations page's TEAM view.
 *
 * An invitation sent into a team lives on that team, so the active org's own
 * listing never shows it. With teams, the page offers a team selector that
 * lists the chosen team's invitations (`GET /invitation?targetOrgId=`), whose
 * rows revoke and re-send like any other. A flat org shows no selector.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, mockOrgHierarchy, pageToast } from './helpers/pageMocks';
import InvitationsPage from '../pages/dashboard/invitations';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

const mockRouter = { query: {}, pathname: '/dashboard/invitations', asPath: '/dashboard/invitations', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: { organizationId: 'org-1' } })));

const TEAM_INVITE = {
  id: 'inv-team', email: 'dev@x.io', role: 'member', status: 'pending', invitedBy: 'u1', inviterName: 'Ada',
  invitationType: 'email', createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
};

const listInvitations = jest.fn<AnyFn>(async (params?: { targetOrgId?: string }) => ({
  success: true,
  data: {
    invitations: params?.targetOrgId === 'team-1' ? [TEAM_INVITE] : [],
    pagination: { total: params?.targetOrgId === 'team-1' ? 1 : 0, offset: 0, limit: 25 },
  },
}));
const getOrganizationTeams = jest.fn<AnyFn>(async () => ({
  success: true, data: { teams: [{ orgId: 'team-1', orgName: 'Platform team', parentOrgId: 'org-1' }] },
}));
const revokeInvitation = jest.fn<AnyFn>(async () => ({ success: true }));
const resendInvitation = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listInvitations: (...a: unknown[]) => listInvitations(...(a as [])),
    getOrganizationTeams: (...a: unknown[]) => getOrganizationTeams(...(a as [])),
    getOrganizationSeatUsage: jest.fn<AnyFn>(async () => ({ success: true, data: null })),
    revokeInvitation: (...a: unknown[]) => revokeInvitation(...(a as [])),
    resendInvitation: (...a: unknown[]) => resendInvitation(...(a as [])),
    sendInvitations: jest.fn<AnyFn>(),
  },
}));

async function selectTeam() {
  render(<InvitationsPage />);
  const selector = await screen.findByLabelText(/filter by team/i);
  await screen.findByRole('option', { name: 'Platform team' });
  fireEvent.change(selector, { target: { value: 'team-1' } });
  await screen.findByText('dev@x.io');
}

describe('invitations page — team view', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ isAdmin: true, can: () => true });
    mockOrgHierarchy({ childOrgCount: 1 });
  });

  it('shows no team selector on an org without teams', async () => {
    mockOrgHierarchy();
    render(<InvitationsPage />);
    await waitFor(() => expect(listInvitations).toHaveBeenCalled());
    expect(screen.queryByLabelText(/filter by team/i)).toBeNull();
    expect(getOrganizationTeams).not.toHaveBeenCalled();
  });

  it("lists the chosen team's invitations via targetOrgId", async () => {
    await selectTeam();
    expect(listInvitations).toHaveBeenCalledWith(expect.objectContaining({ targetOrgId: 'team-1' }));
    // The org's own view sends no target.
    expect(listInvitations.mock.calls[0][0]).not.toHaveProperty('targetOrgId');
  });

  it("revokes a team's invitation", async () => {
    await selectTeam();
    fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith('inv-team'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/dev@x\.io revoked/)));
  });

  it("re-sends a team's invitation, warning when no mail transport is configured", async () => {
    resendInvitation.mockResolvedValue({ success: true, data: { expiresAt: '2026-12-08T00:00:00Z', delivery: 'not-configured' } });
    await selectTeam();
    fireEvent.click(screen.getByRole('button', { name: /^resend$/i }));
    await waitFor(() => expect(resendInvitation).toHaveBeenCalledWith('inv-team'));
    await waitFor(() => expect(pageToast.warning).toHaveBeenCalledWith(expect.stringMatching(/no email was sent/)));
  });
});
