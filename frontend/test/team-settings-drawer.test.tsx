// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The team settings drawer edits ONE team from its parent: every section is the
 * shared settings component handed the TEAM's org id (never the active org's),
 * and each keeps its own permission gate.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { TeamSettingsDrawer } from '../src/components/teams/TeamSettingsDrawer';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

// Each settings component reports the org id it was handed.
jest.mock('@/components/settings/MfaPolicySettings', () => ({
  __esModule: true,
  MfaPolicySettings: ({ orgId }: { orgId: string }) => <div data-testid="mfa">{orgId}</div>,
}));
jest.mock('@/components/settings/ImpersonationPolicySettings', () => ({
  __esModule: true,
  ImpersonationPolicySettings: ({ orgId }: { orgId: string }) => <div data-testid="impersonation">{orgId}</div>,
}));
jest.mock('@/components/settings/OrgSsoSettings', () => ({
  __esModule: true,
  OrgSsoSettings: ({ orgId }: { orgId: string }) => <div data-testid="oidc">{orgId}</div>,
}));
jest.mock('@/components/settings/OrgSamlSettings', () => ({
  __esModule: true,
  OrgSamlSettings: ({ orgId }: { orgId: string }) => <div data-testid="saml">{orgId}</div>,
}));
jest.mock('@/components/settings/SsoDisconnect', () => ({ __esModule: true, SsoDisconnect: () => null }));

let ssoEntitled = true;
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: ssoEntitled, isLoaded: true, reason: 'SSO is not on your plan' }),
}));
jest.mock('@/components/ui/FeatureLock', () => ({
  __esModule: true,
  FeatureLock: ({ flag }: { flag: string }) => <div data-testid={`feature-lock-${flag}`} />,
}));

const invalidateOrganizations = jest.fn();
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { organizations: () => invalidateOrganizations() } }));

const getOwnOrgIdpConfig = jest.fn();
const updateOrganizationIdentity = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnOrgIdpConfig: (...a: unknown[]) => getOwnOrgIdpConfig(...a),
    updateOrganizationIdentity: (...a: unknown[]) => updateOrganizationIdentity(...a),
  },
}));

const team = { orgId: 'team-7', orgName: 'Platform' };

beforeEach(() => {
  jest.clearAllMocks();
  ssoEntitled = true;
  getOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: null } });
  updateOrganizationIdentity.mockResolvedValue({ success: true, data: { organization: { id: 'team-7', name: 'Platform Eng', slug: 'p', description: '' } } });
});

describe('TeamSettingsDrawer', () => {
  it('hands the TEAM\'s org id to every settings section', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: () => true });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn()} onRenamed={jest.fn()} />);

    expect(screen.getByTestId('mfa')).toHaveTextContent('team-7');
    expect(screen.getByTestId('impersonation')).toHaveTextContent('team-7');
    expect(await screen.findByTestId('oidc')).toHaveTextContent('team-7');
    expect(screen.getByTestId('saml')).toHaveTextContent('team-7');
    expect(getOwnOrgIdpConfig).toHaveBeenCalledWith('team-7', expect.anything());
  });

  it('keeps each section behind its own permission', () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:impersonation' });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn()} onRenamed={jest.fn()} />);

    expect(screen.getByTestId('impersonation')).toBeInTheDocument();
    expect(screen.queryByTestId('mfa')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('oidc')).not.toBeInTheDocument();
    expect(getOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('shows the sso lock instead of the editors when the account isn\'t entitled', () => {
    ssoEntitled = false;
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:idp' });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn()} onRenamed={jest.fn()} />);
    expect(screen.getByTestId('feature-lock-sso')).toBeInTheDocument();
    expect(screen.queryByTestId('oidc')).not.toBeInTheDocument();
  });

  it('renames the team through its own identity route, then tells the parent', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:settings' });
    const onRenamed = jest.fn();
    render(<TeamSettingsDrawer team={team} onClose={jest.fn()} onRenamed={onRenamed} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Platform Eng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename team' }));

    await waitFor(() => expect(updateOrganizationIdentity).toHaveBeenCalledWith('team-7', { name: 'Platform Eng' }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    // The switcher and every org list read the name through the shared cache,
    // so they keep the old one until it is dropped.
    expect(invalidateOrganizations).toHaveBeenCalled();
  });
});
