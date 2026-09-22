// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin security notifications:
 *  - the Settings → Organization card: read-only for `plugins:read` (no write
 *    controls at all), editable with `org:settings`; the webhook secret is
 *    write-only (never shown, sent only when typed, cleared only on purpose);
 *    the external address shows pending / verified and can be re-sent; "Send
 *    test" reaches the test route; an http webhook can't be saved;
 *  - `/notifications/confirm`: nothing is POSTed on load (mail scanners), only
 *    on the button, and the call carries no credentials.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

let routerQuery: Record<string, string> = {};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: routerQuery, asPath: '/notifications/confirm', pathname: '/notifications/confirm', push: jest.fn(), replace: jest.fn() })));
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: null, isAuthenticated: false, isInitialized: true })));
jest.mock('@/hooks/useDarkMode', () => ({ __esModule: true, useDarkMode: () => ({ isDark: false, toggle: () => undefined }) }));

const getPrefs = jest.fn<AnyFn>();
const updatePrefs = jest.fn<AnyFn>();
const sendTest = jest.fn<AnyFn>();
const getMembers = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPluginSecurityNotifications: (...a: unknown[]) => getPrefs(...a),
    updatePluginSecurityNotifications: (...a: unknown[]) => updatePrefs(...a),
    sendPluginSecurityNotificationTest: (...a: unknown[]) => sendTest(...a),
    getOrganizationMembers: (...a: unknown[]) => getMembers(...a),
  },
}));

import { PluginSecurityNotificationSettings, webhookUrlProblem } from '../src/components/settings/PluginSecurityNotificationSettings';
import ConfirmNotificationAddressPage from '../pages/notifications/confirm';
import { clearQueryCache } from '../src/lib/query-cache';

const prefs = (over: Record<string, unknown> = {}) => ({
  recipientMode: 'writers',
  targetUsers: [],
  notifyRescan: true,
  digestMode: 'immediate',
  webhookUrl: 'https://hooks.example.com/pb',
  hasWebhookSecret: true,
  externalEmail: null,
  ...over,
});

const MEMBERS = [
  { id: 'u1', username: 'alice', email: 'alice@acme.test', role: 'admin', isActive: true },
  { id: 'u2', username: 'bob', email: 'bob@acme.test', role: 'member', isActive: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  clearQueryCache();
  getPrefs.mockResolvedValue({ success: true, data: { preferences: prefs() } });
  updatePrefs.mockImplementation(async (body: unknown) => ({ success: true, data: { preferences: prefs(body as Record<string, unknown>) } }));
  sendTest.mockResolvedValue({ success: true, data: { result: { relay: 'sent', webhook: { ok: true, code: 200 }, externalEmail: 'none' } } });
  getMembers.mockResolvedValue({ success: true, data: { members: MEMBERS } });
});

const renderCard = (props: { canEdit?: boolean; readOnly?: boolean } = {}) =>
  render(<PluginSecurityNotificationSettings orgId="org-1" canEdit={props.canEdit ?? true} readOnly={props.readOnly ?? false} />);

const saveButton = () => screen.getByRole('button', { name: /save notification settings/i });

describe('PluginSecurityNotificationSettings', () => {
  it('is read-only for a viewer without org:settings: no write controls, no secret field', async () => {
    getPrefs.mockResolvedValue({ success: true, data: { preferences: prefs({ recipientMode: 'users', targetUsers: ['u2'] }) } });
    renderCard({ canEdit: false });
    expect(await screen.findByTestId('plugin-security-notifications')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save notification settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send test/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/webhook signing secret/i)).not.toBeInTheDocument();
    expect(screen.getByText(/webhook signing secret: set/i)).toBeInTheDocument();
    expect(await screen.findByTestId('target-users')).toHaveTextContent('bob');
    expect(screen.getByRole('radio', { name: /only the members i choose/i })).toBeDisabled();
  });

  it('never shows the stored secret, and sends one only when typed', async () => {
    renderCard();
    const secret = await screen.findByLabelText(/webhook signing secret/i);
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('placeholder', expect.stringMatching(/keep the current secret/i));

    // A change that doesn't touch the secret leaves it out of the body.
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updatePrefs).toHaveBeenCalledTimes(1));
    expect(updatePrefs.mock.calls[0][0]).not.toHaveProperty('webhookSecret');
    expect(updatePrefs.mock.calls[0][0]).toMatchObject({ notifyRescan: false, webhookUrl: 'https://hooks.example.com/pb' });

    // Typing one sends it, once; the field clears after the save.
    fireEvent.change(screen.getByLabelText(/webhook signing secret/i), { target: { value: 's3cret' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updatePrefs).toHaveBeenCalledTimes(2));
    expect(updatePrefs.mock.calls[1][0]).toMatchObject({ webhookSecret: 's3cret' });
    await waitFor(() => expect(screen.getByLabelText(/webhook signing secret/i)).toHaveValue(''));
  });

  it('clears the secret only when asked to', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('checkbox', { name: /remove the signing secret/i }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updatePrefs).toHaveBeenCalled());
    expect(updatePrefs.mock.calls[0][0]).toMatchObject({ webhookSecret: null });
  });

  it('refuses an http webhook before it reaches the server', async () => {
    renderCard();
    const url = await screen.findByLabelText(/webhook url/i);
    fireEvent.change(url, { target: { value: 'http://hooks.example.com/pb' } });
    expect(screen.getByText(/must start with https/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(webhookUrlProblem('https://ok.example.com')).toBeNull();
    expect(webhookUrlProblem('not a url')).toMatch(/full URL/);
  });

  it('chooses members as recipients and needs at least one', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('radio', { name: /only the members i choose/i }));
    expect(await screen.findByText(/choose at least one member/i)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    const group = await screen.findByRole('group', { name: /members to notify/i });
    fireEvent.click(within(group).getAllByRole('checkbox')[0]);
    fireEvent.click(saveButton());
    await waitFor(() => expect(updatePrefs).toHaveBeenCalled());
    expect(updatePrefs.mock.calls[0][0]).toMatchObject({ recipientMode: 'users', targetUsers: ['u1'] });
  });

  it('shows a pending external address with Resend, and a verified one without', async () => {
    getPrefs.mockResolvedValue({ success: true, data: { preferences: prefs({ externalEmail: { masked: 's***@sec.test', verified: false, pendingExpiresAt: '2026-09-23T00:00:00Z' } }) } });
    const { unmount } = renderCard();
    const row = await screen.findByTestId('external-email');
    expect(row).toHaveTextContent('s***@sec.test');
    expect(row).toHaveTextContent(/pending confirmation/i);
    fireEvent.click(within(row).getByRole('button', { name: /resend confirmation/i }));
    await waitFor(() => expect(updatePrefs).toHaveBeenCalledWith({ resendConfirmation: true }));
    unmount();

    getPrefs.mockResolvedValue({ success: true, data: { preferences: prefs({ externalEmail: { masked: 's***@sec.test', verified: true } }) } });
    renderCard();
    const verified = await screen.findByTestId('external-email');
    expect(verified).toHaveTextContent(/verified/i);
    expect(within(verified).queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
  });

  it('says when an unconfirmed address\'s link has expired', async () => {
    getPrefs.mockResolvedValue({ success: true, data: { preferences: prefs({ externalEmail: { masked: 's***@sec.test', verified: false, pendingExpiresAt: null } }) } });
    renderCard();
    const row = await screen.findByTestId('external-email');
    expect(row).toHaveTextContent(/confirmation link expired/i);
    expect(within(row).getByRole('button', { name: /resend confirmation/i })).toBeInTheDocument();
  });

  it('sends a new external address for confirmation and says so', async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText(/add an address/i), { target: { value: 'security@partner.test' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updatePrefs).toHaveBeenCalled());
    expect(updatePrefs.mock.calls[0][0]).toMatchObject({ externalEmail: 'security@partner.test' });
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/confirmation link/i));
  });

  it('sends a test notice, and names a channel that failed', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /send test/i }));
    await waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalled();

    sendTest.mockResolvedValue({ success: true, data: { result: { relay: 'queued', webhook: { ok: false, code: 500 }, externalEmail: 'pending' } } });
    fireEvent.click(screen.getByRole('button', { name: /send test/i }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('the webhook failed (HTTP 500)')));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('not confirmed yet'));
  });

  it('disables every write control in a read-only session', async () => {
    renderCard({ readOnly: true });
    await screen.findByTestId('plugin-security-notifications');
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: /send test/i })).toBeDisabled();
    expect(screen.getByLabelText(/webhook url/i)).toBeDisabled();
  });
});

describe('/notifications/confirm', () => {
  const fetchMock = jest.fn<AnyFn>();
  const realFetch = global.fetch;
  const reply = (status: number, body: Record<string, unknown>) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body,
  });
  beforeEach(() => { global.fetch = fetchMock as unknown as typeof fetch; routerQuery = {}; fetchMock.mockReset(); });
  afterEach(() => { global.fetch = realFetch; });

  it('does not POST on load; confirms only on the button, without credentials', async () => {
    routerQuery = { token: 'tok-1' };
    fetchMock.mockResolvedValue(reply(200, { success: true, data: { verified: true } }));
    render(<ConfirmNotificationAddressPage />);
    expect(screen.getByTestId('confirm-prompt')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByTestId('confirm-done')).toBeInTheDocument();
    const [[url, init]] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(url).toBe('/api/public/plugin-security-notifications/confirm');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'tok-1' });
    const headers = Object.keys((init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
    expect(headers).not.toContain('authorization');
  });

  it('explains a used or expired link', async () => {
    routerQuery = { token: 'old' };
    fetchMock.mockResolvedValue(reply(400, { success: false, code: 'VALIDATION_ERROR', message: 'Invalid or expired token' }));
    render(<ConfirmNotificationAddressPage />);
    fireEvent.click(screen.getByRole('button', { name: /confirm address/i }));
    expect(await screen.findByTestId('confirm-error')).toHaveTextContent(/more than 24 hours old/);
  });

  it('without a token, says so and offers no button', () => {
    render(<ConfirmNotificationAddressPage />);
    expect(screen.getByText('No confirmation token')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm address/i })).not.toBeInTheDocument();
  });
});
