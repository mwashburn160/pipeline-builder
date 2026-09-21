// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form used to offer a bare `admin | member` select and say nothing
 * about the two layers that follow it (Roles, teams) or about an org-wide MFA
 * requirement that can block the invitee at their first sign-in. This covers
 * the notice that now says all three — including its fail-soft behaviour, since
 * the MFA policy read is gated on `org:settings`, which an invitations-only
 * admin may not hold.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { InviteFollowUpNotice } from '../src/components/invitations/InviteFollowUpNotice';

const getMfaPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getMfaPolicy: (...a: unknown[]) => getMfaPolicy(...a) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  getMfaPolicy.mockResolvedValue({ success: true, data: { requireMfa: false } });
});

describe('InviteFollowUpNotice', () => {
  it('says what a member does and does not get', async () => {
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} />);
    expect(screen.getByText(/read and write on pipelines/i)).toBeInTheDocument();
    expect(screen.getByText(/no publish rights on any catalog/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('says what an admin gets instead', async () => {
    render(<InviteFollowUpNotice orgId="org-1" role="admin" hasTeams={false} />);
    expect(screen.getByText(/full administration of this organization/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('always names the two follow-ups the invitation cannot carry', async () => {
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams />);
    expect(screen.getByRole('link', { name: /roles/i })).toHaveAttribute('href', '/dashboard/roles');
    expect(screen.getByText(/needs an existing account/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('warns that the invitee must enrol when the org requires MFA', async () => {
    getMfaPolicy.mockResolvedValue({ success: true, data: { requireMfa: true, inheritedFromName: 'Acme Root' } });
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} />);
    const warning = await screen.findByTestId('invite-mfa-warning');
    expect(warning).toHaveTextContent(/requires two-factor/i);
    expect(warning).toHaveTextContent(/Acme Root/);
  });

  it('renders the rest of the notice when the MFA policy read is refused', async () => {
    getMfaPolicy.mockRejectedValue(new Error('403 Forbidden'));
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} />);
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
    expect(screen.getByTestId('invite-follow-up')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-mfa-warning')).not.toBeInTheDocument();
  });

  it('skips the policy read entirely without an org', () => {
    render(<InviteFollowUpNotice orgId={undefined} role="admin" hasTeams={false} />);
    expect(getMfaPolicy).not.toHaveBeenCalled();
  });
});
