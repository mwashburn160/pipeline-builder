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
 *   - Ecosystem email opt-outs default ON, persist as a nested `ecosystem`
 *     object, and the moderation digest is offered only in the system org.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuotaBanner } from '../src/components/ui/QuotaBanner';
import NotificationsPage from '../pages/dashboard/notifications';
import { saveNotificationPrefs } from '../src/lib/notification-prefs';
import { __resetPreferencesStoreForTests, readPreferences, DEFAULT_ECOSYSTEM_NOTIFICATION_PREFS } from '../src/lib/preferences-store';
import { SYSTEM_ORG_ID } from '../src/lib/constants';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

const authGuard = mockAuthGuard({ user: { id: 'me', organizationId: 'org-1', organizationName: 'Acme' } });
const toast = pageToast;

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ user: authGuard.user }) }));

const cachedMute = (userId = 'me', orgId = 'org-1') => ({ muteQuotaWarnings: readPreferences(userId, orgId).notifications.muteQuotaWarnings });
const ECO = DEFAULT_ECOSYSTEM_NOTIFICATION_PREFS;
/** A full prefs object with the ecosystem defaults. */
const prefsWith = (muteQuotaWarnings: boolean) => ({ muteQuotaWarnings, ecosystem: ECO });
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getOwnQuotas = jest.fn<AnyFn>();
const getPreferences = jest.fn<AnyFn>();
const updatePreferences = jest.fn<AnyFn>();
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
const serverPrefs = (muteQuotaWarnings: boolean, ecosystem?: Record<string, boolean>) => ({
  success: true,
  data: { preferences: { favorites: [], recents: [], notifications: { muteQuotaWarnings, ...(ecosystem ? { ecosystem } : {}) } } },
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  __resetPreferencesStoreForTests();
  jest.clearAllMocks();
  authGuard.isReadOnly = false;
  authGuard.user = { id: 'me', organizationId: 'org-1', organizationName: 'Acme' };
  getPreferences.mockResolvedValue(serverPrefs(false));
  updatePreferences.mockImplementation(async (patch: { notifications: { muteQuotaWarnings: boolean; ecosystem?: Record<string, boolean> } }) =>
    serverPrefs(patch.notifications.muteQuotaWarnings, patch.notifications.ecosystem));
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

    await act(() => saveNotificationPrefs('me', 'org-1', prefsWith(true)));

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
    await act(() => saveNotificationPrefs('someone-else', 'org-1', prefsWith(true)));

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

    await act(() => saveNotificationPrefs('me', 'org-1', prefsWith(true)));
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

    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ notifications: { muteQuotaWarnings: true, ecosystem: ECO } }));
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
    // The quota mute + the three tenant-facing ecosystem email opt-outs.
    expect(screen.getAllByRole('switch')).toHaveLength(4);
  });
});

describe('Notifications page — ecosystem emails', () => {
  it('defaults every ecosystem email ON (also when the server omits the object)', async () => {
    render(<NotificationsPage />);
    for (const name of [/review emails/i, /upgrade and deprecation emails/i, /install request emails/i]) {
      expect(await screen.findByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
    }
    await waitFor(() => expect(getPreferences).toHaveBeenCalled());
    expect(readPreferences('me', 'org-1').notifications.ecosystem).toEqual(ECO);
  });

  it('reads the server values, filling missing keys with defaults', async () => {
    getPreferences.mockResolvedValue(serverPrefs(false, { reviewsEmail: false }));
    render(<NotificationsPage />);
    const reviews = await screen.findByRole('switch', { name: /review emails/i });
    await waitFor(() => expect(reviews).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByRole('switch', { name: /install request emails/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves an opt-out as the nested ecosystem object', async () => {
    render(<NotificationsPage />);
    const upgrades = await screen.findByRole('switch', { name: /upgrade and deprecation emails/i });
    fireEvent.click(upgrades);
    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({
      notifications: { muteQuotaWarnings: false, ecosystem: { ...ECO, upgradesEmail: false } },
    }));
    await waitFor(() => expect(upgrades).toHaveAttribute('aria-checked', 'false'));
  });

  it('offers the moderation digest only in the system org', async () => {
    const { unmount } = render(<NotificationsPage />);
    await screen.findByRole('switch', { name: /review emails/i });
    expect(screen.queryByRole('switch', { name: /moderation digest/i })).not.toBeInTheDocument();
    unmount();

    authGuard.user = { id: 'me', organizationId: SYSTEM_ORG_ID, organizationName: 'System' };
    render(<NotificationsPage />);
    expect(await screen.findByRole('switch', { name: /daily moderation digest email/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('says what cannot be turned off', async () => {
    render(<NotificationsPage />);
    expect(await screen.findByText(/in-app messages are always delivered/i)).toBeInTheDocument();
    expect(screen.getByText(/can.t be turned off/i)).toBeInTheDocument();
  });
});
