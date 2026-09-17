// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notification preferences do what they say, and follow the user.
 *
 *   - "Mute quota warnings" hides the quota banner while usage is only nearing
 *     a limit, immediately, without a reload.
 *   - An exceeded limit is still shown when muted — requests are being rejected.
 *   - The setting is saved on the server for the active org, and a fresh
 *     browser (empty local copy) picks it up from there.
 *   - It is scoped to the signed-in user, and a late server load never
 *     reverts a newer toggle.
 *   - A save the server refuses puts the toggle back and says so.
 *   - During read-only impersonation the toggle is disabled.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuotaBanner } from '../src/components/ui/QuotaBanner';
import NotificationsPage from '../pages/dashboard/notifications';
import { saveNotificationPrefs } from '../src/lib/notification-prefs';
import { __resetPreferencesStoreForTests, readPreferences } from '../src/lib/preferences-store';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

const authGuard = mockAuthGuard({ user: { id: 'me', organizationId: 'org-1', organizationName: 'Acme' } });
const toast = pageToast;

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ user: authGuard.user }) }));

const cachedMute = (userId = 'me', orgId = 'org-1') => readPreferences(userId, orgId).notifications;
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getOwnQuotas = jest.fn();
const getPreferences = jest.fn();
const updatePreferences = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnQuotas: (...a: unknown[]) => getOwnQuotas(...a),
    getPreferences: (...a: unknown[]) => getPreferences(...a),
    updatePreferences: (...a: unknown[]) => updatePreferences(...a),
  },
}));

/** An org using `used` of 100 API calls. */
function quotaAt(used: number) {
  return {
    success: true,
    data: {
      quota: {
        orgId: 'org-1', name: 'Acme', slug: 'acme',
        quotas: { apiCalls: { used, limit: 100, unlimited: false, remaining: Math.max(0, 100 - used), resetAt: '2026-10-01T00:00:00Z' } },
      },
    },
  };
}
const serverPrefs = (muteQuotaWarnings: boolean) => ({
  success: true,
  data: { preferences: { favorites: [], recents: [], notifications: { muteQuotaWarnings } } },
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetPreferencesStoreForTests();
  jest.clearAllMocks();
  authGuard.isReadOnly = false;
  authGuard.user = { id: 'me', organizationId: 'org-1', organizationName: 'Acme' };
  getPreferences.mockResolvedValue(serverPrefs(false));
  updatePreferences.mockImplementation(async (patch: { notifications: { muteQuotaWarnings: boolean } }) =>
    serverPrefs(patch.notifications.muteQuotaWarnings));
});

describe('quota banner', () => {
  it('shows an approaching limit by default', async () => {
    getOwnQuotas.mockResolvedValue(quotaAt(95));
    render(<QuotaBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/API calls usage at 95%/);
  });

  it('refreshes the quota every 60s', async () => {
    jest.useFakeTimers();
    try {
      getOwnQuotas.mockResolvedValue(quotaAt(10));
      render(<QuotaBanner />);
      await act(async () => { await Promise.resolve(); });
      expect(getOwnQuotas).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      getOwnQuotas.mockResolvedValue(quotaAt(95));
      await act(async () => { jest.advanceTimersByTime(60_000); await Promise.resolve(); });

      expect(getOwnQuotas).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('alert')).toHaveTextContent(/API calls usage at 95%/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('hides it once muted — immediately, without a reload', async () => {
    getOwnQuotas.mockResolvedValue(quotaAt(95));
    render(<QuotaBanner />);
    await screen.findByRole('alert');

    await act(() => saveNotificationPrefs('me', 'org-1', { muteQuotaWarnings: true }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('picks the mute up from the SERVER in a browser that never saved it', async () => {
    getPreferences.mockResolvedValue(serverPrefs(true));
    getOwnQuotas.mockResolvedValue(quotaAt(95));
    render(<QuotaBanner />);

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(cachedMute()).toEqual({ muteQuotaWarnings: true });
  });

  it("doesn't apply another user's mute (same browser, same org)", async () => {
    getOwnQuotas.mockResolvedValue(quotaAt(95));
    await act(() => saveNotificationPrefs('someone-else', 'org-1', { muteQuotaWarnings: true }));

    render(<QuotaBanner />);

    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent(/API calls usage at 95%/);
    expect(cachedMute('someone-else')).toEqual({ muteQuotaWarnings: true });
    expect(cachedMute('me')).toEqual({ muteQuotaWarnings: false });
  });

  it('a server load that resolves AFTER muting does not unmute', async () => {
    let resolveLoad!: (v: unknown) => void;
    getPreferences.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    getOwnQuotas.mockResolvedValue(quotaAt(95));
    render(<QuotaBanner />);
    await screen.findByRole('alert');

    await act(() => saveNotificationPrefs('me', 'org-1', { muteQuotaWarnings: true }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    await act(async () => { resolveLoad(serverPrefs(false)); await Promise.resolve(); await Promise.resolve(); });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(cachedMute()).toEqual({ muteQuotaWarnings: true });
  });

  it('still shows an EXCEEDED limit when muted, because requests are being rejected', async () => {
    getPreferences.mockResolvedValue(serverPrefs(true));
    getOwnQuotas.mockResolvedValue(quotaAt(100));
    render(<QuotaBanner />);
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent(/quota exceeded/);
  });
});

describe('Notifications page', () => {
  it('saves the toggle on the server for the active org', async () => {
    render(<NotificationsPage />);
    const toggle = await screen.findByRole('switch', { name: /mute quota warnings/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ notifications: { muteQuotaWarnings: true } }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/Acme, on every device/)).toBeInTheDocument();
  });

  it('puts the toggle back and says so when the server refuses the save', async () => {
    updatePreferences.mockRejectedValue(new Error('Service unavailable'));
    render(<NotificationsPage />);
    const toggle = await screen.findByRole('switch', { name: /mute quota warnings/i });

    fireEvent.click(toggle);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(cachedMute()).toEqual({ muteQuotaWarnings: false });
  });

  it('a server load that resolves AFTER the toggle does not flip it back', async () => {
    let resolveLoad!: (v: unknown) => void;
    getPreferences.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    render(<NotificationsPage />);
    const toggle = await screen.findByRole('switch', { name: /mute quota warnings/i });

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    await act(async () => { resolveLoad(serverPrefs(false)); await Promise.resolve(); await Promise.resolve(); });

    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('disables the toggle during read-only impersonation', async () => {
    authGuard.isReadOnly = true;
    render(<NotificationsPage />);
    expect(await screen.findByRole('switch', { name: /mute quota warnings/i })).toBeDisabled();
  });

  it('offers only preferences that something actually reads', async () => {
    render(<NotificationsPage />);
    await screen.findByRole('switch', { name: /mute quota warnings/i });
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });
});
