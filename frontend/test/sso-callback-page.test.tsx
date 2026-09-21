// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * /auth/sso/[orgId]/callback — the OIDC return leg.
 *
 * One redirect_uri serves two flows, and the `state` is what tells them apart:
 * a `reauth.`-prefixed state belongs to a step-up popup (no session is minted
 * here, the result goes back to the window that opened it), anything else is a
 * sign-in that has to be completed. Getting that order wrong would either redeem
 * a step-up as a login or leave every SSO sign-in spinning — which is what the
 * page did before it learned the sign-in branch at all.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import SsoCallbackPage from '../pages/auth/sso/[orgId]/callback';
import { forgetReturnPath } from '../src/lib/return-to';

let mockQuery: Record<string, string> = {};
const mockReplace = jest.fn<AnyFn>();
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: mockQuery, replace: mockReplace }),
}));

const mockRefreshUser = jest.fn<AnyFn>().mockResolvedValue(undefined);
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ refreshUser: mockRefreshUser }),
}));

jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));

jest.mock('@/lib/api', () => {
  const api = { completeSsoCallback: jest.fn<AnyFn>() };
  return { __esModule: true, default: api, api };
});
const mockApi = jest.requireMock<Record<string, unknown>>('@/lib/api').api as Record<'completeSsoCallback', jest.Mock<AnyFn>>;

const publishReauthResult = jest.fn<AnyFn>();
jest.mock('@/lib/step-up-reauth', () => ({
  __esModule: true,
  isReauthState: (state?: string) => typeof state === 'string' && state.startsWith('reauth.'),
  publishReauthResult: (...args: unknown[]) => publishReauthResult(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery = { orgId: 'org-1', code: 'c1', state: 's1' };
  mockApi.completeSsoCallback.mockResolvedValue({ success: true });
  window.close = jest.fn<AnyFn>();
});

it('completes the sign-in and lands on the dashboard', async () => {
  render(<SsoCallbackPage />);

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
  expect(mockApi.completeSsoCallback).toHaveBeenCalledWith('org-1', { code: 'c1', state: 's1' });
  expect(mockRefreshUser).toHaveBeenCalled();
});

it('lands on the page remembered before sign-in, not the dashboard', async () => {
  sessionStorage.setItem('pb.postSignIn', '/dashboard/audit?action=authz.denied');
  render(<SsoCallbackPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard/audit?action=authz.denied'));
  // Drop the in-memory claim so later tests start clean.
  forgetReturnPath();
});

it('ignores a remembered off-site path', async () => {
  sessionStorage.setItem('pb.postSignIn', 'https://evil.example');
  render(<SsoCallbackPage />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
});

it('shows the refusal the backend stated, in its own words', async () => {
  mockApi.completeSsoCallback.mockRejectedValue(
    new Error('This organization has not verified ownership of your email domain, so it cannot sign you in with single sign-on'),
  );
  render(<SsoCallbackPage />);

  expect(await screen.findByText(/has not verified ownership of your email domain/i)).toBeInTheDocument();
  expect(mockReplace).not.toHaveBeenCalled();
});

it('hands a step-up re-auth back to its opener instead of signing anyone in', async () => {
  mockQuery = { orgId: 'org-1', code: 'c1', state: 'reauth.abc' };
  render(<SsoCallbackPage />);

  await waitFor(() => expect(publishReauthResult).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'pb-step-up-reauth', state: 'reauth.abc', code: 'c1' }),
  ));
  expect(mockApi.completeSsoCallback).not.toHaveBeenCalled();
  expect(screen.getByText(/you can close this window/i)).toBeInTheDocument();
});

it('reports a provider that cancelled or denied the sign-in', async () => {
  mockQuery = { orgId: 'org-1', error: 'access_denied' };
  render(<SsoCallbackPage />);

  expect(await screen.findByText(/cancelled or denied by your identity provider \(access_denied\)/i)).toBeInTheDocument();
  expect(mockApi.completeSsoCallback).not.toHaveBeenCalled();
});

it('refuses a bookmarked callback with no pending sign-in', async () => {
  mockQuery = { orgId: 'org-1' };
  render(<SsoCallbackPage />);

  expect(await screen.findByText(/no pending sign-in/i)).toBeInTheDocument();
  expect(mockApi.completeSsoCallback).not.toHaveBeenCalled();
});

it('hands a TEST CONNECTION back to the settings page instead of signing anyone in', async () => {
  // Published over the same-origin channel + opener, never redeemed here.
  const posted: unknown[] = [];
  const opener = { postMessage: (m: unknown) => posted.push(m) };
  Object.defineProperty(window, 'opener', { value: opener, configurable: true });
  mockQuery = { orgId: 'org-1', code: 'test-code', state: 'ssotest.abc.sig' };
  render(<SsoCallbackPage />);

  await waitFor(() => expect(window.close).toHaveBeenCalled());
  expect(posted).toEqual([{ type: 'pb-sso-test', state: 'ssotest.abc.sig', code: 'test-code' }]);
  expect(mockApi.completeSsoCallback).not.toHaveBeenCalled();
  expect(mockRefreshUser).not.toHaveBeenCalled();
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
});

it('passes an IdP error on a test connection back as the result', async () => {
  const posted: unknown[] = [];
  Object.defineProperty(window, 'opener', { value: { postMessage: (m: unknown) => posted.push(m) }, configurable: true });
  mockQuery = { orgId: 'org-1', error: 'access_denied', state: 'ssotest.abc.sig' };
  render(<SsoCallbackPage />);
  await waitFor(() => expect(window.close).toHaveBeenCalled());
  expect(posted).toEqual([{ type: 'pb-sso-test', state: 'ssotest.abc.sig', error: 'access_denied' }]);
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
});
