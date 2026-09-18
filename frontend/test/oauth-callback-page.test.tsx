// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * /auth/callback/[provider] consumes the shared OAuth intent (src/lib/oauth-intent)
 * instead of a local copy of its key/shape. Pins the branches: login lands on the
 * stored (same-site) return URL, a state mismatch fails closed, the intent is
 * single-use, and invite-accept restarts a normal login with a fresh intent.
 */

import { render, screen, waitFor } from '@testing-library/react';
import OAuthCallbackPage from '../pages/auth/callback/[provider]';
import { OAUTH_INTENT_KEY } from '../src/lib/oauth-intent';

let mockQuery: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: mockQuery, replace: mockReplace }),
}));

const mockRefreshUser = jest.fn().mockResolvedValue(undefined);
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ refreshUser: mockRefreshUser }),
}));

jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));

// Mocked by resolved path, so oauth-intent's relative `./api` import sees it too.
jest.mock('@/lib/api', () => {
  const api = { completeOAuthCallback: jest.fn(), acceptInvitationOAuth: jest.fn(), getOAuthUrl: jest.fn() };
  return { __esModule: true, default: api, api };
});
const mockApi = jest.requireMock('@/lib/api').api as Record<'completeOAuthCallback' | 'acceptInvitationOAuth' | 'getOAuthUrl', jest.Mock>;

// Step-up re-auth: keep the real state-prefix predicate, spy on the hand-off.
const publishReauthResult = jest.fn();
jest.mock('@/lib/step-up-reauth', () => ({
  __esModule: true,
  isReauthState: (state?: string) => typeof state === 'string' && state.startsWith('reauth.'),
  publishReauthResult: (...args: unknown[]) => publishReauthResult(...args),
}));

const stash = (intent: object) => sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify(intent));

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  mockQuery = { provider: 'google', code: 'c1', state: 's1' };
  mockApi.completeOAuthCallback.mockResolvedValue({ success: true });
});

it('completes a login, consumes the intent, and lands on its return URL', async () => {
  stash({ state: 's1', kind: 'login', returnUrl: '/dashboard/pipelines' });
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard/pipelines'));
  expect(mockApi.completeOAuthCallback).toHaveBeenCalledWith('google', { code: 'c1', state: 's1' });
  expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeNull();
});

it('rejects an open-redirect return URL', async () => {
  stash({ state: 's1', kind: 'login', returnUrl: '//evil.example' });
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
});

it('fails closed when the stored intent state does not match', async () => {
  stash({ state: 'other', kind: 'invite', inviteToken: 't', provider: 'google' });
  render(<OAuthCallbackPage />);
  expect(await screen.findByText(/no longer matches your pending request/i)).toBeInTheDocument();
  expect(mockApi.completeOAuthCallback).not.toHaveBeenCalled();
  expect(mockApi.acceptInvitationOAuth).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).toBeNull();
});

it('accepts an invite, then restarts a normal login with a fresh login intent', async () => {
  stash({ state: 's1', kind: 'invite', inviteToken: 'inv-1', provider: 'google' });
  mockApi.acceptInvitationOAuth.mockResolvedValue({ success: true });
  mockApi.getOAuthUrl.mockResolvedValue({ data: { url: '#provider', state: 's2' } });
  render(<OAuthCallbackPage />);
  await waitFor(() => expect(sessionStorage.getItem(OAUTH_INTENT_KEY)).not.toBeNull());
  expect(mockApi.acceptInvitationOAuth).toHaveBeenCalledWith({ token: 'inv-1', oauthProvider: 'google', code: 'c1', state: 's1' });
  expect(JSON.parse(sessionStorage.getItem(OAUTH_INTENT_KEY)!)).toEqual({ state: 's2', kind: 'login', returnUrl: '/dashboard' });
  expect(mockApi.completeOAuthCallback).not.toHaveBeenCalled();
});

it('hands a step-up re-auth back to the opener instead of signing in', async () => {
  const close = jest.spyOn(window, 'close').mockImplementation(() => {});
  mockQuery = { provider: 'google', code: 'c9', state: 'reauth.abc' };
  render(<OAuthCallbackPage />);

  await waitFor(() => expect(publishReauthResult).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'pb-step-up-reauth', state: 'reauth.abc', code: 'c9' }),
  ));
  expect(mockApi.completeOAuthCallback).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  close.mockRestore();
});

it('reports a provider denial to the opener rather than a code', async () => {
  const close = jest.spyOn(window, 'close').mockImplementation(() => {});
  mockQuery = { provider: 'google', state: 'reauth.abc', error: 'access_denied' };
  render(<OAuthCallbackPage />);

  await waitFor(() => expect(publishReauthResult).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'reauth.abc', error: expect.stringContaining('access_denied') }),
  ));
  expect(publishReauthResult.mock.calls[0][0]).not.toHaveProperty('code');
  close.mockRestore();
});
