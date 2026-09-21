// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin editor's half of team ownership.
 *
 * Plugins carry the same `ownerId`/`ownerType` columns as pipelines, behind the
 * same admin-only gate on `PUT /plugins/:id` and the same `plugins:publish`
 * clamp on the `public` rung — so the editor sends the owner on exactly the same
 * terms, and a lone owner change has to count as a dirty form or a stray
 * backdrop click would discard it silently.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditPluginModal from '../src/components/plugin/EditPluginModal';
import type { PluginSummary } from '../src/lib/api/domains/plugins';

let hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: true, isChildOrg: false };
jest.mock('@/hooks/useOrgHierarchy', () => ({
  __esModule: true,
  useOrgHierarchy: () => hierarchy,
}));

let currentUser: Record<string, unknown> | null = { id: 'u1', role: 'admin' };
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: currentUser, organizations: [{ id: 'root-1', name: 'Acme' }] }),
}));

jest.mock('@/hooks/usePlugins', () => ({
  __esModule: true,
  clearPluginCache: jest.fn<AnyFn>(),
}));

const getPluginById = jest.fn<AnyFn>();
const updatePlugin = jest.fn<AnyFn>();
const getOrganizationTeams = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPluginById: (...a: unknown[]) => getPluginById(...a),
    updatePlugin: (...a: unknown[]) => updatePlugin(...a),
    getOrganizationTeams: (...a: unknown[]) => getOrganizationTeams(...a),
  },
}));

const PLUGIN = {
  id: 'p1', name: 'scan', description: 'security scan', keywords: ['scan'], version: '1.0.0',
  pluginType: 'build', computeType: 'small', visibility: 'org', isActive: true, isDefault: false,
  createdBy: 'creator-9', createdAt: '2026-09-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-09-01T00:00:00Z',
  orgId: 'root-1', failureBehavior: 'fail',
} as unknown as PluginSummary;

const full = (over: Record<string, unknown> = {}) => ({ ...PLUGIN, metadata: {}, env: {}, buildArgs: {}, installCommands: [], commands: [], secrets: [], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: true, isChildOrg: false };
  currentUser = { id: 'u1', role: 'admin' };
  getPluginById.mockResolvedValue({ success: true, data: { plugin: full() } });
  updatePlugin.mockResolvedValue({ success: true, data: { plugin: full() } });
  getOrganizationTeams.mockResolvedValue({ success: true, data: { teams: [{ orgId: 'team-1', orgName: 'Payments' }] } });
});

function renderModal(canPublish = true) {
  return render(
    <EditPluginModal plugin={PLUGIN} canPublish={canPublish} onClose={jest.fn<AnyFn>()} onSaved={jest.fn<AnyFn>()} />,
  );
}

describe('EditPluginModal — team ownership', () => {
  it('sends the owning team on save', async () => {
    renderModal();
    await screen.findByRole('option', { name: /Team: Payments/ });

    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'team:team-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    expect(updatePlugin.mock.calls[0][1]).toMatchObject({ ownerId: 'team-1', ownerType: 'team' });
  });

  it('offers the publish fix when the owning team could not see it', async () => {
    getPluginById.mockResolvedValue({ success: true, data: { plugin: full({ ownerId: 'team-1', ownerType: 'team', visibility: 'org' }) } });
    renderModal();

    const warning = await screen.findByTestId('team-visibility-warning');
    expect(warning).toHaveTextContent(/public plugins/);
    fireEvent.click(screen.getByRole('button', { name: /set visibility to public/i }));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    expect(updatePlugin.mock.calls[0][1]).toMatchObject({ visibility: 'public', ownerId: 'team-1', ownerType: 'team' });
  });

  it('omits the owner entirely for a non-admin, whose values the server drops', async () => {
    currentUser = { id: 'u2', role: 'member' };
    renderModal();
    await waitFor(() => expect(getPluginById).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    expect(updatePlugin.mock.calls[0][1]).not.toHaveProperty('ownerId');
    expect(updatePlugin.mock.calls[0][1]).not.toHaveProperty('ownerType');
  });

  it('hides the control on a flat org with no team owner', async () => {
    hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: false, isChildOrg: false };
    renderModal();
    await waitFor(() => expect(getPluginById).toHaveBeenCalled());
    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();
  });
});
