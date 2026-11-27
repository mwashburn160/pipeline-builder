// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resend mints a NEW invitation token (only its hash is stored, so the old link
 * cannot be re-sent) and the old link stops working. When no email goes out,
 * the API hands back the new link once as `acceptUrl`; the page must show it,
 * or the invitation becomes unreachable and nothing says so.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import InvitationsPage from '../src/components/invitations/InvitationsTab';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

const mockRouter = { query: {}, pathname: '/dashboard/invitations', asPath: '/dashboard/invitations', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: { organizationId: 'org-1' } })));

const INVITE = {
  id: 'inv-1', email: 'dev@x.io', role: 'member', status: 'pending', invitedBy: 'u1', inviterName: 'Ada',
  invitationType: 'email', createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
};
const ACCEPT_URL = 'https://pb.example.com/invite/accept?token=tok-new456';

const resendInvitation = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    sendInvitations: jest.fn<AnyFn>(),
    listInvitations: jest.fn<AnyFn>(async () => ({ success: true, data: { invitations: [INVITE], pagination: { total: 1, offset: 0, limit: 25 } } })),
    revokeInvitation: jest.fn<AnyFn>(),
    resendInvitation: (...a: unknown[]) => resendInvitation(...a),
  },
}));

describe('invitations — resend hands back the new link when no email went out', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ isAdmin: true, can: () => true });
  });

  it('shows the one-time link returned by a resend that sent no email', async () => {
    resendInvitation.mockResolvedValue({ success: true, data: { expiresAt: '2026-12-08T00:00:00Z', delivery: 'not-configured', acceptUrl: ACCEPT_URL } });
    render(<InvitationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^resend$/i }));
    const link = await screen.findByRole('textbox', { name: /invitation link for dev@x\.io/i });
    expect(link).toHaveValue(ACCEPT_URL);
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('shows no link when the resend email went out', async () => {
    resendInvitation.mockResolvedValue({ success: true, data: { expiresAt: '2026-12-08T00:00:00Z', delivery: 'sent' } });
    render(<InvitationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^resend$/i }));
    await screen.findByRole('button', { name: /^resend$/i });
    expect(screen.queryByRole('textbox', { name: /invitation link for/i })).not.toBeInTheDocument();
  });
});
