// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The lost-factor dead ends on the sign-in card.
 *
 * Two of them, and neither used to have an answer on screen:
 *
 *   - the CODE step offered "Verify" and "Use a different account", so somebody
 *     whose phone is gone had nothing to click. The recovery code is now named
 *     in the copy (a placeholder disappears the moment anyone types), and the
 *     case where those are gone too is answered honestly: recovery is an
 *     operator command against the platform, never a route, so what the page
 *     owes the person is WHO to ask and WHAT they run;
 *   - the ORG POLICY refusal (401 MFA_REQUIRED) — the org's grace period has
 *     passed and the account has no factor, so the password was right and there
 *     is still no way in. That is not a credentials error and must not read like
 *     one.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act } from '@testing-library/react';

const login = jest.fn<AnyFn>();
const completeMfaLogin = jest.fn<AnyFn>();
const loginWithPasskey = jest.fn<AnyFn>();
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ login, completeMfaLogin, loginWithPasskey, isSubmitting: false }),
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
  browserSupportsWebAuthn: () => true,
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

/** Sign in with a password and see where it lands. */
async function signIn() {
  await act(async () => { render(<LandingPage />); });
  fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'ada' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
}

beforeEach(() => {
  jest.clearAllMocks();
  login.mockResolvedValue({ status: 'mfa_required', challengeId: 'chal-1', expiresAt: 0 });
});

describe('the code step', () => {
  it('says in the copy — not just the placeholder — that a recovery code goes here', async () => {
    await signIn();

    const prose = screen.getByText(/recovery codes you saved/i);
    expect(prose).toBeInTheDocument();
    expect(prose).toHaveTextContent(/this same box/i);
    expect(prose).toHaveTextContent(/each one works once/i);
  });

  it('keeps the way out folded away until it is asked for', async () => {
    await signIn();

    const toggle = screen.getByRole('button', { name: /lost your phone and your codes/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/no self-service route/i)).not.toBeInTheDocument();
  });

  it('explains the two-person reset (and the operator fallback) when there is no code left at all', async () => {
    await signIn();
    fireEvent.click(screen.getByRole('button', { name: /lost your phone and your codes/i }));

    // The honest answer: not a button on this page — WHO can reset it.
    expect(screen.getByText(/no self-service route/i)).toBeInTheDocument();
    expect(screen.getByText(/owner or admin of your organization to reset/i)).toBeInTheDocument();
    expect(screen.getByText(/platform administrator can reset it/i)).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit trail/i)).toBeInTheDocument();
    expect(screen.getByText(/scripts\/mfa-recover\.js/)).toBeInTheDocument();
  });

  it('folds back up, and is gone once the code step is abandoned', async () => {
    await signIn();
    // Re-queried each time: the framer-motion stub returns a fresh component
    // type per render, so the card remounts and a held node goes stale.
    const toggle = () => screen.getByRole('button', { name: /lost your phone and your codes/i });
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(screen.queryByText(/no self-service route/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /use a different account/i }));
    expect(screen.queryByRole('button', { name: /lost your phone and your codes/i })).not.toBeInTheDocument();
  });
});

describe('past the org’s MFA deadline, with no factor enrolled', () => {
  beforeEach(() => {
    login.mockRejectedValue(Object.assign(
      new Error('Your organization requires two-factor authentication — sign in with a passkey, or enrol an authenticator app'),
      { code: 'MFA_REQUIRED' },
    ));
  });

  it('says who can unblock the account rather than repeating "enrol a factor"', async () => {
    await signIn();

    expect(screen.getByText(/your organization requires two-factor authentication/i)).toBeInTheDocument();
    expect(screen.getByText(/two owners or admins of your organization can reset/i)).toBeInTheDocument();
    expect(screen.getByText(/scripts\/mfa-recover\.js/)).toBeInTheDocument();
  });

  it('points at the passkey button, which does satisfy the requirement', async () => {
    await signIn();

    expect(screen.getByText(/if you already have a passkey on this device/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeInTheDocument();
  });

  it('does not leave the password sitting in the form, and clears on a retype', async () => {
    await signIn();
    expect(screen.getByLabelText('Password')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'grace' } });
    expect(screen.queryByText(/lift the requirement/i)).not.toBeInTheDocument();
  });
});
