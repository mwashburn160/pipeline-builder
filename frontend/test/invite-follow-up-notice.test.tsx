// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form used to offer a bare `admin | member` select and say nothing
 * about the two layers that follow it (Roles, teams) or about an org-wide MFA
 * requirement that can block the invitee at their first sign-in. This covers
 * the notice that now says all three — including its fail-soft behaviour, since
 * the MFA policy read is gated on `org_settings:write`, which an invitations-only
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
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} rolesChosen={0} />);
    expect(screen.getByText(/read and write on pipelines/i)).toBeInTheDocument();
    expect(screen.getByText(/no publish rights on any catalog/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('says what an admin gets instead', async () => {
    render(<InviteFollowUpNotice orgId="org-1" role="admin" hasTeams={false} rolesChosen={0} />);
    expect(screen.getByText(/full administration of this organization/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('always names the two follow-ups the invitation cannot carry', async () => {
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams rolesChosen={0} />);
    expect(screen.getByRole('link', { name: /roles/i })).toHaveAttribute('href', '/dashboard/roles');
    expect(screen.getByText(/needs an existing account/i)).toBeInTheDocument();
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
  });

  it('warns that the invitee must enrol when the org requires MFA', async () => {
    getMfaPolicy.mockResolvedValue({ success: true, data: { requireMfa: true, inheritedFromName: 'Acme Root' } });
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} rolesChosen={0} />);
    const warning = await screen.findByTestId('invite-mfa-warning');
    expect(warning).toHaveTextContent(/requires two-factor/i);
    expect(warning).toHaveTextContent(/Acme Root/);
  });

  it('renders the rest of the notice when the MFA policy read is refused', async () => {
    getMfaPolicy.mockRejectedValue(new Error('403 Forbidden'));
    render(<InviteFollowUpNotice orgId="org-1" role="member" hasTeams={false} rolesChosen={0} />);
    await waitFor(() => expect(getMfaPolicy).toHaveBeenCalled());
    expect(screen.getByTestId('invite-follow-up')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-mfa-warning')).not.toBeInTheDocument();
  });

  it('skips the policy read entirely without an org', () => {
    render(<InviteFollowUpNotice orgId={undefined} role="admin" hasTeams={false} rolesChosen={0} />);
    expect(getMfaPolicy).not.toHaveBeenCalled();
  });
});

/**
 * The notice's HEADLINE CLAIM changed: "this invitation can't carry a Role" was
 * true until invitations took `roleIds`. Keeping it would have told the sender
 * to go and do by hand something the form had just done for them.
 */
describe('InviteFollowUpNotice — Roles chosen on the invitation', () => {
  it('stops telling the sender to assign Roles by hand once Roles are selected', async () => {
    render(<InviteFollowUpNotice orgId="o1" role="member" hasTeams={false} rolesChosen={2} />);
    const notice = await screen.findByTestId('invite-follow-up');

    expect(notice).toHaveTextContent('they also get the 2 roles selected above');
    expect(notice).not.toHaveTextContent('Manage roles');
    expect(notice).not.toHaveTextContent('No roles selected');
  });

  it('singularises one role', async () => {
    render(<InviteFollowUpNotice orgId="o1" role="member" hasTeams={false} rolesChosen={1} />);
    expect(await screen.findByTestId('invite-follow-up')).toHaveTextContent('they also get the role selected above');
  });

  // With none chosen it is a PROMPT, not a limitation — the sender can still
  // pick one in the form above.
  it('names the condition when no Roles are selected, and points at the picker', async () => {
    render(<InviteFollowUpNotice orgId="o1" role="member" hasTeams={false} rolesChosen={0} />);
    const notice = await screen.findByTestId('invite-follow-up');

    expect(notice).toHaveTextContent('No roles selected');
    expect(notice).toHaveTextContent('pick them above to have them applied on acceptance');
  });

  // Team placement is still genuinely post-acceptance: bulk-add resolves a real
  // User, which a pending invitee does not have.
  it('keeps the team line either way, because that one has not changed', async () => {
    for (const rolesChosen of [0, 1]) {
      const { unmount } = render(<InviteFollowUpNotice orgId="o1" role="member" hasTeams rolesChosen={rolesChosen} />);
      expect(await screen.findByTestId('invite-follow-up')).toHaveTextContent('Manage teams');
      unmount();
    }
  });
});
