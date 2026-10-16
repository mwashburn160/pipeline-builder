// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The invitation composer at the account's seat cap.
 *
 * When every seat is taken (members + live pending invites) the form is
 * disabled and says how to free one, rather than letting each address come back
 * "No seat available". The remedy follows the ACCOUNT's tier: seat packs are
 * sold on Team and above only, so a Developer/Pro account is told to upgrade.
 * When seat usage cannot be read (the endpoint is org-admin only), the form
 * stays usable — the server still refuses per address.
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

const getOrganizationSeatUsage = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    sendInvitations: jest.fn<AnyFn>(),
    listInvitations: jest.fn<AnyFn>(async () => ({ success: true, data: { invitations: [], pagination: { total: 0, offset: 0, limit: 25 } } })),
    revokeInvitation: jest.fn<AnyFn>(),
    resendInvitation: jest.fn<AnyFn>(),
    getOrganizationSeatUsage: (...a: unknown[]) => getOrganizationSeatUsage(...a),
  },
}));

const seats = (used: number, limit: number, tier: string) =>
  getOrganizationSeatUsage.mockResolvedValue({ success: true, data: { used, limit, tier } });

async function openComposer() {
  render(<InvitationsPage />);
  await waitFor(() => expect(getOrganizationSeatUsage).toHaveBeenCalledWith('org-1', expect.anything()));
  // The header action — the empty-state also offers one, so take the first.
  fireEvent.click((await screen.findAllByRole('button', { name: /send invitation/i }))[0]);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ isAdmin: true, can: () => true, user: { id: 'u1', organizationId: 'org-1' } });
});

describe('invitation composer — at the seat cap', () => {
  it('a full Developer account: form disabled, and the remedy is an UPGRADE, not a seat pack', async () => {
    seats(1, 1, 'developer');
    const dialog = await openComposer();

    expect(await within(dialog).findByText(/all 1 account seat is in use/i)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: /upgrade to team/i }).getAttribute('href')).toBe('/dashboard/billing');
    expect(within(dialog).queryByText(/seat pack/i)).toBeNull();
    expect((within(dialog).getByRole('button', { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('textbox', { name: /email/i }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('a full Team account: the remedy is a seat pack', async () => {
    seats(3, 3, 'team');
    const dialog = await openComposer();

    expect(within(dialog).getByRole('link', { name: /add a seat pack/i })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an account with a free seat: no notice, form usable', async () => {
    seats(1, 3, 'team');
    const dialog = await openComposer();

    expect(within(dialog).queryByText(/in use/i)).toBeNull();
    expect((within(dialog).getByRole('textbox', { name: /email/i }) as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('seat usage unreadable (not an org admin): form stays usable — the server still refuses per address', async () => {
    getOrganizationSeatUsage.mockRejectedValue(new Error('Forbidden'));
    const dialog = await openComposer();

    expect(within(dialog).queryByText(/in use/i)).toBeNull();
    expect((within(dialog).getByRole('textbox', { name: /email/i }) as HTMLTextAreaElement).disabled).toBe(false);
  });
});
