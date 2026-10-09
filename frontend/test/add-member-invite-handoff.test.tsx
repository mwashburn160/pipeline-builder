// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Add member" → invitation handoff.
 *
 * The modal adds an EXISTING account. An unregistered address used to come
 * back as a bare 404 that named no way forward, while the admin's intent was
 * perfectly satisfiable by an invitation. The offer below is the whole fix, so
 * it is worth holding in place — and it is permission-gated, because
 * `invitations:manage` is a separate grant from `members:manage` and an offer
 * the viewer cannot act on is worse than none.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api/errors';
import { AddMemberModal } from '@/components/members/AddMemberModal';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const addMemberToOrganization = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    addMemberToOrganization: (...a: unknown[]) => addMemberToOrganization(...a),
    getOrganizationTeams: jest.fn<AnyFn>(async () => ({ data: { teams: [] } })),
    bulkAddMemberToTeams: jest.fn<AnyFn>(),
  },
}));

function renderModal(canInvite: boolean) {
  render(
    <AddMemberModal orgId="org-1" offerTeams={false} canInvite={canInvite} onClose={jest.fn()} onAdded={jest.fn()} />,
  );
}

async function submit(address: string) {
  fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: /add member/i }));
}

describe('AddMemberModal — unregistered address', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('offers to INVITE the exact address when it has no account', async () => {
    addMemberToOrganization.mockRejectedValue(
      new ApiError('No account exists for that address yet', 404, 'USER_NOT_REGISTERED'),
    );

    renderModal(true);
    await submit('new@x.io');

    const link = await screen.findByRole('link', { name: /send new@x.io an invitation/i });
    // Carries the address through, so the composer opens prefilled — landing
    // on the list and making them retype it leaves the handoff half-done.
    expect(link).toHaveAttribute('href', expect.stringContaining('email=new%40x.io'));
  });

  it('does NOT offer the link to someone without invitation access', async () => {
    addMemberToOrganization.mockRejectedValue(
      new ApiError('No account exists for that address yet', 404, 'USER_NOT_REGISTERED'),
    );

    renderModal(false);
    await submit('new@x.io');

    // They are told who can do it instead of being sent to a page that 403s.
    await waitFor(() => expect(screen.getByText(/ask an admin with invitation access/i)).toBeInTheDocument());
    // No link at all for this viewer — not even the standing hint, which also
    // degrades to plain text without `invitations:manage`.
    expect(screen.queryByRole('link', { name: /invitation/i })).not.toBeInTheDocument();
  });

  it('does not offer an invitation for an UNRELATED failure', async () => {
    addMemberToOrganization.mockRejectedValue(
      new ApiError('User is already a member of this organization', 400, 'CONFLICT'),
    );

    renderModal(true);
    await submit('dup@x.io');

    await waitFor(() => expect(screen.getByText(/already a member/i)).toBeInTheDocument());
    // The ADDRESS-SPECIFIC offer must not appear: inviting someone already in
    // the org is not the remedy. The standing "No account yet?" hint below the
    // input is always there by design and names nobody, so it is not asserted
    // against here — only the targeted offer is.
    expect(screen.queryByRole('link', { name: /send dup@x\.io an invitation/i })).not.toBeInTheDocument();
  });
});
