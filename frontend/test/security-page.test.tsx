// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Security page — one home for everything that can sign in as you.
 *
 * What is pinned here is the information architecture, because that is what was
 * broken: personal factors, sessions and machine credentials were spread across
 * four pages that pointed at each other, the enrolment deep links named a tab
 * and a section that never landed together, and the nav called the whole area
 * "Profile" — a word that denies passkeys, TOTP and recovery codes exist.
 *
 *   - the four sub-tabs each render their own surface, and the org's service
 *     accounts only exist for someone who may manage them;
 *   - `?tab=…#section` lands on the right tab, and a bare `#section` opens the
 *     tab that owns it;
 *   - the old addresses (/dashboard/settings/service-accounts,
 *     /dashboard/settings?tab=security) forward here, per old tab (the old
 *     /dashboard/tokens tabs are server redirects — see next-redirects.test.ts);
 *   - the nav names it honestly and no longer advertises the moved pages;
 *   - impersonation is disclosed on every tab.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import {
  PASSKEY_ENROLMENT_HREF,
  SECURITY_HASH_TABS,
  SECURITY_TAB_IDS,
  SESSIONS_HREF,
  ACCESS_KEYS_HREF,
  SERVICE_ACCOUNTS_HREF,
} from '../src/lib/security-links';
import { NAV_SECTIONS } from '../src/lib/nav';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

// The panels have their own suites; here only their presence matters.
jest.mock('@/components/settings/PasskeySection', () => ({ PasskeySection: () => <div>passkey-section</div> }));
jest.mock('@/components/settings/TotpSection', () => ({ TotpSection: () => <div>totp-section</div> }));
jest.mock('@/components/settings/SessionsSection', () => ({ SessionsSection: () => <div>sessions-section</div> }));
jest.mock('@/components/settings/AccessKeysSection', () => ({ AccessKeysSection: () => <div>access-keys-section</div> }));
jest.mock('@/components/settings/ServiceAccountsSection', () => ({ ServiceAccountsSection: () => <div>service-accounts-section</div> }));
jest.mock('@/components/admin/StepUpModal', () => ({ StepUpModal: () => null }));

const generateNewToken = jest.fn();
const listTokenHistory = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    generateNewToken: (...a: unknown[]) => generateNewToken(...a),
    listTokenHistory: (...a: unknown[]) => listTokenHistory(...a),
  },
}));

const replace = jest.fn();
let query: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query, pathname: '/dashboard/security', replace, push: jest.fn() }),
}));

import SecurityPage from '../pages/dashboard/security';
import ServiceAccountsPageMoved from '../pages/dashboard/settings/service-accounts';
import SettingsPage from '../pages/dashboard/settings';

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  window.location.hash = '';
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' } });
  listTokenHistory.mockResolvedValue({ success: true, data: { tokens: [] } });
});

afterEach(() => { window.location.hash = ''; });

describe('Security — one page, four answers', () => {
  it('opens on the factors a person signs in with', () => {
    render(<SecurityPage />);
    expect(screen.getByText('passkey-section')).toBeInTheDocument();
    expect(screen.getByText('totp-section')).toBeInTheDocument();
    // The password form is here too — it is a sign-in credential, not a profile field.
    expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument();
  });

  it('shows exactly one sessions view, on the sessions tab', () => {
    query = { tab: 'sessions' };
    render(<SecurityPage />);
    expect(screen.getAllByText('sessions-section')).toHaveLength(1);
  });

  it('puts access keys and the machine-token mint on the keys tab', () => {
    query = { tab: 'keys' };
    render(<SecurityPage />);
    expect(screen.getByText('access-keys-section')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate token/i })).toBeInTheDocument();
  });

  it('mints a machine token with the chosen lifetime and capability scope', async () => {
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 'tok.en.value', expiresIn: 7 * 86400 } });
    query = { tab: 'keys' };
    render(<SecurityPage />);

    fireEvent.change(screen.getByLabelText('Expires after'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Capability'), { target: { value: 'reporting:ingest' } });
    fireEvent.click(screen.getByRole('button', { name: /generate token/i }));

    await waitFor(() => expect(generateNewToken).toHaveBeenCalledWith({ expiresIn: 7 * 86400, scope: 'reporting:ingest' }));
    expect(await screen.findByText(/Valid for 7 days/)).toBeInTheDocument();
    // The history re-reads so the new issuance shows up.
    await waitFor(() => expect(listTokenHistory).toHaveBeenCalledTimes(2));
  });

  it('sends no scope and no subset for a FULL-access token, only the lifetime', async () => {
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 't', expiresIn: 30 * 86400 } });
    query = { tab: 'keys' };
    render(<SecurityPage />);
    fireEvent.click(screen.getByRole('button', { name: /full access/i }));
    fireEvent.click(screen.getByRole('button', { name: /generate token/i }));
    await waitFor(() => expect(generateNewToken).toHaveBeenCalledWith({ expiresIn: 30 * 86400 }));
  });

  it('defaults to SELECTED permissions, seeded with the read-only permissions the person holds', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'] } });
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 't', expiresIn: 30 * 86400 } });
    query = { tab: 'keys' };
    render(<SecurityPage />);
    fireEvent.click(screen.getByRole('button', { name: /generate token/i }));
    await waitFor(() => expect(generateNewToken).toHaveBeenCalledWith({
      expiresIn: 30 * 86400, permissions: ['pipelines:read', 'plugins:read'],
    }));
    expect(await screen.findByText(/2 selected permissions/)).toBeInTheDocument();
  });

  it('offers only lifetimes the API accepts (1–365 days)', () => {
    query = { tab: 'keys' };
    render(<SecurityPage />);
    const values = Array.from((screen.getByLabelText('Expires after') as HTMLSelectElement).options).map((o) => Number(o.value));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...values)).toBeLessThanOrEqual(365);
  });

  it('lists the token history with each token\'s status', async () => {
    listTokenHistory.mockResolvedValue({
      success: true,
      data: { tokens: [
        { id: 't1', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', status: 'active' },
        { id: 't2', createdAt: '2026-08-01T00:00:00Z', expiresAt: '2026-08-02T00:00:00Z', status: 'revoked' },
      ] },
    });
    query = { tab: 'keys' };
    render(<SecurityPage />);
    expect(await screen.findByText('active')).toBeInTheDocument();
    expect(screen.getByText('revoked')).toBeInTheDocument();
  });

  it('says so when no token has been issued, and offers a retry on failure', async () => {
    query = { tab: 'keys' };
    const { unmount } = render(<SecurityPage />);
    expect(await screen.findByText('No tokens issued yet')).toBeInTheDocument();
    unmount();

    listTokenHistory.mockRejectedValue(new Error('boom'));
    render(<SecurityPage />);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('hides the org service accounts from someone who cannot manage them', () => {
    query = { tab: 'service-accounts' };
    render(<SecurityPage />);
    expect(screen.queryByText('service-accounts-section')).not.toBeInTheDocument();
    expect(screen.getByText(/managed by an administrator/i)).toBeInTheDocument();
    // …and the tab isn't advertised either.
    expect(screen.queryByRole('button', { name: 'Service accounts' })).not.toBeInTheDocument();
  });

  it('shows them to someone who holds service_accounts:manage', () => {
    mockAuthGuard({
      user: { id: 'u1', organizationId: 'org-1' },
      can: (p: string) => p === 'service_accounts:manage',
    });
    query = { tab: 'service-accounts' };
    render(<SecurityPage />);
    expect(screen.getByText('service-accounts-section')).toBeInTheDocument();
  });

  it('discloses a read-only impersonation on every tab (service accounts included)', () => {
    mockAuthGuard({
      user: { id: 'u1', organizationId: 'org-1' },
      isReadOnly: true,
      can: (p: string) => p === 'service_accounts:manage',
    });
    query = { tab: 'service-accounts' };
    render(<SecurityPage />);
    expect(screen.getByText(/read-only session/i)).toBeInTheDocument();
  });
});

describe('enrolment deep links land', () => {
  it('every named link points at a tab the page actually renders', () => {
    for (const href of [PASSKEY_ENROLMENT_HREF, SESSIONS_HREF, ACCESS_KEYS_HREF, SERVICE_ACCOUNTS_HREF]) {
      const tab = new URL(href, 'https://x').searchParams.get('tab');
      expect(SECURITY_TAB_IDS).toContain(tab);
    }
  });

  it('every anchor is owned by the tab that renders it', () => {
    // `#passkeys` on the sessions tab would scroll to nothing, which is exactly
    // how the old links failed.
    for (const tab of Object.values(SECURITY_HASH_TABS)) expect(SECURITY_TAB_IDS).toContain(tab);
    expect(SECURITY_HASH_TABS.passkeys).toBe('factors');
    expect(SECURITY_HASH_TABS.totp).toBe('factors');
  });

  it('renders the section a deep-linked fragment names, with an anchor to scroll to', () => {
    query = { tab: 'factors' };
    window.location.hash = '#passkeys';
    const { container } = render(<SecurityPage />);
    const anchor = container.querySelector('#passkeys');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveTextContent('passkey-section');
    // Focusable, so a keyboard user lands on the section and not just the viewport.
    expect(anchor).toHaveAttribute('tabindex', '-1');
  });

  it('opens the Factors tab for a bare #passkeys, with no ?tab= at all', () => {
    window.location.hash = '#passkeys';
    render(<SecurityPage />);
    expect(screen.getByText('passkey-section')).toBeInTheDocument();
  });
});

describe('the pages that moved still forward', () => {
  it('sends the service-accounts page to its tab', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
    render(<ServiceAccountsPageMoved />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(SERVICE_ACCOUNTS_HREF));
  });

  it('keeps the permission gate on the forwarding page rather than bouncing a denial', () => {
    mockAuthGuard({
      user: { id: 'u1', organizationId: 'org-1' },
      accessDenied: { kind: 'permission', permission: 'service_accounts:manage', pathname: '/dashboard/settings/service-accounts' },
    });
    render(<ServiceAccountsPageMoved />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends settings?tab=security to the factors tab, fragment and all', async () => {
    query = { tab: 'security' };
    window.location.hash = '#totp';
    render(<SettingsPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/security?tab=factors#totp'));
  });
});

describe('the nav says what is there', () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);

  it('names Security, instead of hiding factors behind "Profile"', () => {
    const security = items.find((i) => i.href === '/dashboard/security');
    expect(security?.title).toBe('Security');
    // The settings entry covers profile AND organization, and says so.
    expect(items.find((i) => i.href === '/dashboard/settings')?.title).toBe('Profile & organization');
  });

  it('no longer advertises the pages that moved', () => {
    expect(items.map((i) => i.href)).not.toContain('/dashboard/tokens');
    expect(items.map((i) => i.href)).not.toContain('/dashboard/settings/service-accounts');
  });

  it('stays highlighted on the old service-accounts address while it forwards', () => {
    const security = items.find((i) => i.href === '/dashboard/security');
    // /dashboard/tokens is a server redirect now — it never renders, so it
    // needs no highlight rule.
    expect(security?.extraActivePaths).toEqual(['/dashboard/settings/service-accounts']);
  });

  it('is visible to an ordinary member — everyone has credentials', () => {
    const security = items.find((i) => i.href === '/dashboard/security');
    expect(security?.requiredPermission).toBeUndefined();
    expect(security?.adminOnly).toBeUndefined();
  });
});
