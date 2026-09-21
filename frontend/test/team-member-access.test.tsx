// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Viewing a TEAM member's account from the parent organization.
 *
 * The property that matters most: the request NAMES the team. Without it the
 * server would scope the session to the member's last active org — which may be
 * the parent itself, the parent admin's own org — and refuse it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamMemberAccess } from '../src/components/members/TeamMemberAccess';

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, onConfirmed }: { action: string; onConfirmed: (t: string) => void }) => (
    <div role="dialog">
      <p>{action}</p>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
    </div>
  ),
}));

const getOrganizationMembers = jest.fn<AnyFn>();
const impersonateUser = jest.fn<AnyFn>();
const startImpersonation = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    impersonateUser: (...a: unknown[]) => impersonateUser(...a),
    startImpersonation: (...a: unknown[]) => startImpersonation(...a),
  },
}));

const TEAMS = [{ orgId: 'team-1', orgName: 'Platform' }, { orgId: 'team-2', orgName: 'Data' }];
const member = (id: string, email: string) => ({
  id, username: id, email, role: 'member', isOwner: false, isActive: true, isEmailVerified: true, createdAt: '',
});

beforeEach(() => {
  jest.clearAllMocks();
  getOrganizationMembers.mockImplementation(async (orgId: string) => ({
    success: true,
    data: { members: orgId === 'team-1' ? [member('alice', 'alice@acme.com'), member('me', 'me@acme.com')] : [member('dan', 'dan@acme.com')] },
  }));
});

describe('TeamMemberAccess', () => {
  it('lists the SELECTED team\'s active members, not the parent\'s', async () => {
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly={false} />);

    expect(await screen.findByText('alice@acme.com')).toBeInTheDocument();
    expect(getOrganizationMembers).toHaveBeenCalledWith('team-1', expect.objectContaining({ status: 'active' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('switches roster when another team is chosen', async () => {
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly={false} />);
    await screen.findByText('alice@acme.com');

    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'team-2' } });

    expect(await screen.findByText('dan@acme.com')).toBeInTheDocument();
  });

  it('names the TEAM in the request, so the session is scoped to it', async () => {
    impersonateUser.mockResolvedValue({ success: true, data: { requestId: 'r1', status: 'consumed', accessToken: 'imp.jwt' } });
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly={false} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'View as user' }))[0]!);
    // The team's admins are told — the prompt says so before the operator commits.
    expect(screen.getByRole('dialog')).toHaveTextContent(/team's admins will be notified/i);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));

    await waitFor(() => expect(impersonateUser).toHaveBeenCalledWith('alice', 'step-up-token', { orgId: 'team-1' }));
    expect(startImpersonation).toHaveBeenCalledWith('imp.jwt', 'r1');
  });

  it('offers no button to view your own account', async () => {
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly={false} />);
    await screen.findByText('me@acme.com');

    // alice has one; "me" does not.
    expect(screen.getAllByRole('button', { name: 'View as user' })).toHaveLength(1);
  });

  it('shows the server\'s refusal instead of pretending it worked', async () => {
    impersonateUser.mockResolvedValue({ success: false, statusCode: 403, message: 'Forbidden: sysadmin or parent-organization admin only' });
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly={false} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'View as user' }))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));

    expect(await screen.findByText(/parent-organization admin only/i)).toBeInTheDocument();
    expect(startImpersonation).not.toHaveBeenCalled();
  });

  it('disables viewing during read-only impersonation', async () => {
    render(<TeamMemberAccess teams={TEAMS} currentUserId="me" readOnly />);
    expect((await screen.findAllByRole('button', { name: 'View as user' }))[0]).toBeDisabled();
  });

  it('renders nothing when the org has no teams', () => {
    const { container } = render(<TeamMemberAccess teams={[]} currentUserId="me" readOnly={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
