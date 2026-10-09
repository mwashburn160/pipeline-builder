// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The invitations composer's DELIVERY reporting.
 *
 * The API used to report "sent" for an invitation no mail transport ever
 * carried, because `emailService.send` returns true when email is disabled.
 * The send now reports `delivery` per address and hands back a ONE-TIME
 * `acceptUrl` when the mail did not go out — and that URL is the only way the
 * invitee is ever reached, because listings strip the token (it is a bearer
 * credential) and no endpoint will hand it over again.
 *
 * So the panel below is not cosmetic: if it stops rendering, or the dialog
 * closes over it, the invitation is unrecoverable and nothing says so. That is
 * what these tests hold in place.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import InvitationsPage from '../pages/dashboard/invitations';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

const mockRouter = { query: {}, pathname: '/dashboard/invitations', asPath: '/dashboard/invitations', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: { organizationId: 'org-1' } })));

const sendInvitations = jest.fn<AnyFn>();
const listInvitations = jest.fn<AnyFn>(async () => ({ success: true, data: { invitations: [], pagination: { total: 0, offset: 0, limit: 25 } } }));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    sendInvitations: (...a: unknown[]) => sendInvitations(...a),
    listInvitations: (...a: unknown[]) => listInvitations(...a),
    revokeInvitation: jest.fn<AnyFn>(),
    resendInvitation: jest.fn<AnyFn>(),
  },
}));

const ACCEPT_URL = 'https://pb.example.com/invite/accept?token=tok-abc123';

async function openComposerAndSend(address = 'new@x.io') {
  render(<InvitationsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /send invitation/i }));
  // Scoped to the dialog: the page's own "Search by email" box also matches a
  // loose /email/i, and the composer field is a textarea (it takes a pasted
  // list, which is the whole point of the single-request send).
  const dialog = await screen.findByRole('dialog');
  const box = within(dialog).getByRole('textbox', { name: /email/i });
  fireEvent.change(box, { target: { value: address } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));
}

describe('invitations composer — delivery reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGuard({ isAdmin: true, can: () => true });
  });

  it('shows the one-time accept link when no email went out', async () => {
    sendInvitations.mockResolvedValue({
      success: true,
      data: { sent: [{ email: 'new@x.io', delivery: 'not-configured', acceptUrl: ACCEPT_URL }], failed: [] },
    });

    await openComposerAndSend();

    // The link itself must be present and selectable — telling someone an
    // invitation exists without giving them the only way to deliver it is the
    // bug this replaced.
    const field = await screen.findByLabelText(/invitation link for new@x.io/i) as HTMLInputElement;
    expect(field.value).toBe(ACCEPT_URL);
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('does NOT claim the invitation was sent when it was not', async () => {
    sendInvitations.mockResolvedValue({
      success: true,
      data: { sent: [{ email: 'new@x.io', delivery: 'not-configured', acceptUrl: ACCEPT_URL }], failed: [] },
    });

    await openComposerAndSend();

    // Scoped: the invitations TABLE has a "Created" column header.
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/created/i)).toBeInTheDocument());
    // "Sent" is reserved for mail that actually left.
    expect(within(dialog).queryByText(/^Sent\b/)).not.toBeInTheDocument();
  });

  it('keeps the dialog OPEN while an undelivered link is on screen', async () => {
    jest.useFakeTimers();
    try {
      sendInvitations.mockResolvedValue({
        success: true,
        data: { sent: [{ email: 'new@x.io', delivery: 'not-configured', acceptUrl: ACCEPT_URL }], failed: [] },
      });

      await openComposerAndSend();
      await screen.findByLabelText(/invitation link for new@x.io/i);

      // The clean-send path auto-closes after ~1.2s. Here that would discard a
      // credential that cannot be fetched again.
      jest.advanceTimersByTime(5000);
      expect(screen.getByLabelText(/invitation link for new@x.io/i)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a per-address failure without losing the ones that landed', async () => {
    sendInvitations.mockResolvedValue({
      success: true,
      data: {
        sent: [{ email: 'a@x.io', delivery: 'sent' }],
        failed: [{ email: 'b@x.io', reason: 'Already a member of this organization' }],
      },
    });

    await openComposerAndSend('a@x.io, b@x.io');

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/already a member/i)).toBeInTheDocument());
    // The successful address is still reported as created — a partial failure
    // is not a failed request.
    expect(within(dialog).getByText(/created/i)).toBeInTheDocument();
  });

  it('sends ONE request for many addresses, not one per address', async () => {
    sendInvitations.mockResolvedValue({
      success: true,
      data: { sent: [{ email: 'a@x.io', delivery: 'sent' }, { email: 'b@x.io', delivery: 'sent' }], failed: [] },
    });

    await openComposerAndSend('a@x.io\nb@x.io');

    await waitFor(() => expect(sendInvitations).toHaveBeenCalledTimes(1));
    expect(sendInvitations).toHaveBeenCalledWith(expect.objectContaining({ emails: ['a@x.io', 'b@x.io'] }));
  });
});
