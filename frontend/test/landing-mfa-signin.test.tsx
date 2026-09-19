// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The second-factor step on the sign-in card.
 *
 * A password sign-in for an account with an authenticator app resolves to
 * `mfa_required` instead of a session, and the card swaps its whole body for a
 * code field. Replacing rather than appending matters: the password is already
 * proven, and leaving the field on screen only invites people to retype it —
 * which is also why the component drops it from state.
 *
 * The other half is the escape hatches: a dead challenge drops back to the
 * password form (retrying the code there is pointless), and "use a different
 * account" always does.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const login = jest.fn();
const completeMfaLogin = jest.fn();
const loginWithPasskey = jest.fn();
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ login, completeMfaLogin, loginWithPasskey, isLoading: false }),
}));
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ query: {}, push: jest.fn() }),
}));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOAuthProviders: jest.fn().mockResolvedValue({ data: { providers: ['google'] } }),
    // Domain SSO discovery runs off the identifier field; nothing here is federated.
    discoverSso: jest.fn().mockResolvedValue({ data: { sso: false } }),
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
  cancelPasskeyCeremony: jest.fn(),
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

const CHALLENGE = { status: 'mfa_required', challengeId: 'chal-1', expiresAt: 0 };

/** Sign in with a password and land on the code step. */
async function reachCodeStep() {
  await act(async () => { render(<LandingPage />); });
  fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
}

const codeField = () => screen.getByLabelText('Authentication code');

beforeEach(() => {
  jest.clearAllMocks();
  login.mockResolvedValue(CHALLENGE);
  completeMfaLogin.mockResolvedValue(undefined);
});

describe('landing page — the MFA code step', () => {
  it('replaces the password form with the code field', async () => {
    await reachCodeStep();

    expect(screen.getByRole('heading', { name: /two-factor authentication/i })).toBeInTheDocument();
    expect(codeField()).toBeInTheDocument();
    // The password field — and the whole alternate-sign-in block — are gone.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('declares one-time-code autofill, so phones can offer the code', async () => {
    await reachCodeStep();
    expect(codeField()).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('says a recovery code works too', async () => {
    await reachCodeStep();
    expect(screen.getByText(/recovery codes/i)).toBeInTheDocument();
  });

  it('exchanges the challenge and the code for the session', async () => {
    await reachCodeStep();
    fireEvent.change(codeField(), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^verify$/i })); });

    expect(completeMfaLogin).toHaveBeenCalledWith('chal-1', '123456');
  });

  it('accepts a recovery code at the same field, trimmed', async () => {
    await reachCodeStep();
    fireEvent.change(codeField(), { target: { value: '  ABCDE-FGHIJ  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^verify$/i })); });

    expect(completeMfaLogin).toHaveBeenCalledWith('chal-1', 'ABCDE-FGHIJ');
  });

  it('keeps the code step up after a wrong code, so a typo is not a re-login', async () => {
    completeMfaLogin.mockRejectedValue(new Error('Invalid credentials'));
    await reachCodeStep();
    fireEvent.change(codeField(), { target: { value: '000000' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^verify$/i })); });

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(codeField()).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('drops back to the password form when the challenge has expired', async () => {
    // Matched on the CODE, not on the message — wording drifts, codes don't.
    completeMfaLogin.mockRejectedValue(Object.assign(
      new Error('This sign-in expired. Please enter your password again.'),
      { code: 'TOTP_INVALID_CHALLENGE' },
    ));
    await reachCodeStep();
    fireEvent.change(codeField(), { target: { value: '123456' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^verify$/i })); });

    // Retrying the code against a dead challenge can only fail.
    await waitFor(() => expect(screen.getByLabelText('Password')).toBeInTheDocument());
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
  });

  it('lets the person go back and sign in as someone else', async () => {
    await reachCodeStep();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /use a different account/i })); });

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
  });

  it('will not submit an empty code', async () => {
    await reachCodeStep();
    expect(screen.getByRole('button', { name: /^verify$/i })).toBeDisabled();
    expect(completeMfaLogin).not.toHaveBeenCalled();
  });

  it('never reaches the code step for an account without an authenticator', async () => {
    login.mockResolvedValue({ status: 'complete' });
    await reachCodeStep();

    expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
