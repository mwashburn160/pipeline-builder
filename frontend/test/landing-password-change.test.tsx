// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The forced password change on the sign-in card.
 *
 * When an org raises its minimum password length, an existing shorter password
 * can only be caught at the next password sign-in (only hashes are stored). The
 * sign-in then resolves to `password_change_required` — no session — and the
 * card asks for a NEW password of at least the org minimum, directly or after
 * the second-factor step.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const login = jest.fn<AnyFn>();
const completeMfaLogin = jest.fn<AnyFn>();
const completeRequiredPasswordChange = jest.fn<AnyFn>();
const loginWithPasskey = jest.fn<AnyFn>();
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ login, completeMfaLogin, completeRequiredPasswordChange, loginWithPasskey, isLoading: false }),
}));
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ query: {}, push: jest.fn<AnyFn>() }),
}));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOAuthProviders: jest.fn<AnyFn>().mockResolvedValue({ data: { providers: [] } }),
    discoverSso: jest.fn<AnyFn>().mockResolvedValue({ data: { sso: false } }),
  },
}));
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => false,
  browserSupportsWebAuthnAutofill: async () => false,
  cancelPasskeyCeremony: jest.fn<AnyFn>(),
}));

import LandingPage from '../src/components/landing/LandingPage';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const CHANGE = { status: 'password_change_required', challengeId: 'pw-1', expiresAt: 0, minLength: 14 };

async function signIn() {
  await act(async () => { render(<LandingPage />); });
  fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Short1pass' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
}

beforeEach(() => {
  jest.clearAllMocks();
  completeRequiredPasswordChange.mockResolvedValue({ status: 'complete' });
});

describe('landing page — password below the org policy', () => {
  it('swaps the card for a new-password step naming the minimum', async () => {
    login.mockResolvedValue(CHANGE);
    await signIn();
    expect(screen.getByText('Choose a new password')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('checks the minimum and the confirmation locally, then completes with the handle', async () => {
    login.mockResolvedValue(CHANGE);
    await signIn();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Short1pass' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Short1pass' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /change password and sign in/i })); });
    expect(screen.getByText(/at least 14 characters/)).toBeInTheDocument();
    expect(completeRequiredPasswordChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'LongEnoughPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'LongEnoughPassw0rd' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /change password and sign in/i })); });
    expect(completeRequiredPasswordChange).toHaveBeenCalledWith('pw-1', 'LongEnoughPassw0rd');
  });

  it('a dead handle drops back to the sign-in form', async () => {
    login.mockResolvedValue(CHANGE);
    completeRequiredPasswordChange.mockRejectedValue(Object.assign(new Error('This sign-in expired.'), { code: 'PASSWORD_CHANGE_CHALLENGE_INVALID' }));
    await signIn();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'LongEnoughPassw0rd' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'LongEnoughPassw0rd' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /change password and sign in/i })); });
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());
  });

  it('reaches the same step after the second factor', async () => {
    login.mockResolvedValue({ status: 'mfa_required', challengeId: 'chal-1', expiresAt: 0 });
    completeMfaLogin.mockResolvedValue(CHANGE);
    await signIn();
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify/i })); });
    expect(screen.getByText('Choose a new password')).toBeInTheDocument();
  });
});
