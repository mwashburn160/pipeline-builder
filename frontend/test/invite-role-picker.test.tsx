// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Choosing the Roles an invitation grants, and what the form says about it.
 *
 * The invitation used to carry only the coarse `admin | member` word, so
 * onboarding someone into a job meant inviting them as ADMIN and demoting, or
 * inviting as member and remembering to assign the Role later. The picker is
 * what removes that; `InviteFollowUpNotice` carried the old limitation as its
 * headline claim and had to stop saying it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteRolePicker } from '../src/components/invitations/InviteRolePicker';

const getOrganizationRoles = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({ api: { getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a) } }));

const role = (over: Record<string, unknown>) => ({
  id: 'r1', name: 'Developer', grantsRole: 'member', permissions: [], system: false, members: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getOrganizationRoles.mockResolvedValue({ data: { roles: [] } });
});

describe('InviteRolePicker', () => {
  it('lists the org\'s Roles with their descriptions', async () => {
    getOrganizationRoles.mockResolvedValue({ data: { roles: [
      role({ id: 'r1', name: 'Developer', description: 'Builds and runs pipelines' }),
      role({ id: 'r2', name: 'Billing Manager' }),
    ] } });

    render(<InviteRolePicker orgId="o1" value={[]} onChange={() => {}} />);

    expect(await screen.findByLabelText('Grant the Developer role on acceptance')).toBeInTheDocument();
    expect(screen.getByText('Builds and runs pipelines')).toBeInTheDocument();
    expect(screen.getByLabelText('Grant the Billing Manager role on acceptance')).toBeInTheDocument();
  });

  // Granting the platform flag goes through a grant that demands a second
  // factor; an invitation is a bearer token delivered by email. The server
  // refuses it, so offering it would be a control that cannot work.
  it('never offers the Super Admin Role', async () => {
    getOrganizationRoles.mockResolvedValue({ data: { roles: [
      role({ id: 'r1', name: 'Developer' }),
      role({ id: 'r9', name: 'Super Admin', grantsRole: 'superadmin' }),
    ] } });

    render(<InviteRolePicker orgId="o1" value={[]} onChange={() => {}} />);

    await screen.findByLabelText('Grant the Developer role on acceptance');
    expect(screen.queryByLabelText('Grant the Super Admin role on acceptance')).not.toBeInTheDocument();
  });

  it('toggles a Role on and off through onChange', async () => {
    getOrganizationRoles.mockResolvedValue({ data: { roles: [role({ id: 'r1', name: 'Developer' })] } });
    const onChange = jest.fn<AnyFn>();

    const { rerender } = render(<InviteRolePicker orgId="o1" value={[]} onChange={onChange} />);
    fireEvent.click(await screen.findByLabelText('Grant the Developer role on acceptance'));
    expect(onChange).toHaveBeenCalledWith(['r1']);

    rerender(<InviteRolePicker orgId="o1" value={['r1']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Grant the Developer role on acceptance'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  // `roles:manage` is a DIFFERENT permission from `invitations:manage`, so a
  // holder of only the latter 403s on the Roles list. They must still be able
  // to send the invitation.
  it('renders nothing when the Roles list is refused, rather than an error', async () => {
    getOrganizationRoles.mockRejectedValue(new Error('forbidden'));
    render(<InviteRolePicker orgId="o1" value={[]} onChange={() => {}} />);
    await waitFor(() => expect(getOrganizationRoles).toHaveBeenCalled());
    expect(screen.queryByTestId('invite-role-picker')).not.toBeInTheDocument();
  });

  it('renders nothing with no org, and reads nothing', () => {
    render(<InviteRolePicker orgId={undefined} value={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('invite-role-picker')).not.toBeInTheDocument();
    expect(getOrganizationRoles).not.toHaveBeenCalled();
  });
});
