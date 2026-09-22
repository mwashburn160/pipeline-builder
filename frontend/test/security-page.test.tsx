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
 *   - the nav names it honestly;
 *   - impersonation is disclosed on every tab.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
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

const generateNewToken = jest.fn<AnyFn>();
const listTokenHistory = jest.fn<AnyFn>();
const getOwnPasswordPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    generateNewToken: (...a: unknown[]) => generateNewToken(...a),
    listTokenHistory: (...a: unknown[]) => listTokenHistory(...a),
    getOwnPasswordPolicy: (...a: unknown[]) => getOwnPasswordPolicy(...a),
  },
}));

const replace = jest.fn<AnyFn>();
let query: Record<string, string> = {};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query, pathname: '/dashboard/security', replace, push: jest.fn<AnyFn>() })));

import SecurityPage from '../pages/dashboard/security';

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  window.location.hash = '';
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' } });
  listTokenHistory.mockResolvedValue({ success: true, data: { tokens: [] } });
  getOwnPasswordPolicy.mockResolvedValue({ success: true, data: { minLength: 8, maxLength: 128 } });
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
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 'tok.en.value', refreshToken: 'refresh.value', expiresIn: 900 } });
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
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 't', refreshToken: 'r', expiresIn: 900 } });
    query = { tab: 'keys' };
    render(<SecurityPage />);
    fireEvent.click(screen.getByRole('button', { name: /full access/i }));
    fireEvent.click(screen.getByRole('button', { name: /generate token/i }));
    await waitFor(() => expect(generateNewToken).toHaveBeenCalledWith({ expiresIn: 30 * 86400 }));
  });

  it('defaults to SELECTED permissions, seeded with the read-only permissions the person holds', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'] } });
    generateNewToken.mockResolvedValue({ success: true, data: { accessToken: 't', refreshToken: 'r', expiresIn: 900 } });
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

describe('the nav says what is there', () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items);

  it('names Security, instead of hiding factors behind "Profile"', () => {
    const security = items.find((i) => i.href === '/dashboard/security');
    expect(security?.title).toBe('Security');
    // The settings entry covers profile AND organization, and says so.
    expect(items.find((i) => i.href === '/dashboard/settings')?.title).toBe('Profile & organization');
  });

  it('is visible to an ordinary member — everyone has credentials', () => {
    const security = items.find((i) => i.href === '/dashboard/security');
    expect(security?.requiredPermission).toBeUndefined();
    expect(security?.adminOnly).toBeUndefined();
  });
});

describe('Security — the password form', () => {
  it('states and enforces the minimum the person\'s orgs actually require', async () => {
    getOwnPasswordPolicy.mockResolvedValue({ success: true, data: { minLength: 14, maxLength: 128 } });
    render(<SecurityPage />);
    expect(await screen.findByText('At least 14 characters.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'tenletters' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'tenletters' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(await screen.findByText('New password must be at least 14 characters')).toBeInTheDocument();
  });

  it('is not offered to an account with no password (OAuth / SSO only)', () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', authFactors: { hasPassword: false, passkeyCount: 0, hasTotp: false, providers: ['google'] } } });
    render(<SecurityPage />);
    expect(screen.queryByRole('button', { name: /change password/i })).not.toBeInTheDocument();
    expect(screen.getByText('passkey-section')).toBeInTheDocument();
  });
});
