// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** EditPluginModal's per-plugin library upgrade level ("Follow organization" by default). */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/hooks/useOrgHierarchy', () => ({
  __esModule: true,
  useOrgHierarchy: () => ({ activeOrg: { id: 'org-1' }, hasChildOrgs: false, isChildOrg: false }),
}));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: { id: 'u1', role: 'admin' }, organizations: [{ id: 'org-1', name: 'Acme' }] })));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const api = {
  getPluginById: jest.fn<AnyFn>(),
  getPluginRemediationSettings: jest.fn<AnyFn>(),
  setPluginRemediationLevel: jest.fn<AnyFn>(),
  updatePlugin: jest.fn<AnyFn>(),
  getOrganizationTeams: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import EditPluginModal from '../src/components/plugin/EditPluginModal';

beforeEach(() => {
  jest.clearAllMocks();
  api.getOrganizationTeams.mockReturnValue(ok({ teams: [] }));
});

describe('EditPluginModal library upgrade level', () => {
  const PLUGIN = {
    id: 'p-1', orgId: 'org-1', name: 'terraform-plan', version: '1.4.2', pluginType: 'CodeBuildStep', computeType: 'SMALL',
    visibility: 'private', isActive: true, isDefault: true, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const SETTINGS = (byPlugin: Record<string, string> = {}) => ok({
    settings: { mode: 'propose', libraryUpgradeLevel: 'minor', libraryUpgradeLevelByType: {}, libraryUpgradeLevelByPlugin: byPlugin, rollout: 'propose', allowPipelineApply: true },
    isTeam: false, root: null, enabled: true, severities: ['critical', 'high'], canEdit: true,
  });

  it('defaults to Follow organization and saves only the changed level', async () => {
    api.getPluginById.mockReturnValue(ok({ plugin: { ...PLUGIN, updatedBy: 'u1', keywords: [], metadata: {}, env: {}, buildArgs: {}, installCommands: [], commands: [], secrets: [] } }));
    api.getPluginRemediationSettings.mockReturnValue(SETTINGS());
    api.setPluginRemediationLevel.mockReturnValue(SETTINGS({ 'terraform-plan': 'patch' }));
    const onSaved = jest.fn<AnyFn>();
    render(<EditPluginModal plugin={PLUGIN as never} canPublish={false} onClose={() => {}} onSaved={onSaved} />);
    const select = await screen.findByLabelText('Library upgrade level') as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'patch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.setPluginRemediationLevel).toHaveBeenCalledWith('terraform-plan', 'patch'));
    expect(api.updatePlugin).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('clears the level back to Follow organization with null', async () => {
    api.getPluginById.mockReturnValue(ok({ plugin: { ...PLUGIN, updatedBy: 'u1', keywords: [], metadata: {}, env: {}, buildArgs: {}, installCommands: [], commands: [], secrets: [] } }));
    api.getPluginRemediationSettings.mockReturnValue(SETTINGS({ 'terraform-plan': 'major' }));
    api.setPluginRemediationLevel.mockReturnValue(SETTINGS());
    render(<EditPluginModal plugin={PLUGIN as never} canPublish={false} onClose={() => {}} onSaved={() => {}} />);
    const select = await screen.findByLabelText('Library upgrade level') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('major'));
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.setPluginRemediationLevel).toHaveBeenCalledWith('terraform-plan', null));
  });
});
