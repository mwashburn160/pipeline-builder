// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The team settings drawer edits ONE team from its parent: every section is the
 * shared settings component handed the TEAM's org id (never the active org's),
 * and each keeps its own permission gate.
 *
 * SSO is the same flow as Settings → Single Sign-On — the six-step wizard, then
 * the status summary — not the pair of protocol editors the drawer used to
 * stack, so an admin only learns one shape.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
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
jest.mock('@/components/settings/SsoDisconnect', () => ({ __esModule: true, SsoDisconnect: () => null }));
// The SSO section is the REAL shared flow (SsoConnectionFlow → wizard / status
// summary) — the point of these tests is that a team gets it, handed the team's
// org id, so it must not be stubbed out.
jest.mock('@/components/admin/StepUpModal', () => ({ __esModule: true, StepUpModal: () => <div data-testid="stepup-modal" /> }));

let ssoEntitled = true;
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: ssoEntitled, isLoaded: true, reason: 'SSO is not on your plan' }),
}));
jest.mock('@/components/ui/FeatureLock', () => ({
  __esModule: true,
  FeatureLock: ({ flag }: { flag: string }) => <div data-testid={`feature-lock-${flag}`} />,
}));

const invalidateOrganizations = jest.fn<AnyFn>();
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { organizations: () => invalidateOrganizations() } }));

const getOwnOrgIdpConfig = jest.fn<AnyFn>();
const getOwnOrgIdpSpInfo = jest.fn<AnyFn>();
const listOrgDomains = jest.fn<AnyFn>();
const updateOrganizationIdentity = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnOrgIdpConfig: (...a: unknown[]) => getOwnOrgIdpConfig(...a),
    getOwnOrgIdpSpInfo: (...a: unknown[]) => getOwnOrgIdpSpInfo(...a),
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
    updateOrganizationIdentity: (...a: unknown[]) => updateOrganizationIdentity(...a),
  },
}));

const team = { orgId: 'team-7', orgName: 'Platform' };

/** A saved connection for the team, so the drawer shows the status summary. */
const TEAM_CONFIG = {
  orgId: 'team-7',
  protocol: 'oidc' as const,
  provider: 'google' as const,
  hasClientSecret: true,
  allowedEmailDomains: [],
  samlCertificates: [],
  samlSignAuthnRequests: false,
  samlEncryptAssertions: false,
  enabled: true,
  ssoRequired: false,
  updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  ssoEntitled = true;
  getOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: null } });
  getOwnOrgIdpSpInfo.mockResolvedValue({ success: true, data: { sp: { entityId: 'e', acsUrl: 'https://pb/acs', metadataUrl: 'm', sloUrl: 's', oidcRedirectUri: 'https://pb/cb', signingCertificate: 'S', encryptionCertificate: 'E' } } });
  listOrgDomains.mockResolvedValue({ success: true, data: { entitled: true, domains: [] } });
  updateOrganizationIdentity.mockResolvedValue({ success: true, data: { organization: { id: 'team-7', name: 'Platform Eng', slug: 'p', description: '' } } });
});

describe('TeamSettingsDrawer', () => {
  it('hands the TEAM\'s org id to every settings section', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: () => true });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);

    expect(screen.getByTestId('mfa')).toHaveTextContent('team-7');
    expect(screen.getByTestId('impersonation')).toHaveTextContent('team-7');
    expect(await screen.findByText('Set up single sign-on')).toBeInTheDocument();
    expect(getOwnOrgIdpConfig).toHaveBeenCalledWith('team-7', expect.anything());
  });

  it('gives a team the SAME six-step wizard as the org SSO page, not the old stacked editors', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: () => true });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);

    // The wizard makes you CHOOSE a protocol — the drawer used to stack both
    // editors at once — and carries the steps the old shape had no room for.
    expect(await screen.findByText('Set up single sign-on')).toBeInTheDocument();
    for (const step of [/1\s*Protocol & provider/, /2\s*Service-provider values/, /4\s*Domains/, /5\s*Test connection/, /6\s*Enable/]) {
      expect(screen.getByRole('button', { name: step })).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/SAML 2\.0/)).toBeInTheDocument();
  });

  it('reads the SP values for the TEAM, never the active org', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: () => true });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);

    fireEvent.click(await screen.findByRole('button', { name: /2\s*Service-provider values/ }));
    await waitFor(() => expect(getOwnOrgIdpSpInfo).toHaveBeenCalledWith('team-7', expect.anything()));
  });

  it('shows the status summary — with test connection and "SSO required" — for a configured team', async () => {
    getOwnOrgIdpConfig.mockResolvedValue({ success: true, data: { config: TEAM_CONFIG } });
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: () => true });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);

    expect(await screen.findByTestId('sso-summary')).toBeInTheDocument();
    // Both were missing from the drawer's old shape.
    expect(screen.getByRole('button', { name: /^Test connection$/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Require single sign-on/i)).toBeInTheDocument();
  });

  it('keeps each section behind its own permission', () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:impersonation' });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);

    expect(screen.getByTestId('impersonation')).toBeInTheDocument();
    expect(screen.queryByTestId('mfa')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByText('Set up single sign-on')).not.toBeInTheDocument();
    expect(getOwnOrgIdpConfig).not.toHaveBeenCalled();
  });

  it('shows the sso lock instead of the editors when the account isn\'t entitled', () => {
    ssoEntitled = false;
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:idp' });
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={jest.fn<AnyFn>()} />);
    expect(screen.getByTestId('feature-lock-sso')).toBeInTheDocument();
    expect(screen.queryByText('Set up single sign-on')).not.toBeInTheDocument();
  });

  it('renames the team through its own identity route, then tells the parent', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'root-1' }, can: (p: string) => p === 'org:settings' });
    const onRenamed = jest.fn<AnyFn>();
    render(<TeamSettingsDrawer team={team} onClose={jest.fn<AnyFn>()} onRenamed={onRenamed} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Platform Eng' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename team' }));

    await waitFor(() => expect(updateOrganizationIdentity).toHaveBeenCalledWith('team-7', { name: 'Platform Eng' }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    // The switcher and every org list read the name through the shared cache,
    // so they keep the old one until it is dropped.
    expect(invalidateOrganizations).toHaveBeenCalled();
  });
});
