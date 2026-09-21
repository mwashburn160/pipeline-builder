// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey sign-in on the landing page.
 *
 * Two things carry the feature: the identifier field declares
 * `autocomplete="username webauthn"` (without it the browser never offers a
 * passkey in its dropdown), and a conditional-UI ceremony is armed on mount — but
 * ONLY where the browser supports it, since `startAuthentication` with autofill
 * throws outright otherwise.
 *
 * Only one WebAuthn request may be in flight per page, so every other sign-in
 * path has to abort the waiting one first; that is asserted here because getting
 * it wrong makes password sign-in fail on exactly the browsers that support
 * passkeys best.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const login = jest.fn<AnyFn>();
const loginWithPasskey = jest.fn<AnyFn>();
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ login, loginWithPasskey, isLoading: false }),
}));
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ query: {}, push: jest.fn<AnyFn>() }),
}));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOAuthProviders: jest.fn<AnyFn>().mockResolvedValue({ data: { providers: [] } }),
    // Domain SSO discovery runs off the identifier field; nothing here is federated.
    discoverSso: jest.fn<AnyFn>().mockResolvedValue({ data: { sso: false } }),
  },
}));
// The marketing sections below the fold animate on scroll, which jsdom has no
// viewport for; the sign-in card is what this suite is about.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> }),
}));

let supportsWebAuthn = true;
let supportsAutofill = true;
const cancelPasskeyCeremony = jest.fn<AnyFn>();
jest.mock('@/lib/passkeys', () => ({
  __esModule: true,
  browserSupportsWebAuthn: () => supportsWebAuthn,
  browserSupportsWebAuthnAutofill: async () => supportsAutofill,
  cancelPasskeyCeremony: (...a: unknown[]) => cancelPasskeyCeremony(...a),
}));

import LandingPage from '../src/components/landing/LandingPage';

// The page's nav reads the colour-scheme media query on mount; jsdom has none.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const renderPage = async () => {
  await act(async () => { render(<LandingPage />); });
};

beforeEach(() => {
  jest.clearAllMocks();
  supportsWebAuthn = true;
  supportsAutofill = true;
  // `login` now resolves with WHAT happened — a session, or a pending second factor.
  login.mockResolvedValue({ status: 'complete' });
  // Autofill waits for the person to pick a credential; it never resolves on its own.
  loginWithPasskey.mockImplementation(() => new Promise(() => undefined));
});

describe('landing page — passkey sign-in', () => {
  it('declares the webauthn autocomplete token on the identifier field', async () => {
    await renderPage();
    expect(screen.getByLabelText('Email or username')).toHaveAttribute('autocomplete', 'username webauthn');
  });

  it('arms the autofill ceremony on mount when the browser supports conditional UI', async () => {
    await renderPage();
    await waitFor(() => expect(loginWithPasskey).toHaveBeenCalledWith({ autofill: true }));
  });

  it('does not arm autofill when the browser lacks conditional UI, but still offers the button', async () => {
    supportsAutofill = false;
    await renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeInTheDocument());
    expect(loginWithPasskey).not.toHaveBeenCalled();
  });

  it('offers no passkey affordance at all without WebAuthn', async () => {
    supportsWebAuthn = false;
    await renderPage();
    expect(screen.queryByRole('button', { name: /sign in with a passkey/i })).not.toBeInTheDocument();
    expect(loginWithPasskey).not.toHaveBeenCalled();
  });

  it('signs in through the explicit button, aborting the waiting autofill request first', async () => {
    await renderPage();
    loginWithPasskey.mockResolvedValue(undefined);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i })); });
    expect(cancelPasskeyCeremony).toHaveBeenCalled();
    expect(loginWithPasskey).toHaveBeenLastCalledWith();
  });

  it('aborts the pending ceremony when a password is submitted', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Email or username'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    cancelPasskeyCeremony.mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^sign in$/i })); });
    expect(cancelPasskeyCeremony).toHaveBeenCalled();
    expect(login).toHaveBeenCalledWith('ada@example.com', 'hunter2');
  });

  it('stays silent when the person dismisses the passkey prompt', async () => {
    await renderPage();
    loginWithPasskey.mockRejectedValue(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i })); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a real passkey failure', async () => {
    await renderPage();
    loginWithPasskey.mockRejectedValue(new Error('Invalid credentials'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i })); });
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });
});
