// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A sign-in submitted from `/` must not unmount the card that submitted it.
 *
 * The landing page swaps its body for a loader while the auth state is loading.
 * The sign-in actions used to drive that SAME `isLoading` flag, so pressing
 * "Sign in" unmounted the card mid-request: an account with an authenticator app
 * came back `mfa_required` to a component that no longer existed (the code
 * prompt never appeared), and a refused password lost its error message.
 *
 * Also pinned: a bootstrap administrator's sign-in lands on passkey enrolment.
 * The landing page's "authenticated visitor → return path" redirect must not
 * fire the moment the profile refresh lands and override that destination.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { useState } from 'react';

// A navigation that is "in progress" for the rest of the test — in the real app
// the resolved push has already unmounted `/`.
const mockPush = jest.fn<AnyFn>(() => new Promise(() => undefined));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push: mockPush, asPath: '/', query: {} })));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));

const mockApi = {
  isAuthenticated: jest.fn<AnyFn>(() => false),
  restoreSession: jest.fn<AnyFn>(async () => false),
  isImpersonating: jest.fn<AnyFn>(() => false),
  getProfile: jest.fn<AnyFn>(),
  getUserOrganizations: jest.fn<AnyFn>(async () => ({ data: { organizations: [] } })),
  setOrganizationId: jest.fn<AnyFn>(),
  onAccessTokenChange: () => () => undefined,
  onSessionExpired: jest.fn<AnyFn>(() => () => { /* unsubscribe */ }),
  login: jest.fn<AnyFn>(),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, ApiError }));

// The real card is exercised by the landing-* suites; this stand-in keeps the
// one property under test observable: its local state survives the submit.
jest.mock('@/components/landing/LandingPage', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useAuth } = require('../src/hooks/useAuth');
  function Card() {
    const { login, isSubmitting } = useAuth();
    const [outcome, setOutcome] = useState('');
    return (
      <div>
        <button disabled={isSubmitting} onClick={async () => {
          try { setOutcome((await login('ada@example.com', 'pw')).status); } catch (e) { setOutcome(`error: ${(e as Error).message}`); }
        }}>Sign in</button>
        <p>outcome: {outcome}</p>
      </div>
    );
  }
  return { __esModule: true, default: Card };
});
jest.mock('@/components/ui/Loading', () => ({ __esModule: true, LoadingPage: () => <p>LOADER</p> }));

import Home from '../pages/index';
import { AuthProvider } from '../src/hooks/useAuth';
import { PASSKEY_ENROLMENT_HREF } from '../src/lib/security-links';

const PROFILE = {
  success: true,
  data: { user: { id: 'u1', username: 'ada', email: 'ada@example.com', role: 'owner', organizationId: 'o1' } },
};

async function renderHome() {
  await act(async () => { render(<AuthProvider><Home /></AuthProvider>); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.isAuthenticated.mockReturnValue(false);
  mockApi.restoreSession.mockResolvedValue(false);
  mockApi.onSessionExpired.mockReturnValue(() => { /* unsubscribe */ });
  mockApi.getUserOrganizations.mockResolvedValue({ data: { organizations: [] } });
  mockPush.mockImplementation(() => new Promise(() => undefined));
});

describe('signing in from /', () => {
  it('keeps the card mounted while the password is checked, so the MFA prompt can appear', async () => {
    let resolveLogin: (v: unknown) => void = () => undefined;
    mockApi.login.mockReturnValue(new Promise((r) => { resolveLogin = r; }));
    await renderHome();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    // In flight: the card is still there (disabled), not swapped for the loader.
    expect(screen.queryByText('LOADER')).toBeNull();
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { resolveLogin({ success: true, data: { mfaRequired: true, challengeId: 'c1', expiresAt: 1 } }); });
    expect(screen.getByText('outcome: mfa_required')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps the card mounted to show a refused sign-in', async () => {
    mockApi.login.mockResolvedValue({ success: false, message: 'Invalid credentials' });
    await renderHome();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });
    expect(screen.getByText('outcome: error: Invalid credentials')).toBeTruthy();
  });

  it('sends a bootstrap administrator to passkey enrolment, not over it to the return path', async () => {
    mockApi.login.mockImplementation(async () => {
      mockApi.isAuthenticated.mockReturnValue(true);
      mockApi.getProfile.mockResolvedValue(PROFILE);
      return { success: true, data: { mfaEnrollmentPending: true } };
    });
    await renderHome();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); });

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(PASSKEY_ENROLMENT_HREF);
  });

  it('still redirects a visitor who arrives already signed in', async () => {
    mockApi.isAuthenticated.mockReturnValue(true);
    mockApi.restoreSession.mockResolvedValue(true);
    mockApi.getProfile.mockResolvedValue(PROFILE);
    await act(async () => { render(<AuthProvider><Home /></AuthProvider>); });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
    expect(screen.getByText('LOADER')).toBeTruthy();
  });
});
