// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO → domain-verification chain, end to end in the UI.
 *
 * SSO setup sends an admin off to verify a domain. That link used to name the
 * Organization TAB and nothing more, and what waited there was a card titled
 * "Domain-based join" — a name about joining — sixth of six, with no anchor to
 * scroll to. So the fragment is the contract now: `DOMAIN_SETTINGS_HREF` names
 * a card that exists, and the fragment alone opens the tab that renders it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { DOMAIN_SETTINGS_ANCHOR, DOMAIN_SETTINGS_HREF } from '../src/components/sso/VerifiedDomainPicker';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

// The other org-tab cards have their own suites; only the domains card matters
// here, and it stays REAL so the anchor is the one it actually renders.
jest.mock('@/components/settings/ImpersonationPolicySettings', () => ({ ImpersonationPolicySettings: () => null }));
jest.mock('@/components/settings/MfaPolicySettings', () => ({ MfaPolicySettings: () => null }));
jest.mock('@/components/settings/PasswordPolicySettings', () => ({ PasswordPolicySettings: () => null }));
jest.mock('@/components/settings/AuthenticatorPolicySettings', () => ({ AuthenticatorPolicySettings: () => null }));
jest.mock('@/components/settings/AIProviderConfig', () => ({ AIProviderConfig: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({ StepUpModal: () => null }));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    getMyOrganization: async () => ({ success: true, data: { organization: { id: 'org-1', name: 'Acme', slug: 'acme' } } }),
    listOrgDomains: async () => ({ success: true, data: { domains: [], entitled: true } }),
    listOrgJoinRequests: async () => ({ success: true, data: { requests: [] } }),
  },
}));

let query: Record<string, string> = {};
const replace = jest.fn();
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query, pathname: '/dashboard/settings', replace, push: jest.fn() }),
}));

import SettingsPage from '../pages/dashboard/settings';

// jsdom implements neither; `useUrlTab` calls both on the fragment's target.
const scrollIntoView = jest.fn();
beforeAll(() => { (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView; });

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  window.location.hash = '';
  mockAuthGuard({
    // `permissions` agrees with `can` below: the org cards' VISIBILITY reads the
    // raw permission (so read-only impersonation still shows them), while `can`
    // gates their writes.
    user: { id: 'u1', organizationId: 'org-1', username: 'admin', email: 'admin@acme.com', isEmailVerified: true, permissions: ['org:settings'] },
    can: (p: string) => p === 'org:settings',
  });
});

afterEach(() => { window.location.hash = ''; });

describe('the SSO wizard\'s "verify a domain" link', () => {
  it('lands on a card that exists, and scrolls to it', async () => {
    expect(DOMAIN_SETTINGS_HREF).toBe(`/dashboard/settings?tab=organization#${DOMAIN_SETTINGS_ANCHOR}`);
    query = { tab: 'organization' };
    window.location.hash = `#${DOMAIN_SETTINGS_ANCHOR}`;
    const { container } = render(<SettingsPage />);

    expect(await screen.findByText('Email domains')).toBeInTheDocument();
    expect(container.querySelector(`#${DOMAIN_SETTINGS_ANCHOR}`)).not.toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('opens the Organization tab from the fragment alone', async () => {
    window.location.hash = `#${DOMAIN_SETTINGS_ANCHOR}`;
    render(<SettingsPage />);
    // Without the fragment the page opens on Profile, which never renders it.
    expect(await screen.findByText('Email domains')).toBeInTheDocument();
  });

  it('shows the org cards (disabled) under READ-ONLY impersonation instead of hiding them', async () => {
    // `can()` is false for every mutation permission under read-only
    // impersonation. Gating the cards on it made the identity, domain and
    // security-policy cards VANISH for a sysadmin investigating the org, and
    // their `readOnly` props could never be true.
    mockAuthGuard({
      user: { id: 'u1', organizationId: 'org-1', username: 'admin', email: 'admin@acme.com', isEmailVerified: true, permissions: ['org:settings'] },
      can: () => false,
      isReadOnly: true,
    });
    query = { tab: 'organization' };
    render(<SettingsPage />);

    expect(await screen.findByText('Email domains')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /save organization/i })).toBeDisabled();
  });

  it('still opens on Profile when nothing names a tab or a section', () => {
    render(<SettingsPage />);
    expect(screen.queryByText('Email domains')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
  });
});
