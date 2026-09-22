// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * IdP group → role mapping editor (3a).
 *
 * Covers the four things the editor is responsible for: listing rules with the
 * roles they grant, adding/editing/deleting one, never offering a role the
 * server would refuse (platform-admin), and stating the Google limitation
 * instead of showing a form that could never work.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SsoGroupMappings } from '../src/components/settings/SsoGroupMappings';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

const listIdpGroupMappings = jest.fn<AnyFn>();
const createIdpGroupMapping = jest.fn<AnyFn>();
const updateIdpGroupMapping = jest.fn<AnyFn>();
const deleteIdpGroupMapping = jest.fn<AnyFn>();
const getOrganizationRoles = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listIdpGroupMappings: (...a: unknown[]) => listIdpGroupMappings(...a),
    createIdpGroupMapping: (...a: unknown[]) => createIdpGroupMapping(...a),
    updateIdpGroupMapping: (...a: unknown[]) => updateIdpGroupMapping(...a),
    deleteIdpGroupMapping: (...a: unknown[]) => deleteIdpGroupMapping(...a),
    getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a),
  },
}));

const role = (id: string, name: string, grantsRole = 'member') =>
  ({ id, name, grantsRole, permissions: [], system: false, members: [] });

const mapping = {
  id: 'm1',
  group: 'platform-engineers',
  roleIds: ['r1'],
  roles: [{ id: 'r1', name: 'Engineering', grantsRole: 'member' as const }],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  listIdpGroupMappings.mockResolvedValue({ success: true, data: { mappings: [] } });
  getOrganizationRoles.mockResolvedValue({ success: true, data: { roles: [role('r1', 'Engineering')] } });
});

describe('SsoGroupMappings', () => {
  it('shows the empty state once loaded', async () => {
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);
    expect(await screen.findByText(/No group mappings yet/i)).toBeInTheDocument();
  });

  it('lists a rule with the roles it grants', async () => {
    listIdpGroupMappings.mockResolvedValue({ success: true, data: { mappings: [mapping] } });
    render(<SsoGroupMappings orgId="org-1" provider="cognito" />);
    expect(await screen.findByText('platform-engineers')).toBeInTheDocument();
    expect(screen.getByText(/Grants: Engineering/)).toBeInTheDocument();
  });

  it('creates a mapping from the group + selected roles', async () => {
    createIdpGroupMapping.mockResolvedValue({ success: true, data: { mapping } });
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);

    fireEvent.change(await screen.findByPlaceholderText('platform-engineers'), { target: { value: 'sre' } });
    fireEvent.click(screen.getByLabelText('Engineering'));
    fireEvent.click(screen.getByRole('button', { name: /add mapping/i }));

    await waitFor(() => expect(createIdpGroupMapping).toHaveBeenCalledWith('org-1', { group: 'sre', roleIds: ['r1'] }));
  });

  it('will not submit without both a group and at least one role', async () => {
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);
    const submit = await screen.findByRole('button', { name: /add mapping/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('platform-engineers'), { target: { value: 'sre' } });
    expect(submit).toBeDisabled(); // group alone is not enough
  });

  it('edits an existing mapping through the same form', async () => {
    listIdpGroupMappings.mockResolvedValue({ success: true, data: { mappings: [mapping] } });
    updateIdpGroupMapping.mockResolvedValue({ success: true, data: { mapping } });
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);

    fireEvent.click(await screen.findByLabelText('Edit platform-engineers'));
    fireEvent.change(screen.getByPlaceholderText('platform-engineers'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save mapping/i }));

    await waitFor(() => expect(updateIdpGroupMapping).toHaveBeenCalledWith('org-1', 'm1', { group: 'renamed', roleIds: ['r1'] }));
  });

  it('deletes a mapping only after confirmation', async () => {
    listIdpGroupMappings.mockResolvedValue({ success: true, data: { mappings: [mapping] } });
    deleteIdpGroupMapping.mockResolvedValue({ success: true, data: {} });
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);

    fireEvent.click(await screen.findByLabelText('Delete platform-engineers'));
    expect(deleteIdpGroupMapping).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteIdpGroupMapping).toHaveBeenCalledWith('org-1', 'm1'));
  });

  it('never offers a platform-admin role as a mapping target', async () => {
    getOrganizationRoles.mockResolvedValue({
      success: true,
      data: { roles: [role('r1', 'Engineering'), role('su', 'Super Admin', 'superadmin')] },
    });
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" />);

    expect(await screen.findByLabelText('Engineering')).toBeInTheDocument();
    expect(screen.queryByLabelText('Super Admin')).not.toBeInTheDocument();
  });

  it('explains the Google limitation instead of showing the editor', async () => {
    render(<SsoGroupMappings orgId="org-1" provider="google" />);
    expect(await screen.findByText(/carry no group claim/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('platform-engineers')).not.toBeInTheDocument();
    expect(listIdpGroupMappings).not.toHaveBeenCalled();
  });

  it('asks for an identity provider first when none is configured', async () => {
    render(<SsoGroupMappings orgId="org-1" provider={null} />);
    expect(await screen.findByText(/Configure an identity provider/i)).toBeInTheDocument();
  });

  it('disables every control in a read-only (impersonated) session', async () => {
    listIdpGroupMappings.mockResolvedValue({ success: true, data: { mappings: [mapping] } });
    render(<SsoGroupMappings orgId="org-1" provider="generic-oidc" readOnly />);

    expect(await screen.findByLabelText('Edit platform-engineers')).toBeDisabled();
    expect(screen.getByLabelText('Delete platform-engineers')).toBeDisabled();
    expect(screen.getByPlaceholderText('platform-engineers')).toBeDisabled();
  });
});
